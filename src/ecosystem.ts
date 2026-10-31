import type { GetDiscovery, ManagerContext } from './types.js';
import { spawn } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { TESTED_PI_VERSION } from './pi-compat.js';

export const TESTED_PI_CLI_VERSION = TESTED_PI_VERSION;
const packageRequest = z
  .object({
    operation: z.enum(['install', 'remove', 'update', 'list']),
    source: z.string().max(1024).optional(),
    scope: z.enum(['global', 'project']).default('global'),
    confirmed: z.literal(true),
  })
  .strict();
const authRequest = z
  .object({ provider: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/), confirmed: z.literal(true) })
  .strict();
const mcpRequest = z.object({ confirmed: z.literal(true) }).strict();
function fail(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status });
}
function inside(root, target) {
  const rel = relative(resolve(root), resolve(target));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
export function redactProcessText(value = '') {
  return String(value)
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._~-]{16,})\b/g, '[REDACTED]')
    .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, '$1[REDACTED]@')
    .replace(/(https?:\/\/[^\s?#]+)\?[^\s#]*/gi, '$1?[REDACTED]')
    .replace(
      /((?:api[_-]?key|secret|token|password|authorization|credential|private[_-]?key|client[_-]?secret|access[_-]?key)\s*[:=]\s*)[^\s,;]+/gi,
      '$1[REDACTED]',
    )
    .slice(0, 32_000);
}
function supportedRuntime(environment) {
  if (!environment?.piBinary)
    throw fail(
      'PI_NOT_FOUND',
      'Pi was not detected; runtime-assisted actions are unavailable.',
      422,
    );
  if (environment.piVersion !== TESTED_PI_CLI_VERSION)
    throw fail(
      'PI_VERSION_UNVERIFIED',
      `Runtime action is supported only for verified Pi ${TESTED_PI_CLI_VERSION}; detected ${environment.piVersion || 'unknown'}.`,
      422,
    );
  return environment.piBinary;
}
async function validateSource(source, context, scope) {
  if (!source || source.startsWith('-') || /[\r\n\0]/.test(source) || source.trim() !== source)
    throw fail('INVALID_PACKAGE_SOURCE', 'Package source must be a single validated source value.');
  if (/\b(?:sk-[A-Za-z0-9_-]{16,}|Bearer\s+\S{16,})\b/i.test(source))
    throw fail(
      'SECRET_BEARING_CONTENT',
      'Package source cannot contain credential-like text.',
      422,
    );
  if (/^npm:(?:@[a-zA-Z0-9._-]+\/)?[a-zA-Z0-9._-]+(?:@[a-zA-Z0-9._-]+)?$/.test(source))
    return source;
  if (/^git:[a-zA-Z0-9._:-]+\/[a-zA-Z0-9._/-]+(?:@[A-Za-z0-9._/-]+)?$/.test(source)) return source;
  if (
    /^git@[\x00-\x7f]{1,500}$/.test(source) &&
    /^git@[A-Za-z0-9.-]+:[A-Za-z0-9._/-]+$/.test(source)
  )
    return source;
  if (/^https:\/\//i.test(source) || /^ssh:\/\//i.test(source)) {
    let url;
    try {
      url = new URL(source);
    } catch {
      throw fail('INVALID_PACKAGE_SOURCE', 'Remote package source is not a valid URL.');
    }
    if (url.username || url.password || url.search || url.hash)
      throw fail(
        'SECRET_BEARING_CONTENT',
        'Package URLs cannot contain credentials, query parameters, or fragments.',
        422,
      );
    return source;
  }
  if (source.startsWith('./') || source.startsWith('../') || isAbsolute(source)) {
    if (scope !== 'project')
      throw fail('INVALID_PACKAGE_SOURCE', 'Local path sources require project scope.');
    const target = resolve(context.cwd, source);
    if (!inside(context.cwd, target))
      throw fail(
        'PATH_OUTSIDE_ALLOWED_ROOT',
        'Local packages must be inside the selected project. Use an npm or git source for external packages.',
        403,
      );
    const targetInfo = await lstat(target).catch(() => null);
    if (!targetInfo?.isDirectory() || targetInfo.isSymbolicLink())
      throw fail(
        'INVALID_PACKAGE_SOURCE',
        'Local package source must be an existing, non-symlink directory.',
      );
    const canonical = await realpath(target).catch(() => null);
    if (!canonical || !inside(await realpath(context.cwd), canonical))
      throw fail(
        'PATH_OUTSIDE_ALLOWED_ROOT',
        'Local package path is unavailable or escapes the selected project.',
        403,
      );
    return canonical;
  }
  throw fail(
    'INVALID_PACKAGE_SOURCE',
    'Supported sources are npm:, git:, https://, ssh://, or a project-local path.',
  );
}
interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(binary: string, args: string[], cwd: string, timeout: number): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(binary, args, {
        cwd,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
        detached: process.platform !== 'win32',
      });
    } catch {
      reject(fail('PI_ACTION_FAILED', 'Pi could not be started safely.', 500));
      return;
    }
    const stdout = [],
      stderr = [];
    let size = 0,
      timedOut = false,
      overflow = false;
    const killTree = () => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {}
    };
    const collect = (target, chunk) => {
      size += chunk.length;
      if (size > 512 * 1024) {
        overflow = true;
        killTree();
        return;
      }
      target.push(chunk);
    };
    child.stdout.on('data', (chunk) => collect(stdout, chunk));
    child.stderr.on('data', (chunk) => collect(stderr, chunk));
    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, timeout);
    child.once('error', () => {
      clearTimeout(timer);
      reject(fail('PI_ACTION_FAILED', 'Pi could not be started safely.', 500));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(fail('ACTION_TIMEOUT', 'Pi command exceeded its safety timeout.', 504));
        return;
      }
      if (overflow) {
        reject(
          fail(
            'ACTION_OUTPUT_LIMIT',
            'Pi command output exceeded the safety limit and was withheld.',
            413,
          ),
        );
        return;
      }
      resolve({
        code: Number.isInteger(code) ? code : 1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}
function summarizeProcess(result: ProcessResult) {
  return {
    exitCode: result.code,
    stdout: redactProcessText(result.stdout),
    stderr: redactProcessText(result.stderr),
  };
}

export function createEcosystemService({
  getDiscovery,
  context,
  readOnly = false,
}: {
  getDiscovery: GetDiscovery;
  context: ManagerContext;
  readOnly?: boolean;
}) {
  let packageActionPending = false;
  async function environment() {
    const discovery = await getDiscovery();
    return { ...discovery.getEnvironment(), cwd: context.cwd, mode: context.mode };
  }
  return {
    async packageAction(payload) {
      if (readOnly) throw fail('READ_ONLY', 'This Pinotator instance is read-only.', 403);
      const request = packageRequest.parse(payload);
      const env = await environment();
      const binary = supportedRuntime(env);
      if (request.operation === 'list' && request.source !== undefined)
        throw fail('INVALID_PACKAGE_SOURCE', 'List does not accept a package source.');
      if (request.operation === 'update' && request.scope === 'project')
        throw fail(
          'UNSUPPORTED_SCOPED_UPDATE',
          'Pi 1.4.0 documents no project-scoped update flag; choose global update or use Pi directly after reviewing its target selection.',
          422,
        );
      if (request.operation !== 'list')
        request.source = await validateSource(request.source, context, request.scope);
      const args: string[] = [request.operation];
      if (request.source) args.push(request.source);
      if (request.scope === 'project' && ['install', 'remove'].includes(request.operation))
        args.push('--local');
      if (
        request.scope === 'project' ||
        (request.operation === 'list' && context.mode !== 'global')
      )
        args.push('--no-approve');
      const warning =
        'Pi package operations may download third-party code and run package-manager lifecycle scripts. No --approve flag is supplied; project trust is never granted by Pinotator.';
      if (packageActionPending)
        throw fail(
          'PACKAGE_ACTION_PENDING',
          'Another Pi package command is still running. Wait for it to finish.',
          409,
        );
      packageActionPending = true;
      try {
        const result = await run(
          binary,
          args,
          request.scope === 'global' && request.operation !== 'list' ? context.home : context.cwd,
          request.operation === 'list' ? 10_000 : 120_000,
        );
        return {
          operation: request.operation,
          scope: request.scope,
          source: request.source,
          command: ['pi', ...args].join(' '),
          warning,
          ...summarizeProcess(result),
        };
      } finally {
        packageActionPending = false;
      }
    },
    async checkAuthorization(payload) {
      const request = authRequest.parse(payload);
      const env = await environment();
      const binary = supportedRuntime(env);
      const result = await run(
        binary,
        ['auth', 'check', '--provider', request.provider, '--json', '--no-refresh'],
        context.cwd,
        5_000,
      );
      let parsed;
      try {
        parsed = JSON.parse(result.stdout);
      } catch {
        return {
          provider: request.provider,
          status: 'unknown',
          detail:
            'Installed Pi returned an unrecognized authorization-check response; no output was forwarded.',
        };
      }
      const status = ['ready', 'not_ready', 'invalid'].includes(parsed?.status)
        ? parsed.status
        : 'unknown';
      const reason =
        typeof parsed?.reason === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(parsed.reason)
          ? parsed.reason
          : undefined;
      return {
        provider: request.provider,
        status,
        reason,
        detail:
          'Pi auth check was explicitly requested with --no-refresh; this does not prove inference, quota, or provider availability.',
      };
    },
    async checkMcp(payload) {
      mcpRequest.parse(payload);
      const env = await environment();
      const binary = supportedRuntime(env);
      const result = await run(binary, ['mcp', 'list', '--json'], context.cwd, 15_000);
      let parsed;
      try {
        parsed = JSON.parse(result.stdout);
      } catch {
        return {
          status: 'unknown',
          exitCode: result.code,
          detail:
            'Pi returned an unrecognized MCP status response. Raw process output was withheld.',
        };
      }
      const records = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.servers)
          ? parsed.servers
          : null;
      if (!records)
        return {
          status: 'unknown',
          exitCode: result.code,
          detail:
            'Pi returned an unrecognized MCP status response. Raw process output was withheld.',
        };
      return {
        status: result.code === 0 ? 'checked' : 'attention',
        exitCode: result.code,
        servers: records.slice(0, 100).map((item) => ({
          name: redactProcessText(String(item.name || item.server || 'unknown')).slice(0, 100),
          state: [
            'connected',
            'disconnected',
            'disabled',
            'error',
            'needs_auth',
            'unknown',
          ].includes(item.state || item.status)
            ? item.state || item.status
            : 'unknown',
          tools: Array.isArray(item.tools)
            ? item.tools
                .map((tool) =>
                  redactProcessText(
                    String(typeof tool === 'string' ? tool : tool.name || ''),
                  ).slice(0, 120),
                )
                .filter(Boolean)
                .slice(0, 100)
            : [],
          error: item.error ? redactProcessText(item.error).slice(0, 1000) : undefined,
        })),
        detail:
          'Explicit Pi MCP status check. This may start every enabled MCP server; no server is started during passive inventory.',
      };
    },
  };
}
