import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import {
  basename,
  delimiter,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import YAML from 'yaml';
import { parse as parseJsonc } from 'jsonc-parser';
import {
  parseAgentDefinition,
  piSubagentsAdapter,
  TESTED_PI_SUBAGENTS_VERSION,
} from './adapters/pi-subagents.js';
import { createAdapterRegistry } from './adapters/registry.js';
import { TESTED_BUILTIN_EXTENSIONS, TESTED_PI_VERSION } from './pi-compat.js';

import type {
  ConfigRecord,
  Diagnostic,
  FileEntry,
  ManagerContext,
  Resource,
  StoredFile,
} from './types.js';

interface InventoryState {
  context: ManagerContext;
  workspaceId: string;
  files: Map<string, StoredFile>;
  resources: Map<string, Resource>;
  agentCandidates: ConfigRecord[];
  diagnostics: Diagnostic[];
  roots: { path: string; scope: string; kind: string; owner: string }[];
  settings: {
    modelsByScope: Record<string, ConfigRecord>;
    mcpByScope: Record<string, ConfigRecord>;
    global?: ConfigRecord;
    project?: ConfigRecord;
  };
  pi: Awaited<ReturnType<typeof piVersion>>;
}

const execFileAsync = promisify(execFile);
const adapterRegistry = createAdapterRegistry([piSubagentsAdapter]);
const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILES_PER_ROOT = 500;
const MAX_TREE_DEPTH = 6;
const EXTENSION_CODE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.tsx']);
const isExtensionInventoryFile = (name) =>
  EXTENSION_CODE_EXTENSIONS.has(extname(name).toLowerCase()) ||
  name.toLowerCase() === 'package.json' ||
  name.toLowerCase() === 'readme.md';
const SENSITIVE_KEY =
  /(api.?key|secret|token|password|authorization|credential|private.?key|client.?secret|access.?key)/i;
const SAFE_INLINE_SECRET = /\b(?:sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._~-]{16,})\b/g;
const INSTRUCTION_NAMES = [
  'AGENTS.md',
  'AGENTS.MD',
  'CLAUDE.md',
  'CLAUDE.MD',
  'AGENTS.override.md',
];

