import {
  createServer,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from 'node:http';
import type { Discovery, ManagerContext } from './types.js';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createDiscovery } from './discovery.js';
import { createMutationService } from './mutations.js';
import { createEcosystemService } from './ecosystem.js';
import { createSkillTransferService } from './skill-transfer.js';
import { createSnapshotService } from './snapshots.js';
import { createPresetService } from './presets.js';
import { createEffectiveRuntimeService } from './effective-runtime.js';
import { createPromptPlaygroundService } from './prompt-playground.js';
import { createProfileService } from './profiles.js';
import { createWorkspaceService } from './workspaces.js';
import { createAnalysisService } from './analysis.js';
import { createCompanionService } from './companion.js';
import { createMigrationService } from './migrations.js';
import { createTemplateService } from './templates.js';
import { TESTED_PI_VERSION } from './pi-compat.js';
import { createModelCatalogService } from './model-catalog.js';
import { createProviderCredentialsService } from './provider-credentials.js';
import chokidar from 'chokidar';

const publicDir = fileURLToPath(
  new URL(import.meta.url.endsWith('.ts') ? '../dist/public/' : '../public/', import.meta.url),
);
const COOKIE = 'pinotator_cap';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const equalSecret = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aa = Buffer.from(a),
    bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
};

function hostAllowed(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const match = /^(\[[0-9a-f:]+\]|[^:]+)(?::\d{1,5})?$/i.exec(hostHeader);
  return Boolean(match && LOOPBACK_HOSTS.has(match[1].toLowerCase()));
}
function cookies(header = '') {
  return Object.fromEntries(
    header
      .split(';')
      .map((part) => {
        const i = part.indexOf('=');
        if (i < 0) return ['', ''];
        try {
          return [part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim())];
        } catch {
          return ['', ''];
        }
      })
      .filter(([key]) => key),
  );
}
function send(
  res: ServerResponse,
  status: number,
  body: string | Buffer,
  headers: OutgoingHttpHeaders = {},
) {
  res.writeHead(status, {
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    ...headers,
  });
  res.end(body);
}
async function readJsonRequest(req: IncomingMessage, maximum: number): Promise<unknown> {
  const contentType = String(req.headers['content-type'] || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (contentType !== 'application/json')
    throw Object.assign(new Error('Content-Type must be application/json.'), {
      code: 'UNSUPPORTED_MEDIA_TYPE',
      status: 415,
    });
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > maximum)
    throw Object.assign(new Error('Request body is too large.'), {
      code: 'BODY_TOO_LARGE',
      status: 413,
    });
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maximum)
      throw Object.assign(new Error('Request body is too large.'), {
        code: 'BODY_TOO_LARGE',
        status: 413,
      });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Request body must be valid JSON.'), {
      code: 'INVALID_JSON',
      status: 400,
    });
  }
}

