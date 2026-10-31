import { basename } from 'node:path';

interface ModelIdentity {
  provider: string;
  id: string;
  name?: string;
}
interface ReloadRequest {
  kind: 'reload';
  id: string;
}
interface CompanionResponse {
  token?: string;
  message?: string;
  action?: ReloadRequest;
  pendingAction?: ReloadRequest;
}
interface CompanionContext {
  cwd: string;
  hasUI: boolean;
  model?: ModelIdentity;
  modelRegistry: { getAll(): ModelIdentity[] };
  ui: {
    input(title: string, placeholder: string): Promise<string | undefined>;
    confirm(title: string, message: string): Promise<boolean>;
    notify(message: string, level: 'info' | 'warning' | 'error'): void;
  };
  isIdle(): boolean;
  reload(): Promise<void>;
}
interface CompanionApi {
  getAllTools(): { name: string }[];
  getActiveTools(): string[];
  getCommands(): { name: string }[];
  on(
    event: string,
    handler: (event: unknown, context: CompanionContext) => void | Promise<void>,
  ): void;
  registerCommand(
    name: string,
    command: {
      description: string;
      handler: (args: string, context: CompanionContext) => Promise<void>;
    },
  ): void;
}

let pair: { url: string; token: string } | null = null;
let heartbeat: ReturnType<typeof setInterval> | null = null;
let busy = false;
let lastPublish = 0;
let notifiedReloadRequest: string | null = null;
const REQUEST_TIMEOUT_MS = 2500;