function inside(root, path) {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep));
}
async function hasSymlinkComponent(path) {
  let current = resolve(path);
  for (;;) {
    const info = await lstat(current);
    if (info.isSymbolicLink()) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}
function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
function parseJsoncSafe(text) {
  const errors = [];
  const value = parseJsonc(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length) throw new Error('Invalid JSONC');
  return value;
}
function diagnostic(
  code: string,
  severity: string,
  message: string,
  sourceId?: string,
): Diagnostic {
  return { code, severity, message, sourceId };
}
function safeName(value) {
  return String(redact(value || 'unknown')).slice(0, 120);
}
function safeEndpointOrigin(value) {
  try {
    const url = new URL(value);
    return url.username || url.password ? '[configured endpoint]' : url.origin;
  } catch {
    return '[configured endpoint]';
  }
}
function normalizeSettings(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) =>
      typeof item === 'string' ? item : item?.source || item?.package || item?.name || '',
    )
    .filter(Boolean)
    .map(String);
}
function scrubString(value) {
  return value
    .replace(SAFE_INLINE_SECRET, '[REDACTED]')
    .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, '$1[REDACTED]@')
    .replace(/(https?:\/\/[^\s?#]+)\?[^\s#]*/gi, '$1?[REDACTED]')
    .replace(/([?&](?:api[_-]?key|token|secret|password|authorization)=)[^&#\s]+/gi, '$1[REDACTED]')
    .replace(
      /((?:api[_-]?key|secret|token|password|authorization|credential|private[_-]?key|client[_-]?secret|access[_-]?key)\s*[:=]\s*)[^\s,;]+/gi,
      '$1[REDACTED]',
    );
}
function redact(value, key = '') {
  if (SENSITIVE_KEY.test(key)) return value == null ? value : '[REDACTED]';
  if (Array.isArray(value)) return value.map((item) => redact(item, key));
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    if (['env', 'headers', 'oauth'].includes(key.toLowerCase()))
      return Object.fromEntries(entries.map(([name]) => [name, '[REDACTED]']));
    return Object.fromEntries(entries.map(([k, v]) => [k, redact(v, k)]));
  }
  if (typeof value === 'string') {
    if (value.startsWith('!')) return '[REDACTED: command resolver]';
    return scrubString(value);
  }
  return value;
}
function parseFrontmatter(text) {
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/.exec(text);
  if (!match) return { metadata: {}, body: text, error: null };
  try {
    return { metadata: YAML.parse(match[1]) || {}, body: text.slice(match[0].length), error: null };
  } catch (error) {
    return { metadata: {}, body: text.slice(match[0].length), error: error.message };
  }
}

async function projectTrustFor(context) {
  if (context.mode === 'global') return 'not_applicable';
  const trustPath = join(context.agentDirectory, 'trust.json');
  try {
    const info = await lstat(trustPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 128 * 1024) return 'unknown';
    const value = JSON.parse(await readFile(trustPath, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return 'unknown';
    const key = await realpath(context.cwd).catch(() => context.cwd);
    if (value[key] === true) return 'trusted';
    if (value[key] === false) return 'untrusted';
    return 'undecided';
  } catch (error) {
    return error.code === 'ENOENT' ? 'undecided' : 'unknown';
  }
}
async function findRepoRoot(start, home) {
  let dir = start;
  for (let depth = 0; depth < 32; depth++) {
    try {
      await lstat(join(dir, '.git'));
      return dir;
    } catch {}
    const parent = dirname(dir);
    if (parent === dir || dir === home) break;
    dir = parent;
  }
  return undefined;
}
async function findPiExecutable() {
  const pathEntries = (process.env.PATH || '').split(delimiter).filter(Boolean);
  const candidates = process.platform === 'win32' ? ['pi.exe', 'pi.cmd', 'pi.bat', 'pi'] : ['pi'];
  for (const directory of pathEntries)
    for (const name of candidates) {
      const candidate = join(directory, name);
      try {
        await access(candidate, constants.X_OK);
        return await realpath(candidate);
      } catch {}
    }
  return null;
}
async function piVersion() {
  const executable = await findPiExecutable();
  if (!executable)
    return {
      executable: null,
      version: null,
      detected: false,
      detail: 'Pi executable not found in PATH',
    };
  try {
    const { stdout } = await execFileAsync(executable, ['--version'], {
      timeout: 2500,
      maxBuffer: 4096,
      windowsHide: true,
    });
    const version = stdout.trim().slice(0, 120);
    return {
      executable,
      version,
      detected: true,
      semanticVersion: version.match(/\d+\.\d+\.\d+/)?.[0] || null,
      distribution: 'unknown',
      capabilities: {
        staticInventory: 'supported',
        runtimeRegistry: 'unknown',
        trustedProbe: 'unverified',
      },
    };
  } catch (error) {
    return {
      executable,
      version: null,
      detected: false,
      detail:
        error.code === 'ENOENT'
          ? 'Pi executable disappeared during inspection'
          : 'Pi version could not be determined safely',
    };
  }
}

async function addFile(
  state: InventoryState,
  {
    path,
    scope,
    kind,
    owner = 'pi-core',
    allowContent = true,
    metadata = {},
  }: {
    path: string;
    scope: string;
    kind: string;
    owner?: string;
    allowContent?: boolean;
    metadata?: ConfigRecord;
  },
): Promise<FileEntry | null> {
  let info, canonical;
  try {
    info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE_BYTES) return null;
    canonical = await realpath(path);
  } catch {
    return null;
  }
  const bytes = await readFile(canonical);
  const fileId = randomUUID();
  const raw = bytes.toString('utf8');
  const validUtf8 = Buffer.from(raw, 'utf8').equals(bytes);
  const entry: FileEntry = {
    id: fileId,
    displayPath: path,
    scope,
    owner,
    kind,
    versionHash: digest(bytes),
    size: bytes.length,
    modifiedAt: info.mtime.toISOString(),
    editable:
      allowContent &&
      validUtf8 &&
      (kind !== 'extension' || (owner === 'local-extension' && scrubString(raw) === raw)) &&
      [
        'instruction',
        'system-prompt',
        'append-system',
        'skill',
        'skill-asset',
        'command',
        'agent',
        'extension',
      ].includes(kind) &&
      !['ancestor', 'package'].includes(scope) &&
      owner !== 'pi-package',
    trust:
      kind === 'instruction'
        ? 'not_applicable'
        : scope === 'project' || scope === 'ancestor'
          ? state.context.projectTrust || 'unknown'
          : 'not_applicable',
    ...metadata,
  };
  state.files.set(fileId, {
    entry,
    path: canonical,
    raw,
    bytes,
    allowContent: allowContent && validUtf8 && (kind !== 'extension' || scrubString(raw) === raw),
  });
  return entry;
}

async function scanDirectory(state: InventoryState, root, options) {
  let canonicalRoot;
  try {
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink()) return;
    canonicalRoot = await realpath(root);
  } catch {
    return;
  }
  const seen = { count: 0, visited: 0 };
  async function walk(dir, depth) {
    if (seen.count >= MAX_FILES_PER_ROOT || seen.visited >= 5000 || depth > MAX_TREE_DEPTH) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const item of entries) {
      if (seen.count >= MAX_FILES_PER_ROOT || seen.visited >= 5000) break;
      seen.visited++;
      const path = join(dir, item.name);
      if (item.isSymbolicLink()) continue;
      if (item.isDirectory()) {
        if (
          options.recursive &&
          !item.name.startsWith('.') &&
          (options.includeNodeModules || item.name !== 'node_modules') &&
          item.name !== 'sessions'
        )
          await walk(path, depth + 1);
        continue;
      }
      if (!item.isFile() || !options.accept(path, item.name, depth)) continue;
      if (!inside(canonicalRoot, await realpath(path).catch(() => path))) continue;
      seen.count++;
      await options.onFile(path, item.name, depth);
    }
  }
  await walk(canonicalRoot, 0);
  if (seen.count >= MAX_FILES_PER_ROOT || seen.visited >= 5000)
    state.diagnostics.push(
      diagnostic('SCAN_LIMIT_REACHED', 'warning', `Inventory limit reached for ${root}.`),
    );
}

function addResource(state: InventoryState, resource: ConfigRecord, file?: FileEntry): Resource {
  const id = randomUUID();
  const result: Resource = {
    id,
    kind: resource.kind,
    name: safeName(resource.name),
    description: safeName(resource.description || ''),
    state:
      file?.trust === 'untrusted' && resource.state !== 'invalid' && resource.kind !== 'instruction'
        ? 'untrusted'
        : resource.state || 'unknown',
    scope: file?.scope || resource.scope || 'unknown',
    owner: resource.owner || file?.owner || 'unknown',
    source: file
      ? {
          fileId: file.id,
          displayPath: file.displayPath,
          scope: file.scope,
          owner: file.owner,
          packageName: file.packageName,
          versionHash: file.versionHash,
          trust: file.trust,
        }
      : undefined,
    diagnostics: resource.diagnostics || [],
    explanation: resource.explanation || [
      'Found by bounded static inspection; runtime activation has not been verified.',
    ],
    ...redact(resource.details || {}),
  };
  state.resources.set(id, result);
  return result;
}

async function scanExtensionRoot(state: InventoryState, root, scope, owner = 'local-extension') {
  const resources = [];
  const codePaths = new Set();
  const manifestEntries = new Set();
  await scanDirectory(state, root, {
    recursive: true,
    accept: (_path, name) => isExtensionInventoryFile(name),
    onFile: async (path) => {
      if ([...state.files.values()].some((candidate) => resolve(candidate.path) === resolve(path)))
        return;
      const extension = extname(path).toLowerCase();
      const codeFile = EXTENSION_CODE_EXTENSIONS.has(extension);
      const segments = relative(root, path).split(sep);
      const directEntry = codeFile && segments.length === 1 && ['.js', '.ts'].includes(extension);
      const indexEntry =
        codeFile && segments.length === 2 && /^index\.(?:js|ts)$/i.test(basename(path));
      if (codeFile) codePaths.add(resolve(path));
      const file = await addFile(state, {
        path,
        scope,
        kind: 'extension',
        owner,
        allowContent: codeFile,
      });
      if (!file) return;
      let manifestDeclaresExtensions = false;
      if (basename(path).toLowerCase() === 'package.json') {
        try {
          const manifest = JSON.parse(state.files.get(file.id).raw);
          const declared = manifest?.pi?.extensions;
          const packageRoot = dirname(path);
          const supportedManifestDepth =
            segments.length === 2 || (segments.length === 1 && owner !== 'local-extension');
          if (supportedManifestDepth && Array.isArray(declared)) {
            for (const entry of declared) {
              if (typeof entry !== 'string' || isAbsolute(entry)) continue;
              const resolvedEntry = resolve(packageRoot, entry);
              if (
                inside(packageRoot, resolvedEntry) &&
                ['.js', '.ts'].includes(extname(resolvedEntry).toLowerCase())
              )
                manifestEntries.add(resolvedEntry);
            }
          }
          manifestDeclaresExtensions = Array.isArray(declared) && declared.length > 0;
        } catch {
          file.parseError = 'Package manifest is invalid JSON.';
        }
      }
      const resource = addResource(
        state,
        {
          kind: 'extension',
          name: basename(path),
          state: 'unknown',
          details: {
            metadataOnly: !state.files.get(file.id).allowContent,
            codeFile,
            extensionFileType: extension || 'unknown',
            entryPointCandidate: directEntry || indexEntry,
            entryPointLayout: directEntry ? 'direct-file' : indexEntry ? 'index-file' : 'other',
            manifestDeclaresExtensions,
            configuredPath: owner !== 'local-extension',
          },
        },
        file,
      );
      resources.push({ resource, file });
    },
  });
  for (const { resource, file } of resources) {
    if (
      manifestEntries.has(resolve(file.displayPath)) &&
      codePaths.has(resolve(file.displayPath))
    ) {
      resource.entryPointCandidate = true;
      resource.entryPointLayout = 'package.json';
    }
  }
}

async function scanConfiguredExtensionPaths(state: InventoryState, scope, configuredPaths) {
  if (!Array.isArray(configuredPaths)) return;
  const trusted = scope !== 'project' || state.context.projectTrust === 'trusted';
  for (const configured of configuredPaths) {
    if (typeof configured !== 'string' || !configured.trim()) continue;
    // Built-in selectors are not filesystem paths or user-installed code.
    if (/^[+-]?builtin:/.test(configured)) continue;
    const expanded = configured.startsWith('~/')
      ? join(state.context.home, configured.slice(2))
      : configured;
    const path = resolve(state.context.cwd, expanded);
    if (!trusted) {
      addResource(state, {
        kind: 'extension',
        name: configured,
        state: 'untrusted',
        owner: 'configured-extension-path',
        description:
          'Configured project extension path was not inspected because project trust is not granted.',
        details: { configuredPath: true, metadataOnly: true, entryPointCandidate: false },
      });
      continue;
    }
    try {
      const info = await lstat(path);
      if (await hasSymlinkComponent(path))
        throw new Error('Configured extension path contains a symbolic link.');
      const canonicalPath = await realpath(path);
      if (info.isDirectory()) {
        await scanExtensionRoot(state, canonicalPath, scope, 'configured-extension-path');
      } else if (info.isFile() && isExtensionInventoryFile(basename(path))) {
        if (
          [...state.files.values()].some((candidate) => resolve(candidate.path) === canonicalPath)
        )
          continue;
        const codeFile = EXTENSION_CODE_EXTENSIONS.has(extname(path).toLowerCase());
        const file = await addFile(state, {
          path: canonicalPath,
          scope,
          kind: 'extension',
          owner: 'configured-extension-path',
          allowContent: codeFile,
        });
        if (file)
          addResource(
            state,
            {
              kind: 'extension',
              name: basename(path),
              state: 'unknown',
              owner: 'configured-extension-path',
              description: 'User-configured extension path; code was not loaded.',
              details: {
                configuredPath: true,
                codeFile,
                metadataOnly: !state.files.get(file.id).allowContent,
                extensionFileType: extname(path).toLowerCase() || 'unknown',
                entryPointCandidate:
                  codeFile && ['.js', '.ts'].includes(extname(path).toLowerCase()),
                entryPointLayout: 'configured-file',
              },
            },
            file,
          );
      }
    } catch (error) {
      addResource(state, {
        kind: 'extension',
        name: configured,
        state: 'unknown',
        owner: 'configured-extension-path',
        description: error.message,
        details: { configuredPath: true, metadataOnly: true, entryPointCandidate: false },
      });
    }
  }
}

export async function createDiscovery(context: ManagerContext) {
  const ctx: ManagerContext = {
    ...context,
    cwd: resolve(context.cwd),
    home: resolve(context.home),
    agentDirectory: resolve(context.agentDirectory),
  };
  ctx.projectTrust = await projectTrustFor(ctx);
  ctx.repoRoot = ctx.mode === 'global' ? undefined : await findRepoRoot(ctx.cwd, ctx.home);
  const state: InventoryState = {
    context: ctx,
    workspaceId: randomUUID(),
    files: new Map(),
    resources: new Map(),
    agentCandidates: [],
    diagnostics: [],
    roots: [],
    settings: { modelsByScope: {}, mcpByScope: {} },
    pi: await piVersion(),
  };
  if (!state.pi.detected)
    state.diagnostics.push(
      diagnostic(
        'PI_NOT_FOUND',
        'warning',
        'Pi executable was not found. Configuration can be inspected, but runtime semantics are unavailable.',
      ),
    );
  else
    state.diagnostics.push(
      diagnostic(
        'PI_RUNTIME_NOT_PROBED',
        'info',
        'Pi version detected. Extensions and runtime-derived state are not loaded during passive inspection.',
      ),
    );
  if (ctx.projectTrust === 'untrusted')
    state.diagnostics.push(
      diagnostic(
        'PROJECT_UNTRUSTED',
        'warning',
        'Pi has a saved untrusted decision for this project; project Pi resources are present but not loaded.',
      ),
    );
  else if (ctx.projectTrust === 'undecided')
    state.diagnostics.push(
      diagnostic(
        'PROJECT_TRUST_UNDECIDED',
        'warning',
        'No saved trust decision was found; project Pi resources may not load in Pi.',
      ),
    );
  else if (ctx.projectTrust === 'unknown')
    state.diagnostics.push(
      diagnostic(
        'PROJECT_TRUST_UNKNOWN',
        'warning',
        'Project trust could not be read safely; project resources are candidates, not confirmed active resources.',
      ),
    );

  const addRoot = (path, scope, kind, owner = 'pi-core') =>
    state.roots.push({ path, scope, kind, owner });
  const global = ctx.agentDirectory;
  addRoot(global, 'global', 'agent-directory');
  const portableGlobalSkills = join(ctx.home, '.agents', 'skills');
  addRoot(portableGlobalSkills, 'portable', 'skill-root', 'portable-skill');
  await scanDirectory(state, portableGlobalSkills, {
    recursive: true,
    accept: (_p, name) => !name.startsWith('.'),
    onFile: async (path) =>
      registerSkillFile(state, path, 'portable', 'portable-skill', portableGlobalSkills),
  });
  const settingsFile = join(global, 'settings.json');
  const globalSettings = await addFile(state, {
    path: settingsFile,
    scope: 'global',
    kind: 'settings',
    metadata: { displayName: 'Global Pi settings' },
  });
  if (globalSettings) {
    try {
      state.settings.global = parseJsoncSafe(state.files.get(globalSettings.id).raw);
    } catch (error) {
      globalSettings.parseError = error.message;
      state.diagnostics.push(
        diagnostic(
          'INVALID_SETTINGS_JSON',
          'error',
          'Global settings.json is invalid JSON.',
          globalSettings.id,
        ),
      );
    }
  }
  for (const [name, kind] of [
    ['models.json', 'models'],
    ['mcp.json', 'mcp'],
    ['keybindings.json', 'keybindings'],
  ]) {
    const file = await addFile(state, {
      path: join(global, name),
      scope: 'global',
      kind,
      allowContent: kind !== 'mcp',
    });
    if (file && kind === 'models') {
      try {
        state.settings.modelsByScope.global = parseJsoncSafe(state.files.get(file.id).raw);
      } catch (error) {
        file.parseError = error.message;
        state.diagnostics.push(
          diagnostic(
            'INVALID_MODELS_JSON',
            'error',
            'Global models.json is invalid JSON.',
            file.id,
          ),
        );
      }
    }
    if (file && kind === 'mcp') {
      try {
        state.settings.mcpByScope.global = parseJsoncSafe(state.files.get(file.id).raw);
      } catch (error) {
        file.parseError = error.message;
        state.diagnostics.push(
          diagnostic('INVALID_MCP_JSON', 'error', 'Global mcp.json is invalid JSON.', file.id),
        );
      }
    }
  }
  const globalPaths = [
    ...INSTRUCTION_NAMES.map((name) => [join(global, name), 'instruction']),
    [join(global, 'SYSTEM.md'), 'system-prompt'],
    [join(global, 'APPEND_SYSTEM.md'), 'append-system'],
  ];
  for (const [path, kind] of globalPaths) await addFile(state, { path, scope: 'global', kind });
  for (const [dirName, kind] of [
    ['skills', 'skill'],
    ['prompts', 'command'],
    ['agents', 'agent'],
    ['extensions', 'extension'],
  ]) {
    const dir = join(global, dirName);
    addRoot(dir, 'global', `${kind}-root`);
    if (kind === 'skill') {
      await scanDirectory(state, dir, {
        recursive: true,
        accept: (_p, name) => !name.startsWith('.'),
        onFile: async (path) => registerSkillFile(state, path, 'global', 'pi-core', dir),
      });
    } else if (kind === 'command' || kind === 'agent') {
      await scanDirectory(state, dir, {
        recursive: true,
        accept: (p, n) => extname(n).toLowerCase() === '.md' && !n.endsWith('.chain.md'),
        onFile: async (p) => {
          const file = await addFile(state, {
            path: p,
            scope: 'global',
            kind,
            owner: kind === 'agent' ? 'adapter:pi-subagents' : 'pi-core',
          });
          await markdownResource(state, file, kind);
        },
      });
    } else {
      await scanExtensionRoot(state, dir, 'global');
    }
  }
  await scanConfiguredExtensionPaths(state, 'global', state.settings.global?.extensions);

  if (ctx.mode !== 'global') {
    const projectPi = join(ctx.cwd, '.pi');
    addRoot(projectPi, 'project', 'project-pi');
    for (const [name, kind] of [
      ['settings.json', 'settings'],
      ['models.json', 'models'],
      ['mcp.json', 'mcp'],
      ['keybindings.json', 'keybindings'],
    ]) {
      const file = await addFile(state, {
        path: join(projectPi, name),
        scope: 'project',
        kind,
        allowContent: kind !== 'mcp',
      });
      if (file && name === 'settings.json') {
        try {
          state.settings.project = parseJsoncSafe(state.files.get(file.id).raw);
        } catch (error) {
          file.parseError = error.message;
          state.diagnostics.push(
            diagnostic(
              'INVALID_SETTINGS_JSON',
              'error',
              'Project settings.json is invalid JSON.',
              file.id,
            ),
          );
        }
      }
      if (file && name === 'models.json') {
        try {
          state.settings.modelsByScope.project = parseJsoncSafe(state.files.get(file.id).raw);
        } catch (error) {
          file.parseError = error.message;
          state.diagnostics.push(
            diagnostic(
              'INVALID_MODELS_JSON',
              'error',
              'Project models.json is invalid JSON.',
              file.id,
            ),
          );
        }
      }
      if (file && name === 'mcp.json') {
        try {
          state.settings.mcpByScope.project = parseJsoncSafe(state.files.get(file.id).raw);
        } catch (error) {
          file.parseError = error.message;
          state.diagnostics.push(
            diagnostic('INVALID_MCP_JSON', 'error', 'Project mcp.json is invalid JSON.', file.id),
          );
        }
      }
    }
    for (const [name, kind] of [
      ['SYSTEM.md', 'system-prompt'],
      ['APPEND_SYSTEM.md', 'append-system'],
    ])
      await addFile(state, { path: join(projectPi, name), scope: 'project', kind });
    for (const [dirName, kind] of [
      ['skills', 'skill'],
      ['prompts', 'command'],
      ['agents', 'agent'],
      ['extensions', 'extension'],
    ]) {
      const dir = join(projectPi, dirName);
      addRoot(dir, 'project', `${kind}-root`);
      if (kind === 'skill')
        await scanDirectory(state, dir, {
          recursive: true,
          accept: (_p, name) => !name.startsWith('.'),
          onFile: async (path) => registerSkillFile(state, path, 'project', 'pi-core', dir),
        });
      else if (kind === 'command' || kind === 'agent')
        await scanDirectory(state, dir, {
          recursive: true,
          accept: (_p, n) => extname(n).toLowerCase() === '.md' && !n.endsWith('.chain.md'),
          onFile: async (p) => {
            const file = await addFile(state, {
              path: p,
              scope: 'project',
              kind,
              owner: kind === 'agent' ? 'adapter:pi-subagents' : 'pi-core',
            });
            await markdownResource(state, file, kind);
          },
        });
      else await scanExtensionRoot(state, dir, 'project');
    }
    await scanConfiguredExtensionPaths(state, 'project', state.settings.project?.extensions);
    const legacyAgents = join(ctx.cwd, '.agents');
    addRoot(legacyAgents, 'project', 'legacy-agent-root', 'adapter:pi-subagents');
    await scanDirectory(state, legacyAgents, {
      recursive: true,
      accept: (path, name) =>
        extname(name).toLowerCase() === '.md' &&
        !name.endsWith('.chain.md') &&
        !relative(legacyAgents, path).split(sep).includes('skills'),
      onFile: async (path) => {
        const file = await addFile(state, {
          path,
          scope: 'project',
          kind: 'agent',
          owner: 'adapter:pi-subagents',
        });
        await markdownResource(state, file, 'agent');
      },
    });
    // Applicable context files are read along cwd ancestry, independent of project .pi trust.
    let dir = ctx.cwd;
    for (let depth = 0; depth < 32; depth++) {
      for (const name of INSTRUCTION_NAMES)
        await addFile(state, {
          path: join(dir, name),
          scope: dir === ctx.cwd ? 'project' : 'ancestor',
          kind: 'instruction',
        });
      const parent = dirname(dir);
      if (parent === dir || dir === ctx.home) break;
      dir = parent;
    }
    // Native portable skills can be discovered in .agents/skills along the cwd ancestry, bounded to home.
    dir = ctx.cwd;
    for (let depth = 0; depth < 32; depth++) {
      const skillDir = join(dir, '.agents', 'skills');
      if (dir !== ctx.home) {
        addRoot(
          skillDir,
          dir === ctx.cwd ? 'project' : 'ancestor',
          'portable-skill-root',
          'portable-skill',
        );
        await scanDirectory(state, skillDir, {
          recursive: true,
          accept: (_p, name) => !name.startsWith('.'),
          onFile: async (path) =>
            registerSkillFile(
              state,
              path,
              dir === ctx.cwd ? 'project' : 'ancestor',
              'portable-skill',
              skillDir,
            ),
        });
      }
      const parent = dirname(dir);
      if (parent === dir || dir === ctx.home || dir === ctx.repoRoot) break;
      dir = parent;
    }
  }

  await buildSettingsResources(state);
  await buildModelResources(state);
  await buildPackageResources(state);
  await inspectPackageManifests(state, global, ctx.mode === 'global' ? [] : [join(ctx.cwd, '.pi')]);
  annotateExtensionProvenance(state);
  await resolveSubagentResources(state);
  await buildCommandCatalog(state);
  await buildMcpResources(state);
  await buildInstructionResources(state);
  detectSkillCollisions(state);
  return {
    getEnvironment() {
      return {
        workspaceId: state.workspaceId,
        workingDirectory: ctx.cwd,
        homeDirectory: ctx.home,
        piBinary: state.pi.executable || undefined,
        piVersion: state.pi.version || undefined,
        agentDirectory: ctx.agentDirectory,
        mode: ctx.mode,
        readOnly: Boolean(ctx.readOnly),
        projectRoot: ctx.mode === 'global' ? undefined : ctx.repoRoot || ctx.cwd,
        trust: ctx.projectTrust,
        capabilities: {
          staticInspection: 'supported',
          runtimeProbe: 'unsupported',
          mutation: 'unsupported',
        },
      };
    },
    getOverview() {
      const counts = {},
        states = { active: 0, shadowed: 0, excluded: 0, untrusted: 0, invalid: 0, unknown: 0 };
      for (const item of state.resources.values()) {
        counts[item.kind] = (counts[item.kind] || 0) + 1;
        states[item.state] = (states[item.state] || 0) + 1;
      }
      const globalDefault = state.settings.global?.defaultModel;
      const projectDefault = state.settings.project?.defaultModel;
      const chosen =
        state.context.projectTrust === 'trusted' && projectDefault
          ? { value: projectDefault, scope: 'project' }
          : globalDefault
            ? { value: globalDefault, scope: 'global' }
            : undefined;
      const source =
        chosen &&
        [...state.files.values()].find(
          (file) => file.entry.kind === 'settings' && file.entry.scope === chosen.scope,
        )?.entry;
      const uncertainProjectOverride =
        state.context.mode !== 'global' &&
        state.context.projectTrust !== 'trusted' &&
        projectDefault !== undefined;
      const chosenSettings =
        chosen?.scope === 'project' && state.context.projectTrust === 'trusted'
          ? state.settings.project
          : state.settings.global;
      const startupModel = chosen
        ? {
            value: safeName(chosen.value),
            provider: chosenSettings?.defaultProvider
              ? safeName(chosenSettings.defaultProvider)
              : undefined,
            sourceScope: chosen.scope,
            sourcePath: source?.displayPath,
            readiness: 'unknown',
            effectiveCertainty: uncertainProjectOverride ? 'unknown' : 'static-source',
            note: 'Startup default only; this is not the model of an already-running Pi session.',
          }
        : { value: null, readiness: 'unknown', effectiveCertainty: 'unknown' };
      return {
        pi: state.pi,
        environment: this.getEnvironment(),
        counts,
        states,
        startupModel,
        diagnostics: state.diagnostics,
        resourceCount: state.resources.size,
        fileCount: state.files.size,
        safeMode: true,
      };
    },
    getResources(kind?: string): Resource[] {
      return [...state.resources.values()]
        .filter((r) => !kind || r.kind === kind)
        .map(({ explanation, ...rest }) => ({ ...rest, explanation }));
    },
    getResource(id: string) {
      return state.resources.get(id) || null;
    },
    getFiles() {
      return [...state.files.values()].map((f) => f.entry);
    },
    getSource(fileId: string) {
      const file = state.files.get(fileId);
      if (!file) return null;
      if (!file.allowContent)
        return {
          ...file.entry,
          content: null,
          redacted: true,
          reason:
            'This source can contain credentials or executable code; only metadata is available.',
        };
      let content = file.raw;
      if (['settings', 'models', 'mcp', 'keybindings'].includes(file.entry.kind)) {
        try {
          content = JSON.stringify(
            redact(
              ['settings', 'models', 'mcp', 'keybindings'].includes(file.entry.kind)
                ? parseJsoncSafe(content)
                : JSON.parse(content),
            ),
            null,
            2,
          );
        } catch {
          return {
            ...file.entry,
            content: null,
            redacted: true,
            reason: 'Invalid structured configuration is not returned to the browser.',
          };
        }
      } else content = scrubString(content);
      return {
        ...file.entry,
        content: content.slice(0, MAX_FILE_BYTES),
        truncated: content.length > MAX_FILE_BYTES,
      };
    },
    getAgentEditor(fileId: string) {
      const candidate = state.agentCandidates.find((entry) => entry.fileId === fileId);
      const file = state.files.get(fileId);
      const resource = candidate && state.resources.get(candidate.resourceId);
      if (!candidate || !file || !resource) return null;
      const supportedFields = [
        'description',
        'advertise',
        'aliases',
        'tools',
        'excludeTools',
        'subagentOnlyExtensions',
        'model',
        'thinking',
        'systemPromptMode',
        'inheritProjectContext',
        'inheritGlobalContext',
        'inheritSkills',
        'skills',
        'output',
        'defaultReads',
        'defaultProgress',
        'async',
        'timeoutMs',
        'toolTimeoutMs',
        'acceptance',
        'acceptanceRole',
        'interactive',
        'maxSubagentDepth',
        'allowNestedSubagents',
        'allowedAgents',
        'memory',
        'launcher',
        'defaultContext',
        'machine',
      ];
      const frontmatter: ConfigRecord = {
        name: redact(candidate.parsed.metadata?.name || '', 'name'),
      };
      for (const key of supportedFields)
        if (Object.hasOwn(candidate.parsed.metadata || {}, key))
          frontmatter[key] = redact(candidate.parsed.metadata[key], key);
      const safeBody = scrubString(candidate.parsed.body || '');
      return {
        fileId,
        versionHash: file.entry.versionHash,
        displayPath: file.entry.displayPath,
        scope: file.entry.scope,
        editable: Boolean(file.entry.editable && resource.adapterCompatibility === 'supported'),
        adapterVersion: resource.adapterVersion || 'unknown',
        adapterCompatibility: resource.adapterCompatibility || 'unknown',
        parseError: candidate.parsed.error || null,
        unknownFields: candidate.parsed.unknownFields || [],
        frontmatter,
        body: safeBody,
        bodyRedacted: safeBody !== (candidate.parsed.body || ''),
        effectiveModel: resource.effectiveModel,
        effectiveThinking: resource.effectiveThinking,
        effectiveFields: resource.effectiveFields,
      };
    },
    getFileForMutation(fileId: string) {
      const file = state.files.get(fileId);
      return file
        ? {
            path: file.path,
            entry: { ...file.entry },
            raw: file.raw,
            allowContent: file.allowContent,
          }
        : null;
    },
    getDiagnostics() {
      return [...state.diagnostics];
    },
    getInstructionSources() {
      return [...state.files.values()]
        .filter((f) => ['instruction', 'system-prompt', 'append-system'].includes(f.entry.kind))
        .map((f) => ({ ...f.entry, effectivePreview: false }));
    },
    getEffectiveInstructions() {
      const values = [...state.files.values()].filter((f) =>
        ['instruction', 'system-prompt', 'append-system'].includes(f.entry.kind),
      );
      const contextFiles = values.filter((f) => f.entry.kind === 'instruction');
      const groups = new Map();
      for (const file of contextFiles) {
        const dir = dirname(file.entry.displayPath);
        const list = groups.get(dir) || [];
        list.push(file);
        groups.set(dir, list);
      }
      const orderedGroups = [...groups.entries()]
        .sort((a, b) => {
          const rank = (scope) => (scope === 'global' ? -1 : 0);
          const aScope = a[1][0].entry.scope,
            bScope = b[1][0].entry.scope;
          return rank(aScope) - rank(bScope) || a[0].length - b[0].length;
        })
        .map(([directory, candidates]) => {
          const override = candidates.find(
            (f) => basename(f.entry.displayPath).toLowerCase() === 'agents.override.md',
          );
          const selection = override ? [override] : candidates.length === 1 ? candidates : [];
          return {
            directory,
            candidates: candidates.map((f) => ({
              fileId: f.entry.id,
              displayPath: f.entry.displayPath,
              name: basename(f.entry.displayPath),
            })),
            selectedFileIds: selection.map((f) => f.entry.id),
            ambiguity: !override && candidates.length > 1,
          };
        });
      const promptCandidates = (kind) =>
        values
          .filter((f) => f.entry.kind === kind)
          .map((f) => ({
            fileId: f.entry.id,
            displayPath: f.entry.displayPath,
            scope: f.entry.scope,
            conditionalTrust:
              f.entry.scope === 'project' ? state.context.projectTrust : 'not_applicable',
          }));
      const selectedContexts = orderedGroups
        .flatMap((group) => group.selectedFileIds.map((id) => state.files.get(id)))
        .filter(Boolean);
      const content = selectedContexts
        .map(
          (file) =>
            `<!-- ${file.entry.displayPath} -->\n${this.getSource(file.entry.id)?.content || ''}`,
        )
        .join('\n\n');
      return {
        label: 'Source-based approximation; not a runtime prompt',
        runtimeParity: false,
        contextGroups: orderedGroups,
        contextPreview: content,
        systemPromptCandidates: promptCandidates('system-prompt'),
        appendedPromptCandidates: promptCandidates('append-system'),
        diagnostics: [
          'Ambiguous same-directory context candidates are not guessed.',
          `Project trust is ${state.context.projectTrust}; runtime-loaded extension contributions are unknown.`,
        ],
      };
    },
    async getWatchTargets() {
      const targets = new Set([...state.files.values()].map((file) => file.path));
      const watchKinds = new Set([
        'skill-root',
        'command-root',
        'agent-root',
        'extension-root',
        'portable-skill-root',
      ]);
      for (const root of state.roots)
        if (watchKinds.has(root.kind)) {
          try {
            const info = await lstat(root.path);
            if (info.isDirectory() && !info.isSymbolicLink())
              targets.add(await realpath(root.path));
          } catch {}
        }
      return [...targets];
    },
    getContext() {
      return { ...ctx };
    },
  };
}

async function skillResource(state: InventoryState, file) {
  if (!file) return;
  const parsed = parseFrontmatter(state.files.get(file.id).raw);
  const meta = parsed.metadata || {};
  const ds = [];
  if (parsed.error)
    ds.push(diagnostic('SKILL_INVALID', 'error', 'Skill frontmatter is invalid YAML.', file.id));
  if (!meta.name)
    ds.push(
      diagnostic(
        'SKILL_NAME_MISSING',
        'warning',
        'Skill frontmatter must declare a name.',
        file.id,
      ),
    );
  if (!meta.description)
    ds.push(
      diagnostic(
        'SKILL_DESCRIPTION_MISSING',
        'warning',
        'Skill frontmatter must declare a description.',
        file.id,
      ),
    );
  if (
    typeof meta.name === 'string' &&
    (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(meta.name) || meta.name.length > 64)
  )
    ds.push(
      diagnostic(
        'SKILL_NAME_INVALID',
        'error',
        'Skill name must use lowercase letters, numbers, and hyphens and be at most 64 characters.',
        file.id,
      ),
    );
  if (typeof meta.description === 'string' && meta.description.length > 1024)
    ds.push(
      diagnostic(
        'SKILL_DESCRIPTION_TOO_LONG',
        'warning',
        `Skill “${safeName(meta.name)}” has a ${meta.description.length.toLocaleString()}-character description (~${Math.ceil(meta.description.length / 4).toLocaleString()} tokens). It exceeds the 1,024-character portability guideline; prefer a short routing summary and move detailed guidance into instructions or references.`,
        file.id,
      ),
    );
  if (typeof meta.name === 'string' && meta.name !== basename(dirname(file.displayPath)))
    ds.push(
      diagnostic(
        'SKILL_DIRECTORY_NAME_MISMATCH',
        'warning',
        'Portable skill directory name differs from its frontmatter name.',
        file.id,
      ),
    );
  const descriptionCharacters = typeof meta.description === 'string' ? meta.description.length : 0;
  const manualOnly = meta['disable-model-invocation'] === true;
  if (descriptionCharacters > 256 && descriptionCharacters <= 1024)
    ds.push(
      diagnostic(
        'SKILL_CONTEXT_DESCRIPTION_VERBOSE',
        'warning',
        `Skill “${safeName(meta.name)}” advertises a verbose ${descriptionCharacters}-character description (~${Math.ceil(descriptionCharacters / 4)} tokens). Consider moving detail into its on-demand instructions or references.`,
        file.id,
      ),
    );
  state.diagnostics.push(...ds);
  const skill = addResource(
    state,
    {
      kind: 'skill',
      name: meta.name || basename(dirname(file.displayPath)),
      description: meta.description || '',
      state: parsed.error ? 'invalid' : 'unknown',
      diagnostics: ds,
      details: {
        frontmatterValid: !parsed.error,
        descriptionFull:
          typeof meta.description === 'string'
            ? String(redact(meta.description)).slice(0, 8192)
            : '',
        contextFootprint: {
          descriptionCharacters,
          approximateUnits: Math.ceil(descriptionCharacters / 4),
          manifestCharacters: state.files.get(file.id).raw.length,
          manualOnly,
          descriptionTruncated: descriptionCharacters > 8192,
        },
      },
    },
    file,
  );
  addResource(
    state,
    {
      kind: 'command',
      name: `skill:${skill.name}`,
      description:
        'Skill command; invocation behavior depends on the installed Pi version and skill discovery state.',
      state: skill.state,
      owner: 'pi-core',
      details: { commandType: 'skill', skillResourceId: skill.id },
    },
    file,
  );
  return skill;
}
async function registerSkillFile(state: InventoryState, path, scope, owner, scanRoot) {
  const canonical = resolve(path);
  const existing = [...state.files.values()].find((file) => resolve(file.path) === canonical);
  if (existing) return existing.entry;
  if (basename(path) === 'SKILL.md') {
    const manifest = await addFile(state, { path, scope, kind: 'skill', owner });
    return skillResource(state, manifest);
  }
  let directory = dirname(path);
  let manifestPath;
  while (inside(resolve(scanRoot), resolve(directory))) {
    try {
      const info = await lstat(join(directory, 'SKILL.md'));
      if (info.isFile() && !info.isSymbolicLink()) {
        manifestPath = join(directory, 'SKILL.md');
        break;
      }
    } catch {}
    if (resolve(directory) === resolve(scanRoot)) break;
    directory = dirname(directory);
  }
  if (!manifestPath) return null;
  const manifestRecord = [...state.files.values()].find(
    (file) => resolve(file.path) === resolve(manifestPath),
  );
  let manifest = manifestRecord?.entry;
  if (!manifest) {
    manifest = await addFile(state, { path: manifestPath, scope, kind: 'skill', owner });
    if (!manifest) return null;
    await skillResource(state, manifest);
  }
  let skill = [...state.resources.values()].find(
    (resource) => resource.kind === 'skill' && resource.source?.fileId === manifest.id,
  );
  if (!skill) skill = await skillResource(state, manifest);
  return addFile(state, {
    path,
    scope,
    kind: 'skill-asset',
    owner,
    metadata: { skillName: skill?.name || 'unknown', skillManifestId: manifest.id },
  });
}
async function markdownResource(state: InventoryState, file, kind) {
  if (!file) return;
  if (kind === 'agent') {
    const parsed = parseAgentDefinition(state.files.get(file.id).raw);
    const name = String(parsed.metadata?.name || basename(file.displayPath, '.md')).trim();
    const canonicalName = parsed.metadata?.package ? `${parsed.metadata.package}.${name}` : name;
    const resource = addResource(
      state,
      {
        kind: 'agent',
        name: canonicalName,
        description: parsed.metadata?.description || '',
        owner: 'adapter:pi-subagents',
        state: 'unknown',
        diagnostics: parsed.error
          ? [
              diagnostic(
                'AGENT_FRONTMATTER_INVALID',
                'error',
                'Agent frontmatter is invalid YAML.',
                file.id,
              ),
            ]
          : [],
        details: {
          adapter: 'pi-subagents',
          adapterDetected: false,
          candidateOnly: true,
          unknownFields: parsed.unknownFields,
          adapterFields: Object.fromEntries(
            [
              'model',
              'thinking',
              'tools',
              'systemPromptMode',
              'inheritProjectContext',
              'inheritGlobalContext',
              'inheritSkills',
            ]
              .filter((key) => parsed.metadata?.[key] !== undefined)
              .map((key) => [key, redact(parsed.metadata[key], key)]),
          ),
        },
      },
      file,
    );
    state.agentCandidates.push({
      resourceId: resource.id,
      fileId: file.id,
      scope: file.scope,
      owner: file.owner,
      path: file.displayPath,
      parsed,
    });
    return;
  }
  const parsed = parseFrontmatter(state.files.get(file.id).raw);
  addResource(
    state,
    {
      kind: 'command',
      name: basename(file.displayPath, '.md'),
      description: parsed.metadata?.description || '',
      state: parsed.error ? 'invalid' : 'unknown',
      diagnostics: parsed.error
        ? [
            diagnostic(
              'TEMPLATE_FRONTMATTER_INVALID',
              'error',
              'Prompt-template frontmatter is invalid YAML.',
              file.id,
            ),
          ]
        : [],
      owner: 'pi-core',
      details: { commandType: 'prompt-template' },
    },
    file,
  );
}
async function buildSettingsResources(state: InventoryState) {
  for (const file of state.files.values())
    if (file.entry.kind === 'settings') {
      const parsed = state.settings[file.entry.scope];
      if (!parsed) continue;
      for (const [name, value] of Object.entries(parsed)) {
        if (SENSITIVE_KEY.test(name)) continue;
        addResource(
          state,
          {
            kind: 'setting',
            name,
            description: 'Pi setting',
            state: file.entry.scope === 'global' ? 'unknown' : 'unknown',
            details: {
              value: redact(value, name),
              sourceScope: file.entry.scope,
              settingType: Array.isArray(value) ? 'array' : typeof value,
            },
          },
          file.entry,
        );
      }
    }
}
async function buildModelResources(state: InventoryState) {
  for (const file of state.files.values())
    if (file.entry.kind === 'models') {
      const data = state.settings.modelsByScope[file.entry.scope];
      const providers = data?.providers;
      if (!providers || typeof providers !== 'object') continue;
      for (const [provider, config] of Object.entries<ConfigRecord>(providers)) {
        addResource(
          state,
          {
            kind: 'provider',
            name: provider,
            state: 'unknown',
            description: config?.name || 'Configured provider; credentials not checked.',
            details: {
              readiness: 'unknown',
              configScope: file.entry.scope,
              baseUrl: config?.baseUrl ? safeEndpointOrigin(config.baseUrl) : undefined,
            },
          },
          file.entry,
        );
        for (const model of Array.isArray(config?.models) ? config.models : []) {
          addResource(
            state,
            {
              kind: 'model',
              name: `${provider}/${model.id || model.name || 'unknown'}`,
              state: 'unknown',
              description: model.name || '',
              details: {
                provider,
                modelId: model.id || model.name,
                catalogOrigin: 'custom',
                readiness: 'unknown',
                capabilities: {
                  reasoning: model.reasoning ?? 'unknown',
                  input: model.input || ['text'],
                  contextTokens: model.contextWindow,
                  outputTokens: model.maxTokens,
                  cost: model.cost ? redact(model.cost) : undefined,
                },
              },
            },
            file.entry,
          );
        }
      }
    }
  if (![...state.files.values()].some((f) => f.entry.kind === 'models'))
    state.diagnostics.push(
      diagnostic(
        'MODEL_CATALOG_UNAVAILABLE',
        'info',
        'No static models.json was found. Bundled and extension-registered catalogs are not loaded in safe mode.',
      ),
    );
  else
    state.diagnostics.push(
      diagnostic(
        'MODEL_CATALOG_STATIC_ONLY',
        'info',
        'Configured models are shown as declarations only; bundled catalog and credential readiness are not probed.',
      ),
    );
}
async function buildPackageResources(state: InventoryState) {
  for (const file of state.files.values())
    if (file.entry.kind === 'settings') {
      const settings = state.settings[file.entry.scope];
      if (!settings) continue;
      const packages = normalizeSettings(settings.packages);
      for (const source of packages)
        addResource(
          state,
          {
            kind: 'package',
            name: source,
            state: 'unknown',
            description: 'Declared package; no install, update, or code execution performed.',
            details: {
              configScope: file.entry.scope,
              packageSource: source,
              installationOrigin: 'user',
            },
          },
          file.entry,
        );
    }
}
async function inspectPackageManifests(state: InventoryState, global, projectRoots) {
  const roots = [
    [join(global, 'npm'), 'global'],
    [join(global, 'git'), 'global'],
    ...projectRoots.flatMap((root) => [
      [join(root, 'npm'), 'project'],
      [join(root, 'git'), 'project'],
    ]),
  ];
  const inspected = new Set<string>();
  const inspectManifest = async (path: string, scope: string) => {
    if (inspected.has(resolve(path))) return;
    inspected.add(resolve(path));
    const file = await addFile(state, {
      path,
      scope,
      kind: 'package-manifest',
      allowContent: false,
      owner: 'pi-package',
    });
    if (!file) return;
    try {
      const manifest = JSON.parse(state.files.get(file.id).raw);
      const packageName = manifest.name || basename(dirname(path));
      const packageRoot = dirname(path);
      addResource(
        state,
        {
          kind: 'package',
          name: packageName,
          description: 'Installed package manifest; code was not loaded.',
          state: 'unknown',
          owner: 'pi-package',
          details: {
            installed: true,
            version: manifest.version || 'unknown',
            declaredPiResources: Boolean(manifest.pi),
          },
        },
        file,
      );
      const relativeRoots = (values) =>
        (Array.isArray(values) ? values : [])
          .filter((value) => typeof value === 'string' && !isAbsolute(value))
          .map((value) => resolve(packageRoot, value))
          .filter((value) => inside(packageRoot, value));
      const declarations = [
        ...(Array.isArray(manifest['pi-subagents']?.agents) ? manifest['pi-subagents'].agents : []),
        ...(Array.isArray(manifest.pi?.subagents?.agents) ? manifest.pi.subagents.agents : []),
      ];
      const agentRoots = relativeRoots(declarations);
      if (/pi-subagents$/i.test(packageName)) agentRoots.push(join(packageRoot, 'agents'));
      const declaredExtensions = Array.isArray(manifest.pi?.extensions)
        ? manifest.pi.extensions
        : [];
      for (const entry of declaredExtensions.filter((value) => typeof value === 'string'))
        addResource(
          state,
          {
            kind: 'extension',
            name: `${packageName}/${entry}`,
            description: 'Package-declared extension; code was not loaded.',
            state: 'unknown',
            owner: 'pi-package',
            details: {
              metadataOnly: true,
              packageName,
              version: manifest.version || 'unknown',
              entryPointCandidate: true,
              entryPointLayout: 'package manifest pi.extensions',
            },
          },
          file,
        );
      if (declaredExtensions.length)
        addResource(
          state,
          {
            kind: 'command',
            name: `${packageName} commands (runtime-dependent)`,
            description:
              'Extensions may register commands; registrations are not enumerated without loading code.',
            state: 'unknown',
            owner: 'pi-package',
            details: { commandType: 'extension-runtime', packageName },
          },
          file,
        );
      for (const skillRoot of relativeRoots(manifest.pi?.skills))
        await scanDirectory(state, skillRoot, {
          recursive: true,
          accept: (_path, name) => name === 'SKILL.md',
          onFile: async (skillPath) => {
            const skillFile = await addFile(state, {
              path: skillPath,
              scope,
              kind: 'skill',
              owner: 'pi-package',
              metadata: { packageName },
            });
            await skillResource(state, skillFile);
          },
        });
      for (const promptRoot of relativeRoots(manifest.pi?.prompts))
        await scanDirectory(state, promptRoot, {
          recursive: false,
          accept: (_path, name, depth) => depth === 0 && extname(name).toLowerCase() === '.md',
          onFile: async (promptPath) => {
            const promptFile = await addFile(state, {
              path: promptPath,
              scope,
              kind: 'command',
              owner: 'pi-package',
              metadata: { packageName },
            });
            await markdownResource(state, promptFile, 'command');
          },
        });
      for (const agentRoot of new Set(agentRoots)) {
        await scanDirectory(state, agentRoot, {
          recursive: true,
          accept: (_path, name) =>
            extname(name).toLowerCase() === '.md' && !name.endsWith('.chain.md'),
          onFile: async (agentPath) => {
            const agentFile = await addFile(state, {
              path: agentPath,
              scope,
              kind: 'agent',
              owner: 'adapter:pi-subagents',
              metadata: { packageName },
            });
            await markdownResource(state, agentFile, 'agent');
          },
        });
      }
      if (/pi-subagents$/i.test(packageName) && manifest.version !== TESTED_PI_SUBAGENTS_VERSION)
        state.diagnostics.push(
          diagnostic(
            'AGENT_ADAPTER_VERSION_UNVERIFIED',
            'info',
            `Found pi-subagents ${manifest.version || 'unknown'}; adapter semantics are only enabled for ${TESTED_PI_SUBAGENTS_VERSION}.`,
            file.id,
          ),
        );
    } catch {
      state.diagnostics.push(
        diagnostic(
          'INVALID_PACKAGE_MANIFEST',
          'warning',
          'Package manifest is invalid JSON.',
          file.id,
        ),
      );
    }
  };
  // Inspect declared npm roots first, before bounded dependency traversal can
  // exhaust its limit. Do not import or execute any package to identify it.
  const declarations = [...state.resources.values()]
    .filter((item) => item.kind === 'package' && item.packageSource)
    .slice(0, MAX_FILES_PER_ROOT);
  for (const declaration of declarations) {
    const npm = /^npm:((?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+)(?:@[A-Za-z0-9._-]+)?$/.exec(
      declaration.packageSource,
    );
    if (!npm) continue;
    const base = declaration.scope === 'global' ? global : join(state.context.cwd, '.pi');
    const root = join(base, 'npm', 'node_modules');
    const path = resolve(root, npm[1], 'package.json');
    if (inside(root, path) && !(await hasSymlinkComponent(path).catch(() => true))) {
      await inspectManifest(path, declaration.scope);
    }
  }
  for (const [root, scope] of roots)
    await scanDirectory(state, root, {
      recursive: true,
      includeNodeModules: true,
      accept: (_path, name) => name === 'package.json',
      onFile: (path) => inspectManifest(path, scope),
    });
}
function annotateExtensionProvenance(state: InventoryState) {
  const resources = [...state.resources.values()];
  const declarations = resources.filter((item) => item.kind === 'package' && item.packageSource);
  const managedRoots: { root: string; declaration: Resource }[] = [];
  for (const item of resources.filter(
    (candidate) => candidate.kind === 'package' && candidate.installed,
  )) {
    const path = state.files.get(item.source?.fileId)?.path;
    const declaration = declarations.find((candidate) => {
      if (candidate.scope !== item.scope || !path) return false;
      const npm = /^npm:((?:@[^/]+\/)?[^@]+)(?:@[^@]+)?$/.exec(candidate.packageSource);
      if (!npm || npm[1] !== item.name) return false;
      const base =
        candidate.scope === 'global'
          ? state.context.agentDirectory
          : join(state.context.cwd, '.pi');
      return resolve(path) === resolve(base, 'npm', 'node_modules', npm[1], 'package.json');
    });
    item.installationOrigin = declaration ? 'user' : 'unattributed';
    if (declaration) {
      item.packageSource = declaration.packageSource;
      item.configScope = declaration.scope;
      declaration.installed = false; // This row is a settings declaration, not a second installation.
      declaration.installationVerified = true;
      declaration.version = item.version;
      managedRoots.push({ root: dirname(path), declaration });
    }
  }
  for (const item of resources.filter((candidate) => candidate.kind === 'extension')) {
    if (['local-extension', 'configured-extension-path'].includes(item.owner)) {
      item.installationOrigin = 'user';
      continue;
    }
    const path = state.files.get(item.source?.fileId)?.path;
    const managed = path && managedRoots.find((entry) => inside(entry.root, path));
    // Only exact package-root entry manifests are attributed. A nested dependency's
    // code is not a separately user-installed extension.
    if (managed && dirname(path) === managed.root) {
      item.installationOrigin = 'user';
      item.packageSource = managed.declaration.packageSource;
      item.configScope = managed.declaration.scope;
      item.installationVerified = true;
    } else item.installationOrigin = 'unattributed';
  }
  if (state.pi.version === TESTED_PI_VERSION) {
    for (const name of TESTED_BUILTIN_EXTENSIONS)
      addResource(state, {
        kind: 'extension',
        name: `builtin:${name}`,
        scope: 'builtin',
        owner: 'pi-default',
        state: 'unknown',
        description: `Bundled with Pi ${TESTED_PI_VERSION}. Enabled state and runtime registration are not verified.`,
        details: {
          installationOrigin: 'pi-default',
          version: TESTED_PI_VERSION,
          metadataOnly: true,
        },
      });
  }
}
async function buildMcpResources(state: InventoryState) {
  const scopes: Record<
    string,
    { servers: Record<string, ConfigRecord>; file?: FileEntry; legacy: boolean }
  > = {};
  for (const [scope, config] of Object.entries(state.settings.mcpByScope)) {
    const servers = config?.mcpServers || config?.servers || {};
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) continue;
    scopes[scope] = {
      servers,
      file: [...state.files.values()].find((f) => f.entry.kind === 'mcp' && f.entry.scope === scope)
        ?.entry,
      legacy: Boolean(config?.servers && !config?.mcpServers),
    };
  }
  const globalServers = scopes.global?.servers || {};
  const projectServers = scopes.project?.servers || {};
  const policyFields = new Set(['enabled', 'exposure', 'toolExposure']);
  const isPolicyOnly = (value) =>
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length > 0 &&
    Object.keys(value).every((key) => policyFields.has(key));
  for (const [scope, config] of Object.entries(scopes))
    for (const [name, definition] of Object.entries(config.servers)) {
      const projectOverride = scope === 'global' ? projectServers[name] : undefined;
      const policyOverride =
        projectOverride && isPolicyOnly(projectOverride) ? projectOverride : undefined;
      const replaced = scope === 'global' && projectOverride && !policyOverride;
      const mergePolicy = (connection, policy) => ({
        ...connection,
        ...policy,
        toolExposure: { ...(connection?.toolExposure || {}), ...(policy?.toolExposure || {}) },
      });
      const effective =
        scope === 'global'
          ? mergePolicy(definition, policyOverride || {})
          : scope === 'project' && isPolicyOnly(definition)
            ? mergePolicy(globalServers[name] || {}, definition)
            : definition;
      const effectiveConnection =
        scope === 'project' && isPolicyOnly(definition)
          ? globalServers[name] || definition
          : definition;
      const transport = effectiveConnection?.url
        ? 'http'
        : effectiveConnection?.command
          ? 'stdio'
          : 'unknown';
      const file = config.file;
      addResource(
        state,
        {
          kind: 'mcp',
          name,
          state: replaced ? 'shadowed' : effective.enabled === false ? 'excluded' : 'unknown',
          description: `Declared ${transport} server; no connection made.`,
          details: {
            transport,
            sourceScope: scope,
            effectiveSourceScope:
              scope === 'project' && isPolicyOnly(definition) && globalServers[name]
                ? 'global'
                : scope,
            enabled: effective?.enabled ?? 'unknown',
            exposure: effective?.exposure ?? 'unknown',
            timeout: Number.isFinite(effective?.timeout) ? effective.timeout : 'unknown',
            environmentVariableNames:
              effectiveConnection?.env &&
              typeof effectiveConnection.env === 'object' &&
              !Array.isArray(effectiveConnection.env)
                ? Object.keys(effectiveConnection.env).map(safeName)
                : [],
            toolExposure:
              effective?.toolExposure &&
              typeof effective.toolExposure === 'object' &&
              !Array.isArray(effective.toolExposure)
                ? Object.fromEntries(
                    Object.entries(effective.toolExposure)
                      .slice(0, 100)
                      .map(([tool, exposure]) => [safeName(tool), safeName(exposure)]),
                  )
                : {},
            policyOverride: Boolean(
              policyOverride || (scope === 'project' && isPolicyOnly(definition)),
            ),
            overriddenGlobal: Boolean(replaced),
            legacySchema: config.legacy,
            credentialValuesAvailable: false,
          },
        },
        file,
      );
    }
}
function resolveSubagentResources(state: InventoryState) {
  const packageResources = [...state.resources.values()].filter((item) => item.kind === 'package');
  const installedAdapters = packageResources.filter(
    (item) => item.installed && /(^|\/)pi-subagents$/i.test(item.name),
  );
  const isDeclared = (scope) =>
    packageResources.some(
      (item) => !item.installed && item.scope === scope && /pi-subagents/i.test(item.name),
    );
  const projectTrusted = state.context.projectTrust === 'trusted';
  const userSettings = state.settings.global || {};
  const projectSettings = projectTrusted ? state.settings.project || {} : {};
  const trustedProjectDecl = projectTrusted && isDeclared('project');
  const globalDecl = isDeclared('global');
  const versionFor = (candidate) => {
    const packageName = state.files.get(candidate.fileId)?.entry.packageName;
    const pkg =
      packageName &&
      installedAdapters.find((item) => item.name === packageName && item.scope === candidate.scope);
    const selected =
      pkg ||
      (candidate.scope === 'project' && trustedProjectDecl
        ? installedAdapters.find((item) => item.scope === 'project')
        : undefined) ||
      installedAdapters.find((item) => item.scope === 'global');
    const declared = candidate.scope === 'project' ? trustedProjectDecl || globalDecl : globalDecl;
    return declared ? selected?.version || null : null;
  };
  const adapterUsable =
    installedAdapters.some((item) => item.scope === 'global' && globalDecl) ||
    (trustedProjectDecl && installedAdapters.some((item) => item.scope === 'project'));
  for (const candidate of state.agentCandidates) {
    const resource = state.resources.get(candidate.resourceId);
    if (!resource) continue;
    const version = versionFor(candidate);
    const selectedAdapter = adapterRegistry.resolve('pi-subagents', adapterUsable ? version : null);
    const resolved = selectedAdapter.adapter.resolve(candidate.parsed, {
      userSettings,
      projectSettings,
      trust: state.context.projectTrust,
      scope: candidate.scope,
      adapterVersion: selectedAdapter.compatibility === 'supported' ? version : null,
    });
    resource.adapterDetected = adapterUsable;
    resource.adapterVersion = resolved.adapter.version;
    resource.adapterCompatibility = resolved.adapter.compatibility;
    resource.candidateOnly = !resolved.adapter.tested;
    const agentFile = state.files.get(candidate.fileId);
    if (agentFile)
      agentFile.entry.editable =
        resolved.adapter.tested &&
        Boolean(adapterUsable) &&
        !agentFile.entry.packageName &&
        !['package', 'ancestor'].includes(agentFile.entry.scope);
    resource.canonicalName = resolved.canonicalName;
    resource.effectiveModel = resolved.model;
    resource.effectiveThinking = resolved.thinking;
    resource.effectiveFields = Object.fromEntries(
      Object.entries<ConfigRecord>(resolved.effectiveFields).map(([key, value]) => [
        key,
        { ...value, value: redact(value.value, key) },
      ]),
    );
    resource.unknownFields = resolved.unknownFields;
    if (resolved.state === 'untrusted') resource.state = 'untrusted';
    if (!adapterUsable)
      resource.diagnostics.push(
        diagnostic(
          'AGENT_ADAPTER_MISSING',
          'info',
          'Candidate Markdown file; no declared and installed pi-subagents package was confirmed.',
          candidate.fileId,
        ),
      );
    else if (!resolved.adapter.tested)
      resource.diagnostics.push(
        diagnostic(
          'UNSUPPORTED_ADAPTER_VERSION',
          'info',
          `pi-subagents ${version || 'unknown'} is not in the tested version set (${TESTED_PI_SUBAGENTS_VERSION}).`,
          candidate.fileId,
        ),
      );
    for (const message of resolved.diagnostics)
      resource.diagnostics.push(
        diagnostic('AGENT_ADAPTER_NOTE', 'info', message, candidate.fileId),
      );
    if (resolved.unknownFields.length)
      resource.diagnostics.push(
        diagnostic(
          'AGENT_UNKNOWN_FIELDS',
          'info',
          `Unmodeled frontmatter fields are preserved in the source: ${resolved.unknownFields.join(', ')}.`,
          candidate.fileId,
        ),
      );
    const scopeSetting =
      state.context.projectTrust === 'trusted' &&
      state.settings.project?.subagents?.agentScope !== undefined
        ? state.settings.project.subagents.agentScope
        : state.settings.global?.subagents?.agentScope;
    if (
      resolved.adapter.tested &&
      (resolved.effectiveFields.disabled?.value === true ||
        (scopeSetting === 'user' && candidate.scope === 'project') ||
        (scopeSetting === 'project' && candidate.scope === 'global'))
    )
      resource.state = 'excluded';
  }
  // Resolve only collisions covered by the tested adapter's documented fixed-path precedence.
  if (adapterUsable && state.context.projectTrust === 'trusted') {
    const byName = new Map();
    for (const candidate of state.agentCandidates) {
      const resource = state.resources.get(candidate.resourceId);
      if (resource?.adapterCompatibility !== 'supported' || resource.state === 'excluded') continue;
      const list = byName.get(resource.name) || [];
      list.push(candidate);
      byName.set(resource.name, list);
    }
    for (const candidates of byName.values())
      if (candidates.length > 1) {
        const priority = (candidate) =>
          state.files.get(candidate.fileId)?.entry.packageName
            ? 0
            : candidate.path.includes(`${sep}.pi${sep}agents${sep}`)
              ? 3
              : candidate.path.includes(`${sep}.agents${sep}`)
                ? 2
                : candidate.scope === 'global'
                  ? 1
                  : 0;
        candidates.sort((a, b) => priority(b) - priority(a));
        for (const loser of candidates.slice(1)) {
          const resource = state.resources.get(loser.resourceId);
          resource.state = 'shadowed';
          resource.diagnostics.push(
            diagnostic(
              'AGENT_SHADOWED',
              'info',
              `A higher-priority definition of ${resource.name} is present.`,
              loser.fileId,
            ),
          );
        }
      }
  }
}
function buildCommandCatalog(state: InventoryState) {
  if (!state.pi.detected) return;
  for (const name of ['/model', '/settings', '/reload'])
    addResource(state, {
      kind: 'command',
      name,
      description:
        'Pi built-in command documented by the current specification; exact availability is not runtime-probed.',
      state: 'unknown',
      owner: 'pi-core',
      details: { commandType: 'builtin', runtimeVerified: false },
    });
  state.diagnostics.push(
    diagnostic(
      'COMMAND_CATALOG_PARTIAL',
      'info',
      'Only documented built-in command examples, file-backed prompt templates, skill commands, and package runtime-dependent command notices are listed; arbitrary extension commands are not executed to enumerate them.',
    ),
  );
}
function detectSkillCollisions(state: InventoryState) {
  const byName = new Map();
  for (const item of state.resources.values())
    if (item.kind === 'skill') {
      const key = item.name.toLowerCase();
      const values = byName.get(key) || [];
      values.push(item);
      byName.set(key, values);
    }
  for (const values of byName.values())
    if (values.length > 1) {
      for (const item of values)
        item.diagnostics.push(
          diagnostic(
            'SKILL_COLLISION',
            'warning',
            'Multiple skill sources declare this name; the winning runtime source is not established in safe mode.',
            item.source?.fileId,
          ),
        );
    }
}
async function buildInstructionResources(state: InventoryState) {
  const instructions = [...state.files.values()].filter((f) =>
    ['instruction', 'system-prompt', 'append-system'].includes(f.entry.kind),
  );
  for (const source of instructions) {
    const name = basename(source.entry.displayPath);
    addResource(
      state,
      {
        kind: 'instruction',
        name,
        description: source.entry.kind,
        state: 'unknown',
        details: { instructionType: source.entry.kind, assembly: 'static-candidate' },
      },
      source.entry,
    );
  }
  const systemFiles = instructions.filter((f) =>
    ['system-prompt', 'append-system'].includes(f.entry.kind),
  );
  for (const file of systemFiles) {
    if (file.entry.scope === 'project' && state.context.projectTrust === 'unknown')
      file.entry.trust = 'unknown';
  }
}
