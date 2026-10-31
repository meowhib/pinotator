import type { GetDiscovery, ManagerContext } from './types.js';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const openSchema = z
  .object({
    path: z.string().trim().min(1).max(2048),
    remember: z.boolean().default(false),
    confirmed: z.literal(true),
  })
  .strict();
const cloneSchema = z
  .object({
    resourceIds: z.array(z.string().uuid()).min(1).max(50),
    targetScope: z.enum(['project', 'portable-project']),
    confirmed: z.literal(true),
  })
  .strict();
function fail(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status });
}
function inside(root, target) {
  const rel = relative(resolve(root), resolve(target));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function createChildLauncher({ readOnly }) {
  const children = new Set<ChildProcess>();
  const entrypoint = fileURLToPath(
    new URL(
      import.meta.url.endsWith('.ts') ? '../dist/bin/pinotator.js' : '../bin/pinotator.js',
      import.meta.url,
    ),
  );
  return {
    children,
    async launch(cwd) {
      const args = [entrypoint, '--project', cwd, '--no-open'];
      if (readOnly) args.push('--read-only');
      return new Promise<string>((resolvePromise, rejectPromise) => {
        const child = spawn(process.execPath, args, {
          cwd,
          env: process.env,
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        children.add(child);
        let output = '';
        let settled = false;
        const finish = (error: Error | null, url?: string) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (error) rejectPromise(error);
          else resolvePromise(url);
        };
        const inspect = () => {
          const match = /Local URL:\s+(http:\/\/127\.0\.0\.1:\d+\/\?access=[A-Za-z0-9_-]+)/.exec(
            output,
          );
          if (match) finish(null, match[1]);
        };
        child.stdout.on('data', (chunk) => {
          output = (output + chunk.toString()).slice(-8192);
          inspect();
        });
        child.once('error', (error) => finish(error));
        child.once('exit', (code) => {
          children.delete(child);
          if (!settled)
            finish(
              fail(
                'WORKSPACE_LAUNCH_FAILED',
                `Separate workspace failed to start (exit ${code}).`,
                503,
              ),
            );
        });
        const timer = setTimeout(() => {
          finish(
            fail(
              'WORKSPACE_LAUNCH_TIMEOUT',
              'Separate workspace did not become ready in time.',
              503,
            ),
          );
          child.kill('SIGTERM');
        }, 15000);
        timer.unref?.();
      });
    },
    async close() {
      for (const child of children) child.kill('SIGTERM');
      await Promise.all(
        [...children].map(
          (child) =>
            new Promise((resolvePromise) => {
              if (child.exitCode !== null) {
                resolvePromise(undefined);
                return;
              }
              child.once('exit', () => resolvePromise(undefined));
              setTimeout(() => {
                child.kill('SIGKILL');
                resolvePromise(undefined);
              }, 3000).unref?.();
            }),
        ),
      );
      children.clear();
    },
  };
}

export function createWorkspaceService(options: {
  getDiscovery: GetDiscovery;
  context: ManagerContext;
  propose: (payload: any) => Promise<any>;
  stateDirectory?: string;
  readOnly?: boolean;
  launchProject?: (cwd: string) => Promise<string>;
}) {
  const { getDiscovery, context, propose, readOnly = false } = options;
  const stateRoot = resolve(
    options.stateDirectory ||
      join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'pinotator'),
  );
  const recentPath = join(stateRoot, 'recent-workspaces.json');
  const childLauncher = options.launchProject ? null : createChildLauncher({ readOnly });
  let queue = Promise.resolve();
  const serialize = (operation) => {
    const result = queue.then(operation, operation);
    queue = result.catch(() => {});
    return result;
  };
  async function ensureState() {
    await mkdir(stateRoot, { recursive: true, mode: 0o700 });
    const info = await lstat(stateRoot);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (typeof process.getuid === 'function' && info.uid !== process.getuid()) ||
      (info.mode & 0o077) !== 0
    )
      throw fail(
        'WORKSPACE_STORE_UNSAFE',
        'Private recent-workspace storage is unavailable or unsafe.',
        403,
      );
  }
  async function readRecent() {
    await ensureState();
    const info = await lstat(recentPath).catch(() => null);
    if (!info) return [];
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size > 128 * 1024 ||
      (typeof process.getuid === 'function' && info.uid !== process.getuid()) ||
      (info.mode & 0o077) !== 0
    )
      throw fail(
        'WORKSPACE_STORE_UNSAFE',
        'Recent workspace data is not a private regular file.',
        403,
      );
    try {
      const data = JSON.parse(await readFile(recentPath, 'utf8'));
      if (!Array.isArray(data)) return [];
      return data
        .filter(
          (item) =>
            item &&
            typeof item.path === 'string' &&
            isAbsolute(item.path) &&
            typeof item.lastOpened === 'string',
        )
        .slice(0, 20);
    } catch {
      return [];
    }
  }
  async function writeRecent(items) {
    await ensureState();
    const temp = `${recentPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, JSON.stringify(items.slice(0, 20)), { flag: 'wx', mode: 0o600 });
      await rename(temp, recentPath);
    } catch (error) {
      await unlink(temp).catch(() => {});
      throw error;
    }
  }
  async function cloneOne(resource, discovery, targetScope) {
    const sourceId = resource.source?.fileId;
    const file = sourceId && discovery.getFileForMutation(sourceId);
    if (
      !file ||
      !['global', 'portable'].includes(file.entry.scope) ||
      !file.allowContent ||
      file.entry.packageName ||
      !file.entry.editable
    )
      throw fail(
        'GLOBAL_COPY_UNSUPPORTED',
        `Global resource “${resource.name}” is not a safe, copyable source.`,
        403,
      );
    const content = file.raw;
    const makeCreate = (kind, basenameValue, text, scope = targetScope) => ({
      intent: 'create',
      createTarget: { scope, kind, basename: basenameValue },
      content: text,
    });
    if (resource.kind === 'skill' && file.entry.kind === 'skill') {
      const skillName = basename(dirname(file.path));
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skillName))
        throw fail(
          'GLOBAL_COPY_UNSUPPORTED',
          'Skill folder name is not portable and safe to clone.',
          422,
        );
      const related = discovery
        .getFiles()
        .filter(
          (candidate) => candidate.kind === 'skill-asset' && candidate.skillManifestId === sourceId,
        );
      const sources = [
        file,
        ...related.map((candidate) => discovery.getFileForMutation(candidate.id)),
      ];
      return sources.map((source) => {
        if (!source?.allowContent)
          throw fail(
            'GLOBAL_COPY_BINARY',
            `Skill “${resource.name}” contains unsupported binary content.`,
            422,
          );
        const skillRoot = dirname(file.path);
        const path = relative(skillRoot, source.path).split(sep).join('/');
        if (!path || path.startsWith('../'))
          throw fail('PATH_OUTSIDE_ALLOWED_ROOT', 'Skill asset escaped its source directory.', 403);
        return makeCreate('skill-import-file', `${skillName}/${path}`, source.raw, targetScope);
      });
    }
    if (targetScope !== 'project')
      throw fail(
        'INVALID_TARGET',
        'Portable-project scope is only valid for portable skill copies.',
      );
    if (resource.kind === 'agent' && file.entry.kind === 'agent')
      return [makeCreate('agent', basename(file.path).replace(/\.md$/i, ''), content)];
    if (
      resource.kind === 'command' &&
      resource.commandType === 'prompt-template' &&
      file.entry.kind === 'command'
    )
      return [makeCreate('command', basename(file.path).replace(/\.md$/i, ''), content)];
    if (
      resource.kind === 'instruction' &&
      ['instruction', 'system-prompt', 'append-system'].includes(file.entry.kind)
    ) {
      const kind = file.entry.kind === 'instruction' ? 'instruction' : file.entry.kind;
      return [makeCreate(kind, basename(file.path), content)];
    }
    throw fail(
      'GLOBAL_COPY_UNSUPPORTED',
      `Resource “${resource.name}” is not supported by safe global-to-project copy.`,
      422,
    );
  }
  return {
    async recent() {
      return (await readRecent()).map((item) => ({ path: item.path, lastOpened: item.lastOpened }));
    },
    async open(payload) {
      return serialize(async () => {
        if (readOnly) throw fail('READ_ONLY', 'This Pinotator instance is read-only.', 403);
        const request = openSchema.parse(payload);
        if (!isAbsolute(request.path) || /[\u0000-\u001f]/.test(request.path))
          throw fail(
            'INVALID_PROJECT_PATH',
            'Project path must be absolute and contain no control characters.',
          );
        let path;
        try {
          const info = await lstat(request.path);
          if (!info.isDirectory() || info.isSymbolicLink())
            throw new Error('not a regular directory');
          path = await realpath(request.path);
        } catch {
          throw fail(
            'INVALID_PROJECT_PATH',
            'Choose an accessible, non-symlink project directory.',
            422,
          );
        }
        const url = options.launchProject
          ? await options.launchProject(path)
          : await childLauncher.launch(path);
        if (!/^http:\/\/127\.0\.0\.1:\d+\/\?access=[A-Za-z0-9_-]{32,}$/.test(url))
          throw fail(
            'WORKSPACE_LAUNCH_FAILED',
            'Separate workspace returned an invalid local bootstrap URL.',
            503,
          );
        if (request.remember) {
          const recent = await readRecent();
          const next = [
            { path, lastOpened: new Date().toISOString() },
            ...recent.filter((item) => item.path !== path),
          ];
          await writeRecent(next);
        }
        return { path, url, remembered: request.remember };
      });
    },
    async cloneGlobal(payload) {
      if (readOnly) throw fail('READ_ONLY', 'This Pinotator instance is read-only.', 403);
      const request = cloneSchema.parse(payload);
      const discovery = await getDiscovery();
      const ids = [...new Set(request.resourceIds)];
      const edits = [];
      for (const id of ids) {
        const resource = discovery.getResource(id);
        if (!resource)
          throw fail(
            'RESOURCE_NOT_FOUND',
            'A selected global resource is no longer available.',
            404,
          );
        edits.push(...(await cloneOne(resource, discovery, request.targetScope)));
      }
      if (!edits.length || edits.length > 50)
        throw fail('CLONE_LIMIT', 'Global copy must contain between 1 and 50 files.', 413);
      const destinations = new Set();
      const projectResources = discovery
        .getResources()
        .filter((item) => item.source?.scope === 'project');
      for (const edit of edits) {
        const name = edit.createTarget.basename.split('/').at(-1).replace(/\.md$/i, '');
        if (
          edit.createTarget.kind === 'agent' &&
          projectResources.some((item) => item.kind === 'agent' && item.name === name)
        )
          throw fail(
            'AGENT_NAME_CONFLICT',
            `Project already contains agent “${name}”; select a different override strategy.`,
            409,
          );
        const target = `${edit.createTarget.scope}:${edit.createTarget.kind}:${edit.createTarget.basename}`;
        if (destinations.has(target))
          throw fail(
            'DUPLICATE_TARGET',
            'Two selected resources resolve to the same project destination.',
            409,
          );
        destinations.add(target);
      }
      return propose({ edits });
    },
    async close() {
      if (childLauncher) await childLauncher.close();
    },
  };
}