function localBaseUrl(value: string): string {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Enter a valid Pinotator loopback URL.');
  }
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname.toLowerCase()) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('Only a plain HTTP loopback Pinotator URL is allowed.');
  return url.origin;
}
async function request(
  url: string,
  token: string,
  path: string,
  method: string,
  body: unknown,
): Promise<CompanionResponse> {
  const response = await fetch(`${url}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  let result;
  try {
    result = await response.json();
  } catch {
    result = {};
  }
  if (!response.ok)
    throw new Error(result.message || `Pinotator companion returned HTTP ${response.status}.`);
  return result;
}
function status(pi: CompanionApi, ctx: CompanionContext) {
  let model = null;
  try {
    if (ctx.model) model = { provider: ctx.model.provider, id: ctx.model.id, name: ctx.model.name };
  } catch {}
  let registeredModels = [];
  try {
    registeredModels = ctx.modelRegistry
      .getAll()
      .slice(0, 50)
      .map((entry) => ({
        provider: entry.provider,
        id: entry.id,
        name: entry.name,
      }));
  } catch {}
  let registeredTools = [];
  try {
    registeredTools = pi
      .getAllTools()
      .slice(0, 100)
      .map((tool) => tool.name);
  } catch {}
  let activeTools = [];
  try {
    activeTools = pi.getActiveTools().slice(0, 100);
  } catch {}
  let commands = [];
  try {
    commands = pi
      .getCommands()
      .slice(0, 100)
      .map((command) => command.name);
  } catch {}
  return {
    cwdLabel: basename(ctx.cwd) || 'workspace',
    model,
    busy,
    activeTools,
    registeredTools,
    commands,
    registeredModels,
  };
}
async function publish(pi: CompanionApi, ctx: CompanionContext, force = false) {
  if (!pair) return;
  const now = Date.now();
  if (!force && now - lastPublish < 1500) return;
  lastPublish = now;
  try {
    const response = await request(
      pair.url,
      pair.token,
      '/api/companion/update',
      'POST',
      status(pi, ctx),
    );
    if (
      response.pendingAction?.kind === 'reload' &&
      response.pendingAction.id !== notifiedReloadRequest
    ) {
      notifiedReloadRequest = response.pendingAction.id;
      if (ctx.hasUI)
        ctx.ui.notify(
          'Pinotator requested a Pi reload. Run /pinotator-handle-reload to review and confirm it in this Pi process.',
          'warning',
        );
    }
  } catch (error) {
    if (/expired|not paired/i.test(error.message)) stopHeartbeat();
    if (ctx.hasUI) ctx.ui.notify(`Pinotator companion update failed: ${error.message}`, 'warning');
  }
}
function stopHeartbeat() {
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = null;
}
function startHeartbeat(pi: CompanionApi, ctx: CompanionContext) {
  stopHeartbeat();
  heartbeat = setInterval(() => void publish(pi, ctx, true), 15_000);
  heartbeat.unref?.();
}

export default function (pi: CompanionApi) {
  pi.on('session_start', (_event, ctx) => {
    if (pair) {
      startHeartbeat(pi, ctx);
      void publish(pi, ctx, true);
    }
  });
  pi.on('agent_start', (_event, ctx) => {
    busy = true;
    if (pair) void publish(pi, ctx);
  });
  pi.on('agent_settled', (_event, ctx) => {
    busy = false;
    if (pair) void publish(pi, ctx, true);
  });
  pi.on('model_select', (_event, ctx) => {
    if (pair) void publish(pi, ctx, true);
  });
  pi.on('session_shutdown', async () => {
    stopHeartbeat();
    if (pair) {
      const active = pair;
      pair = null;
      try {
        await request(active.url, active.token, '/api/companion/close', 'POST', {});
      } catch {}
    }
    busy = false;
  });
  pi.registerCommand('pinotator-pair', {
    description: 'Pair this Pi process with a local Pinotator session dashboard',
    handler: async (_args, ctx) => {
      try {
        const rawUrl = await ctx.ui.input('Pinotator loopback URL', 'http://127.0.0.1:PORT');
        if (!rawUrl) return;
        const url = localBaseUrl(rawUrl.trim());
        const code = await ctx.ui.input(
          'One-time Pinotator pairing code',
          'Paste the code from its Companion page',
        );
        if (!code) return;
        const claimed = await request(
          url,
          code.trim(),
          '/api/companion/claim',
          'POST',
          status(pi, ctx),
        );
        stopHeartbeat();
        if (typeof claimed.token !== 'string' || !claimed.token)
          throw new Error('Pinotator returned no pairing token.');
        pair = { url, token: claimed.token };
        notifiedReloadRequest = null;
        startHeartbeat(pi, ctx);
        await publish(pi, ctx, true);
        ctx.ui.notify(
          'This Pi process is paired. Only live metadata (workspace label, model, tools and commands) is shared with the local Pinotator process; no transcript or file contents.',
          'info',
        );
      } catch (error) {
        ctx.ui.notify(`Could not pair with Pinotator: ${error.message}`, 'error');
      }
    },
  });
  pi.registerCommand('pinotator-handle-reload', {
    description: 'Review a pending Pinotator reload request and confirm locally',
    handler: async (_args, ctx) => {
      if (!pair) {
        ctx.ui.notify('This Pi process is not paired with Pinotator.', 'warning');
        return;
      }
      if (!ctx.isIdle()) {
        ctx.ui.notify(
          'Wait until this Pi process is idle before handling a reload request.',
          'warning',
        );
        return;
      }
      try {
        const pending = await request(pair.url, pair.token, '/api/companion/pending', 'POST', {});
        if (pending.action?.kind !== 'reload') {
          ctx.ui.notify('No active Pinotator reload request.', 'info');
          return;
        }
        const approved = await ctx.ui.confirm(
          'Pinotator requested a Pi reload',
          'Reload this Pi process now? This can reload extension/config state. No files will be changed by this request.',
        );
        await request(pair.url, pair.token, '/api/companion/complete', 'POST', {
          requestId: pending.action.id,
          outcome: approved ? 'approved' : 'declined',
        });
        notifiedReloadRequest = null;
        if (!approved) {
          ctx.ui.notify('Reload request declined.', 'info');
          return;
        }
        ctx.ui.notify(
          'Reload approved locally. Pinotator cannot verify the result; pair again after Pi reloads.',
          'warning',
        );
        await ctx.reload();
      } catch (error) {
        ctx.ui.notify(`Could not process reload request: ${error.message}`, 'error');
      }
    },
  });
  pi.registerCommand('pinotator-unpair', {
    description: 'Stop sharing this Pi process status with Pinotator',
    handler: async (_args, ctx) => {
      stopHeartbeat();
      if (pair) {
        const active = pair;
        pair = null;
        try {
          await request(active.url, active.token, '/api/companion/close', 'POST', {});
        } catch {}
      }
      ctx.ui.notify('Pinotator companion pairing ended.', 'info');
    },
  });
}