export function createManagerServer({
  context = {},
  port = 0,
  discoveryService,
  launchWorkspace,
}: {
  context?: Partial<ManagerContext>;
  port?: number;
  discoveryService?: Discovery;
  launchWorkspace?: (cwd: string) => Promise<string>;
} = {}) {
  const appContext: ManagerContext = {
    cwd: resolve(context.cwd || process.cwd()),
    home: resolve(context.home || homedir()),
    agentDirectory: resolve(
      context.agentDirectory || process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent'),
    ),
    mode: context.mode || 'project',
    readOnly: Boolean(context.readOnly),
  };
  let discovery: Promise<Discovery> = discoveryService
    ? Promise.resolve(discoveryService)
    : createDiscovery(appContext);
  let watcher: ReturnType<typeof chokidar.watch>;
  let debounceTimer: ReturnType<typeof setTimeout>;
  let generation = 1;
  const capability = randomBytes(32).toString('base64url');
  let bootstrapAvailable = true;
  const listeners = new Set<ServerResponse>();
  const publishEvent = (event, data = {}) => {
    const safe = JSON.stringify(data).replace(/[\r\n]/g, '');
    for (const res of listeners) {
      try {
        res.write(`event: ${event}\ndata: ${safe}\n\n`);
      } catch {}
    }
  };
  const refreshInventory = async () => {
    const refreshed = await createDiscovery(appContext);
    discovery = Promise.resolve(refreshed);
    generation++;
    const targets = await refreshed.getWatchTargets();
    watcher?.add(targets);
    publishEvent('source_changed', { generation });
    return refreshed;
  };
  const mutations = createMutationService({
    context: appContext,
    getDiscovery: () => discovery,
    refreshDiscovery: refreshInventory,
    publish: (event, data) => {
      generation++;
      publishEvent(event, { ...data, generation });
    },
    readOnly: appContext.readOnly,
    stateDirectory: context.stateDirectory,
  });
  const modelCatalog = createModelCatalogService({ getDiscovery: () => discovery });
  const providerCredentials = createProviderCredentialsService({
    getDiscovery: () => discovery,
    catalogService: modelCatalog,
  });
  const ecosystem = createEcosystemService({
    getDiscovery: () => discovery,
    context: appContext,
    readOnly: appContext.readOnly,
  });
  const skillTransfer = createSkillTransferService({
    getDiscovery: () => discovery,
    context: appContext,
    propose: (payload) => mutations.propose(payload),
  });
  const snapshots = createSnapshotService({
    getDiscovery: () => discovery,
    context: appContext,
    stateDirectory: context.stateDirectory,
  });
  const migrations = createMigrationService({
    getDiscovery: () => discovery,
    snapshots,
  });
  const presets = createPresetService({
    getDiscovery: () => discovery,
    propose: (payload) => mutations.propose(payload),
  });
  const effectiveRuntime = createEffectiveRuntimeService({ getDiscovery: () => discovery });
  const analysis = createAnalysisService({
    getDiscovery: () => discovery,
    getRuntimeModels: () => effectiveRuntime.getLastModels(),
  });
  const promptPlayground = createPromptPlaygroundService({ getDiscovery: () => discovery });
  const companion = createCompanionService();
  const templates = createTemplateService({ propose: (payload) => mutations.propose(payload) });
  const profiles = createProfileService({
    presetService: presets,
    stateDirectory: context.stateDirectory,
  });
  const workspaces = createWorkspaceService({
    getDiscovery: () => discovery,
    context: appContext,
    propose: (payload) => mutations.propose(payload),
    stateDirectory: context.stateDirectory,
    readOnly: appContext.readOnly,
    launchProject: launchWorkspace,
  });
  const server = createServer(async (req, res) => {
    try {
      const host = req.headers.host;
      if (!hostAllowed(host)) return send(res, 421, 'Misdirected request');
      const hostName = host
        .replace(/^\[|\]$/g, '')
        .split(':')[0]
        .toLowerCase();
      const isLoopback = LOOPBACK_HOSTS.has(hostName) || host.startsWith('[::1]');
      if (!isLoopback) return send(res, 421, 'Loopback only');
      const url = new URL(req.url || '/', `http://${host}`);
      const origin = req.headers.origin;
      if (origin) {
        let parsed;
        try {
          parsed = new URL(origin);
        } catch {
          return send(res, 403, 'Invalid origin');
        }
        if (parsed.host !== host || parsed.protocol !== 'http:' || !hostAllowed(parsed.host))
          return send(res, 403, 'Origin rejected');
      }
      const method = req.method || 'GET';
      const companionRoute = new Set([
        '/api/companion/claim',
        '/api/companion/update',
        '/api/companion/close',
        '/api/companion/pending',
        '/api/companion/complete',
      ]);
      if (method === 'POST' && companionRoute.has(url.pathname)) {
        try {
          const body = await readJsonRequest(req, 32 * 1024);
          const candidate = /^Bearer ([A-Za-z0-9_-]{32,100})$/.exec(
            String(req.headers.authorization || ''),
          )?.[1];
          const result =
            url.pathname === '/api/companion/claim'
              ? companion.claim(candidate, body, req.socket.remoteAddress || 'unknown')
              : url.pathname === '/api/companion/update'
                ? companion.update(candidate, body)
                : url.pathname === '/api/companion/close'
                  ? companion.close(candidate)
                  : url.pathname === '/api/companion/pending'
                    ? companion.pending(candidate)
                    : companion.completeReload(candidate, body);
          return send(res, 200, JSON.stringify(result), {
            'Content-Type': 'application/json; charset=utf-8',
          });
        } catch (error) {
          const status = error.status || 400;
          return send(
            res,
            status,
            JSON.stringify({
              error: error.code || 'COMPANION_REQUEST_FAILED',
              message: status >= 500 ? 'Companion request failed safely.' : error.message,
            }),
            {
              'Content-Type': 'application/json; charset=utf-8',
            },
          );
        }
      }
      const cookieToken = cookies(req.headers.cookie)[COOKIE];
      const bootstrap =
        method === 'GET' &&
        url.pathname === '/' &&
        bootstrapAvailable &&
        equalSecret(url.searchParams.get('access'), capability);
      if (bootstrap) {
        bootstrapAvailable = false;
        res.writeHead(303, {
          'Set-Cookie': `${COOKIE}=${capability}; HttpOnly; SameSite=Strict; Path=/`,
          Location: '/',
          'Cache-Control': 'private, no-store',
          'Referrer-Policy': 'no-referrer',
        });
        return res.end();
      }
      if (!equalSecret(cookieToken, capability)) return send(res, 401, 'Unauthorized');
      const isRefreshRequest = method === 'POST' && url.pathname === '/api/refresh';
      if (method !== 'GET' && method !== 'HEAD') {
        if (
          appContext.readOnly &&
          !isRefreshRequest &&
          !['/api/prompts/expand', '/api/analysis/estimate', '/api/companion/pair'].includes(
            url.pathname,
          )
        )
          return send(res, 403, 'Read-only mode');
        if (!origin || origin !== `http://${host}` || !req.headers['x-pinotator-csrf'])
          return send(res, 403, 'Mutation requires same-origin CSRF proof');
      }
      if (isRefreshRequest) {
        try {
          const refreshed = await refreshInventory();
          return send(res, 200, JSON.stringify(refreshed.getOverview()), {
            'Content-Type': 'application/json; charset=utf-8',
          });
        } catch {
          return send(res, 503, 'Inventory refresh failed');
        }
      }
      if (method === 'GET' || method === 'HEAD') {
        const app = await discovery;
        const kind = url.searchParams.get('kind') || undefined;
        let payload;
        if (url.pathname === '/api/environment') {
          const environment = app.getEnvironment();
          payload = {
            ...environment,
            capabilities: {
              ...environment.capabilities,
              mutation: !appContext.readOnly,
              runtimeAssisted:
                environment.piVersion === TESTED_PI_VERSION ? 'version-verified' : 'unknown',
              runtimeInspection:
                environment.piVersion === TESTED_PI_VERSION ? 'available-on-consent' : 'unknown',
              testedPiVersion: TESTED_PI_VERSION,
            },
          };
        } else if (url.pathname === '/api/models/catalog')
          payload = await providerCredentials.catalog();
        else if (url.pathname === '/api/overview') payload = app.getOverview();
        else if (url.pathname === '/api/resources') payload = app.getResources(kind);
        else if (url.pathname === '/api/files') payload = app.getFiles();
        else if (url.pathname === '/api/diagnostics') payload = app.getDiagnostics();
        else if (url.pathname === '/api/instructions') payload = app.getInstructionSources();
        else if (url.pathname === '/api/instructions/preview')
          payload = app.getEffectiveInstructions();
        else if (url.pathname === '/api/resource')
          payload = app.getResource(url.searchParams.get('id'));
        else if (url.pathname === '/api/source')
          payload = app.getSource(url.searchParams.get('id'));
        else if (url.pathname === '/api/agent-editor')
          payload = app.getAgentEditor(url.searchParams.get('id'));
        else if (url.pathname === '/api/changes') payload = await mutations.list();
        else if (url.pathname === '/api/profiles') payload = await profiles.list();
        else if (url.pathname === '/api/workspaces/recent') payload = await workspaces.recent();
        else if (url.pathname === '/api/analysis/graph') payload = await analysis.graph();
        else if (url.pathname === '/api/companion/sessions') payload = companion.list();
        else if (url.pathname === '/api/migrations') payload = await migrations.report();
        else if (url.pathname === '/api/templates') payload = templates.list();
        else if (url.pathname === '/api/change')
          payload = await mutations.get(url.searchParams.get('id'));
        else if (url.pathname === '/api/recovery') payload = await mutations.recovery();
        else if (url.pathname === '/api/snapshots') payload = await snapshots.list();
        else if (url.pathname === '/api/snapshot')
          payload = url.searchParams.get('id')
            ? await snapshots.get(url.searchParams.get('id'))
            : null;
        else if (url.pathname === '/api/snapshot/export')
          payload = url.searchParams.get('id')
            ? await snapshots.exportSnapshot(url.searchParams.get('id'))
            : null;
        else payload = undefined;
        if (payload !== undefined)
          return payload === null
            ? send(res, 404, 'Not found')
            : send(res, 200, JSON.stringify(payload), {
                'Content-Type': 'application/json; charset=utf-8',
              });
      }
      if (url.pathname === '/api/events' && method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'private, no-store',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.write(`event: ready\ndata: ${JSON.stringify({ generation })}\n\n`);
        listeners.add(res);
        req.on('close', () => listeners.delete(res));
        return;
      }
      if (
        method === 'POST' &&
        (url.pathname.startsWith('/api/changes/') ||
          [
            '/api/providers/api-key',
            '/api/packages/action',
            '/api/runtime/auth-check',
            '/api/runtime/mcp-check',
            '/api/runtime/effective-inspect',
            '/api/runtime/model-test',
            '/api/prompts/expand',
            '/api/skills/import/inspect',
            '/api/skills/import/propose',
            '/api/skills/export',
            '/api/snapshots/create',
            '/api/snapshots/compare',
            '/api/snapshots/import',
            '/api/presets/export',
            '/api/presets/stage',
            '/api/profiles/save',
            '/api/profiles/stage',
            '/api/profiles/delete',
            '/api/workspaces/open',
            '/api/workspaces/clone-global',
            '/api/analysis/estimate',
            '/api/companion/pair',
            '/api/companion/reload-request',
            '/api/templates/stage',
          ].includes(url.pathname))
      ) {
        const handlers = {
          '/api/providers/api-key': (value) => providerCredentials.save(value),
          '/api/changes/propose': (value) => mutations.propose(value),
          '/api/changes/validate': (value) => mutations.validate(value),
          '/api/changes/apply': (value) => mutations.apply(value),
          '/api/changes/discard': (value) => mutations.discard(value),
          '/api/changes/rollback': (value) => mutations.rollback(value),
          '/api/changes/recover': (value) => mutations.recover(value),
          '/api/packages/action': async (value) => {
            const result = await ecosystem.packageAction(value);
            if (['install', 'remove', 'update'].includes(result.operation) && result.exitCode === 0)
              await refreshInventory().catch(() => {});
            return result;
          },
          '/api/runtime/auth-check': (value) => ecosystem.checkAuthorization(value),
          '/api/runtime/mcp-check': (value) => ecosystem.checkMcp(value),
          '/api/runtime/effective-inspect': (value) => effectiveRuntime.inspect(value),
          '/api/runtime/model-test': (value) => effectiveRuntime.testGeneration(value),
          '/api/prompts/expand': (value) => promptPlayground.expand(value),
          '/api/skills/import/inspect': (value) => skillTransfer.inspectImport(value),
          '/api/skills/import/propose': (value) => skillTransfer.proposeImport(value),
          '/api/skills/export': (value) => skillTransfer.exportSkill(value),
          '/api/snapshots/create': (value) => snapshots.create(value),
          '/api/snapshots/compare': (value) => snapshots.compare(value),
          '/api/snapshots/import': (value) => snapshots.importSnapshot(value),
          '/api/presets/export': (value) => presets.exportPreset(value),
          '/api/presets/stage': (value) => presets.stagePreset(value),
          '/api/profiles/save': (value) => profiles.save(value),
          '/api/profiles/stage': (value) => profiles.stage(value),
          '/api/profiles/delete': (value) => profiles.delete(value),
          '/api/workspaces/open': (value) => workspaces.open(value),
          '/api/workspaces/clone-global': (value) => workspaces.cloneGlobal(value),
          '/api/analysis/estimate': (value) => analysis.estimate(value),
          '/api/companion/pair': () => companion.createPairing(),
          '/api/companion/reload-request': (value) => companion.requestReload(value),
          '/api/templates/stage': (value) => templates.stage(value),
        };
        const handler = handlers[url.pathname];
        if (!handler) return send(res, 404, 'Not found');
        try {
          const bodyLimit =
            url.pathname === '/api/providers/api-key'
              ? 16 * 1024
              : ['/api/skills/import/inspect', '/api/snapshots/import'].includes(url.pathname)
                ? 9 * 1024 * 1024
                : 6 * 1024 * 1024;
          const body = await readJsonRequest(req, bodyLimit);
          const result = await handler(body);
          return send(res, 200, JSON.stringify(result), {
            'Content-Type': 'application/json; charset=utf-8',
          });
        } catch (error) {
          const status =
            error.status || (error.name === 'ZodError' || error instanceof SyntaxError ? 400 : 500);
          const response = {
            error: error.code || (status === 400 ? 'INVALID_REQUEST' : 'REQUEST_FAILED'),
            message:
              url.pathname === '/api/providers/api-key' &&
              ![
                'INVALID_CREDENTIAL_REQUEST',
                'INVALID_API_KEY',
                'READ_ONLY',
                'API_KEY_UNSUPPORTED',
                'INVALID_PROVIDER_CONFIGURATION',
                'UNSAFE_AUTH_PATH',
                'UNSAFE_AUTH_STORE',
                'CREDENTIAL_EXISTS',
                'CREDENTIAL_SAVE_FAILED',
                'UNSUPPORTED_PI_VERSION',
              ].includes(error.code)
                ? 'The API-key request failed safely. No credential values were returned.'
                : status >= 500
                  ? 'Request failed safely.'
                  : error.message,
            details:
              url.pathname === '/api/providers/api-key' ? undefined : error.details || undefined,
          };
          return send(res, status, JSON.stringify(response), {
            'Content-Type': 'application/json; charset=utf-8',
          });
        }
      }
      if (url.pathname.startsWith('/api/'))
        return send(res, method === 'GET' || method === 'HEAD' ? 404 : 405, 'Not implemented');
      if (method !== 'GET' && method !== 'HEAD')
        return send(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
      const asset = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (!/^[a-zA-Z0-9._/-]+$/.test(asset) || asset.split('/').includes('..'))
        return send(res, 404, 'Not found');
      try {
        const content = await readFile(join(publicDir, asset));
        const contentType = asset.endsWith('.html')
          ? 'text/html; charset=utf-8'
          : asset.endsWith('.css')
            ? 'text/css; charset=utf-8'
            : asset.endsWith('.js')
              ? 'text/javascript; charset=utf-8'
              : 'application/octet-stream';
        return send(res, 200, method === 'HEAD' ? '' : content, { 'Content-Type': contentType });
      } catch {
        const route = url.pathname;
        const appRoute =
          route === '/' ||
          /^\/(instructions|diagnostics|sources|changes|agents|skills|commands|models|providers|extensions|mcp|settings|keybindings|effective|analysis|companion|migration|templates|snapshots)(\/[a-f0-9-]+)?\/?$/i.test(
            route,
          );
        if (!appRoute) return send(res, 404, 'Not found');
        const content = await readFile(join(publicDir, 'index.html'));
        return send(res, 200, method === 'HEAD' ? '' : content, {
          'Content-Type': 'text/html; charset=utf-8',
        });
      }
    } catch {
      if (!res.headersSent) send(res, 500, 'Request failed safely');
      else res.destroy();
    }
  });
  return {
    server,
    capability,
    get bootstrapUrl() {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Server is not listening');
      return `http://127.0.0.1:${address.port}/?access=${capability}`;
    },
    async listen() {
      await mutations.ready;
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen({ host: '127.0.0.1', port }, () => resolve(undefined));
      });
      try {
        const app = await discovery;
        const targets = await app.getWatchTargets();
        if (targets.length) {
          watcher = chokidar.watch(targets, {
            ignoreInitial: true,
            awaitWriteFinish: { stabilityThreshold: 180, pollInterval: 50 },
            ignored: (path) => /\.(?:swp|tmp|temp)$/i.test(path) || /~$/.test(path),
          });
          watcher.on('all', (event) => {
            if (!['add', 'change', 'unlink', 'addDir', 'unlinkDir'].includes(event)) return;
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(async () => {
              try {
                await refreshInventory();
              } catch {
                publishEvent('refresh_failed', { generation });
              }
            }, 200);
          });
        }
      } catch {
        /* The server remains available for manual refresh and doctor diagnostics. */
      }
    },
    publish(event, data = {}) {
      publishEvent(event, data);
    },
    async close() {
      clearTimeout(debounceTimer);
      await workspaces.close();
      await watcher?.close();
      for (const res of listeners) res.end();
      listeners.clear();
      if (server.listening)
        await new Promise((resolve) => {
          server.close(() => resolve(undefined));
        });
    },
  };
}
