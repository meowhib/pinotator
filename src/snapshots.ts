import { randomUUID } from 'node:crypto';
import { mkdir, lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';

const createSchema = z
  .object({ label: z.string().trim().min(1).max(100), confirmed: z.literal(true) })
  .strict();
const compareSchema = z
  .object({ snapshotId: z.string().uuid(), confirmed: z.literal(true) })
  .strict();
const importSchema = z
  .object({
    bundleBase64: z.string().max(8_500_000),
    filename: z.string().max(120),
    confirmed: z.literal(true),
  })
  .strict();
const SENSITIVE =
  /(api.?key|secret|token|password|authorization|credential|private.?key|client.?secret|access.?key|headers|oauth)/i;
const SECRET =
  /\b(?:sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._~-]{16,})\b|https?:\/\/[^/@\s]+:[^/@\s]+@[^\s]+|([?&](?:api[_-]?key|token|secret|password|authorization)=)[^&#\s]+/gi;
function fail(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status });
}
function inside(root, target) {
  const rel = relative(resolve(root), resolve(target));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
function sanitize(value, key = '') {
  if (SENSITIVE.test(key)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([name]) => !SENSITIVE.test(name))
        .map(([name, child]) => [name, sanitize(child, name)]),
    );
  if (typeof value === 'string')
    return value
      .replace(SECRET, (match, query) => (query ? `${query}[REDACTED]` : '[REDACTED]'))
      .replace(
        /((?:api[_-]?key|secret|token|password|authorization|credential)\s*[:=]\s*)[^\s,;]+/gi,
        '$1[REDACTED]',
      )
      .replace(/(^|\s)![^\s]+/g, '$1[REDACTED: command resolver]');
  return value;
}
function resourceKey(resource) {
  return [
    resource.kind,
    resource.name,
    resource.scope || resource.source?.scope || '',
    resource.owner || '',
    resource.source?.displayPath || '',
  ].join('\0');
}
function normalizedSource(source, context) {
  if (!source) return undefined;
  const scope = source.scope || 'unknown';
  if (
    typeof source.displayPath === 'string' &&
    /^(?:global|project|home|ancestor)\/[A-Za-z0-9._/-]{1,500}$/.test(source.displayPath) &&
    !source.displayPath.split('/').includes('..')
  )
    return {
      scope,
      owner: source.owner,
      displayPath: source.displayPath,
      versionHash: /^[a-f0-9]{64}$/.test(source.versionHash || '') ? source.versionHash : undefined,
    };
  const path =
    typeof source.displayPath === 'string' && isAbsolute(source.displayPath)
      ? resolve(source.displayPath)
      : '';
  const roots =
    scope === 'global'
      ? [[context.agentDirectory, 'global']]
      : scope === 'project'
        ? [[context.cwd, 'project']]
        : scope === 'portable'
          ? [[context.home, 'home']]
          : scope === 'ancestor'
            ? [[context.home, 'ancestor']]
            : [];
  const root = roots.find(([base]) => path && inside(base, path));
  const displayPath = root
    ? `${root[1]}/${relative(resolve(root[0]), path).split(sep).join('/')}`
    : path
      ? `${scope}/${basename(path)}`
      : undefined;
  return { scope, owner: source.owner, displayPath, versionHash: source.versionHash };
}
function resourceSnapshot(resource, context) {
  if (
    !resource ||
    typeof resource !== 'object' ||
    typeof resource.kind !== 'string' ||
    typeof resource.name !== 'string'
  )
    return null;
  const diagnostics = Array.isArray(resource.diagnostics)
    ? resource.diagnostics
        .map((item) => ({ code: item?.code, severity: item?.severity, message: item?.message }))
        .filter((item) => typeof item.code === 'string')
    : undefined;
  return sanitize({
    kind: resource.kind.slice(0, 80),
    name: resource.name.slice(0, 240),
    description:
      typeof resource.description === 'string' ? resource.description.slice(0, 2000) : undefined,
    state: resource.state,
    owner: resource.owner,
    scope: resource.scope || resource.source?.scope,
    source: normalizedSource(resource.source, context),
    details: resource.details,
    effectiveModel: resource.effectiveModel,
    effectiveThinking: resource.effectiveThinking,
    adapterVersion: resource.adapterVersion,
    adapterCompatibility: resource.adapterCompatibility,
    diagnostics,
  });
}
function shareSafe(value, context, key = '') {
  const safe = sanitize(value, key);
  if (Array.isArray(safe)) return safe.map((item) => shareSafe(item, context));
  if (safe && typeof safe === 'object')
    return Object.fromEntries(
      Object.entries(safe).map(([name, child]) => [name, shareSafe(child, context, name)]),
    );
  if (typeof safe === 'string') {
    let output = safe;
    for (const [root, label] of [
      [context.home, '[LOCAL_HOME]'],
      [context.cwd, '[LOCAL_PROJECT]'],
      [context.agentDirectory, '[LOCAL_AGENT_DIR]'],
    ])
      if (root) output = output.split(root).join(label);
    if (isAbsolute(output) && !/^https?:/i.test(output)) return '[LOCAL_PATH]';
    if ((key === 'path' || /directory|filepath/i.test(key)) && /^(?:[A-Za-z]:\\|\/)/.test(output))
      return '[LOCAL_PATH]';
    return output
      .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._~-]{16,})\b/g, '[REDACTED]')
      .replace(/(https?:\/\/[^\s?#]+)\?[^\s#]*/gi, '$1?[REDACTED]')
      .replace(/file:\/\/[^\s"']+/gi, 'file://[LOCAL_PATH]')
      .replace(/\b[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s]+/g, '[LOCAL_PATH]')
      .replace(/(^|[\s"'=(:,])(?:\/[A-Za-z0-9._-]+){2,}/g, '$1[LOCAL_PATH]');
  }
  return safe;
}
function inventory(discovery, context) {
  return discovery.getResources().map((resource) => resourceSnapshot(resource, context));
}
async function ensurePrivate(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (typeof process.getuid === 'function' && info.uid !== process.getuid()) ||
    (info.mode & 0o077) !== 0
  )
    throw fail('SNAPSHOT_STORE_UNSAFE', 'Private snapshot directory is unsafe.', 500);
}
async function gitBranch(root) {
  try {
    const git = join(root, '.git');
    const info = await lstat(git);
    if (!info.isDirectory() || info.isSymbolicLink()) return undefined;
    const head = await readFile(join(git, 'HEAD'), 'utf8');
    const match = /^ref: refs\/heads\/([a-zA-Z0-9._/-]{1,160})\s*$/.exec(head);
    return match && !match[1].split('/').includes('..')
      ? match[1]
      : head.trim() === 'ref: refs/heads/main'
        ? 'main'
        : undefined;
  } catch {
    return undefined;
  }
}
export function createSnapshotService({
  getDiscovery,
  context,
  stateDirectory,
}: {
  getDiscovery: import('./types.js').GetDiscovery;
  context: import('./types.js').ManagerContext;
  stateDirectory?: string;
}) {
  const directory = join(
    resolve(
      stateDirectory ||
        join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'pinotator'),
    ),
    'snapshots',
  );
  async function load(id) {
    if (!/^[a-f0-9-]{36}$/.test(id || ''))
      throw fail('SNAPSHOT_NOT_FOUND', 'Snapshot was not found.', 404);
    const path = join(directory, `${id}.json`);
    let info;
    try {
      info = await lstat(path);
    } catch {
      throw fail('SNAPSHOT_NOT_FOUND', 'Snapshot was not found.', 404);
    }
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      (typeof process.getuid === 'function' && info.uid !== process.getuid()) ||
      (info.mode & 0o077) !== 0 ||
      info.size > 8 * 1024 * 1024
    )
      throw fail('SNAPSHOT_INVALID', 'Snapshot file failed safety checks.', 500);
    try {
      const item = JSON.parse(await readFile(path, 'utf8'));
      if (item.id !== id || item.schemaVersion !== 1 || !Array.isArray(item.resources))
        throw new Error();
      return item;
    } catch {
      throw fail('SNAPSHOT_INVALID', 'Snapshot data is invalid.', 500);
    }
  }
  async function list() {
    let dirInfo;
    try {
      dirInfo = await lstat(directory);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    if (
      !dirInfo.isDirectory() ||
      dirInfo.isSymbolicLink() ||
      (typeof process.getuid === 'function' && dirInfo.uid !== process.getuid()) ||
      (dirInfo.mode & 0o077) !== 0
    )
      throw fail('SNAPSHOT_STORE_UNSAFE', 'Private snapshot directory is unsafe.', 500);
    const files = await readdir(directory);
    const results = [];
    for (const name of files.filter((value) => /^[a-f0-9-]{36}\.json$/.test(value)).slice(-100)) {
      try {
        const item = await load(name.slice(0, -5));
        results.push({
          id: item.id,
          label: item.label,
          createdAt: item.createdAt,
          branch: item.branch,
          workingDirectory: item.workingDirectory,
          piVersion: item.piVersion || 'unknown',
          resourceCount: item.resources.length,
        });
      } catch {}
    }
    return results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  return {
    async list() {
      return list();
    },
    async get(id) {
      const item = await load(id);
      return {
        id: item.id,
        label: item.label,
        createdAt: item.createdAt,
        branch: item.branch,
        workingDirectory: item.workingDirectory,
        piVersion: item.piVersion,
        resources: item.resources,
      };
    },
    async exportSnapshot(id) {
      const item = await load(id);
      return {
        schemaVersion: 1,
        label: item.label,
        createdAt: item.createdAt,
        branch: item.branch,
        piVersion: item.piVersion,
        resources: item.resources.map((resource) => shareSafe(resource, context)),
      };
    },
    async importSnapshot(payload) {
      const request = importSchema.parse(payload);
      if (
        !/^[a-zA-Z0-9._ -]{1,120}$/.test(request.filename) ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
          request.bundleBase64,
        )
      )
        throw fail('INVALID_BUNDLE', 'Snapshot bundle must be a valid base64 JSON file.');
      const bytes = Buffer.from(request.bundleBase64, 'base64');
      if (bytes.length > 6 * 1024 * 1024)
        throw fail('BUNDLE_TOO_LARGE', 'Snapshot bundle exceeds 6 MiB.', 413);
      let bundle;
      try {
        bundle = JSON.parse(bytes.toString('utf8'));
      } catch {
        throw fail('INVALID_BUNDLE', 'Snapshot bundle is not valid JSON.');
      }
      if (
        bundle?.schemaVersion !== 1 ||
        !Array.isArray(bundle.resources) ||
        bundle.resources.length > 10_000 ||
        typeof bundle.label !== 'string'
      )
        throw fail('INVALID_BUNDLE', 'Snapshot bundle schema is not supported.', 422);
      const safeLabel = sanitize(String(bundle.label).slice(0, 80)).replace(/[\r\n]/g, ' ');
      const item = {
        schemaVersion: 1,
        id: randomUUID(),
        label: `Imported: ${safeLabel}`,
        createdAt: new Date().toISOString(),
        imported: true,
        branch:
          typeof bundle.branch === 'string' &&
          /^[A-Za-z0-9._/-]{1,160}$/.test(bundle.branch) &&
          !bundle.branch.split('/').includes('..')
            ? bundle.branch
            : undefined,
        workingDirectory: '[imported snapshot]',
        piVersion: typeof bundle.piVersion === 'string' ? bundle.piVersion.slice(0, 80) : 'unknown',
        resources: bundle.resources
          .map((resource) => resourceSnapshot(resource, context))
          .filter(Boolean)
          .slice(0, 10_000),
      };
      await ensurePrivate(directory);
      await writeFile(join(directory, `${item.id}.json`), `${JSON.stringify(item, null, 2)}\n`, {
        mode: 0o600,
        flag: 'wx',
      });
      return {
        id: item.id,
        label: item.label,
        createdAt: item.createdAt,
        branch: item.branch,
        resourceCount: item.resources.length,
        imported: true,
      };
    },
    async create(payload) {
      const request = createSchema.parse(payload);
      if (
        /\b(?:sk-[A-Za-z0-9_-]{16,}|Bearer\s+\S{16,})\b|https?:\/\/[^/@\s]+:[^/@\s]+@|[?&](?:api[_-]?key|token|secret|password)=/i.test(
          request.label,
        )
      )
        throw fail(
          'SECRET_BEARING_CONTENT',
          'Snapshot label cannot contain credential-like text.',
          422,
        );
      await ensurePrivate(directory);
      const discovery = await getDiscovery();
      const environment = discovery.getEnvironment();
      const resources = inventory(discovery, context);
      const item = {
        schemaVersion: 1,
        id: randomUUID(),
        label: request.label,
        createdAt: new Date().toISOString(),
        branch: await gitBranch(environment.projectRoot || context.cwd),
        workingDirectory: context.cwd,
        projectRoot: environment.projectRoot,
        piVersion: environment.piVersion || 'unknown',
        trust: environment.trust,
        resources,
      };
      await writeFile(join(directory, `${item.id}.json`), `${JSON.stringify(item, null, 2)}\n`, {
        mode: 0o600,
        flag: 'wx',
      });
      return {
        id: item.id,
        label: item.label,
        createdAt: item.createdAt,
        branch: item.branch,
        workingDirectory: item.workingDirectory,
        resourceCount: resources.length,
      };
    },
    async compare(payload) {
      const { snapshotId } = compareSchema.parse(payload);
      const baseline = await load(snapshotId);
      const discovery = await getDiscovery();
      const currentResources = inventory(discovery, context);
      const before = new Map(
        baseline.resources.map((resource) => [resourceKey(resource), resource]),
      );
      const after = new Map(currentResources.map((resource) => [resourceKey(resource), resource]));
      const changes = [];
      for (const [key, value] of after)
        if (!before.has(key)) changes.push({ kind: 'added', resource: value });
        else if (JSON.stringify(before.get(key)) !== JSON.stringify(value))
          changes.push({ kind: 'changed', before: before.get(key), after: value });
      for (const [key, value] of before)
        if (!after.has(key)) changes.push({ kind: 'removed', resource: value });
      return {
        snapshot: {
          id: baseline.id,
          label: baseline.label,
          createdAt: baseline.createdAt,
          branch: baseline.branch,
          workingDirectory: baseline.workingDirectory,
        },
        current: {
          workingDirectory: context.cwd,
          branch: await gitBranch(discovery.getEnvironment().projectRoot || context.cwd),
        },
        changes: changes.slice(0, 500),
        truncated: changes.length > 500,
      };
    },
  };
}
