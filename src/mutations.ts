import { createHash, randomUUID } from 'node:crypto';
import type { GetDiscovery, ManagerContext, PreparedEdit, TransactionJournal } from './types.js';
import {
  mkdir,
  lstat,
  readFile,
  readdir,
  realpath,
  rename,
  unlink,
  open,
  stat,
} from 'node:fs/promises';
import { dirname, basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { createTwoFilesPatch } from 'diff';
import {
  parse as parseJson,
  parseTree as parseJsonTree,
  getNodeValue,
  modify as modifyJson,
  applyEdits as applyJsonEdits,
  printParseErrorCode,
} from 'jsonc-parser';
import { z } from 'zod';
import YAML from 'yaml';
import {
  parseAgentDefinition,
  PI_SUBAGENTS_EDITOR_FIELDS,
  TESTED_PI_SUBAGENTS_VERSION,
} from './adapters/pi-subagents.js';
import { authorizePath } from './filesystem.js';
import { TESTED_PI_VERSION } from './pi-compat.js';

const MAX_BYTES = 512 * 1024;
const MAX_EDITS = 50;
const EXTENSION_CODE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.tsx']);
const HASH = /^[a-f0-9]{64}$/;
const SENSITIVE_KEY =
  /(api.?key|secret|token|password|authorization|credential|private.?key|client.?secret|access.?key)/i;
const SECRET_PATTERN =
  /\b(?:sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._~-]{16,})\b|https?:\/\/[^/@\s]+:[^/@\s]+@[^\s]+|[?&](?:api[_-]?key|token|secret|password)=/i;
const SENSITIVE_LINE =
  /^\s*(?:api[_-]?key|secret|token|password|authorization|credential|private[_-]?key|client[_-]?secret|access[_-]?key)\s*[:=]\s*\S/im;
const ROOT_NAMES = new Set([
  'AGENTS.md',
  'AGENTS.override.md',
  'AGENTS.MD',
  'CLAUDE.md',
  'CLAUDE.MD',
]);
const createTargetSchema = z
  .object({
    scope: z.enum(['global', 'project', 'portable', 'portable-project']),
    kind: z.enum([
      'instruction',
      'system-prompt',
      'append-system',
      'skill',
      'skill-import-file',
      'agent',
      'command',
      'models-config',
      'mcp-config',
      'keybindings-config',
    ]),
    basename: z.string().min(1).max(240),
  })
  .strict();
const modelSchema = z
  .object({
    id: z.string().min(1).max(160),
    name: z.string().min(1).max(160),
    reasoning: z.boolean().optional(),
    input: z
      .array(z.enum(['text', 'image']))
      .max(2)
      .optional(),
    contextWindow: z.number().int().positive().max(10_000_000).optional(),
    maxTokens: z.number().int().positive().max(1_000_000).optional(),
    cost: z
      .object({
        input: z.number().nonnegative(),
        output: z.number().nonnegative(),
        cacheRead: z.number().nonnegative(),
        cacheWrite: z.number().nonnegative(),
      })
      .strict()
      .optional(),
  })
  .strict();
const providerSchema = z
  .object({
    operation: z.enum(['upsert', 'remove']),
    providerId: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
    name: z.string().min(1).max(100).optional(),
    baseUrl: z.string().url().max(500).optional(),
    api: z
      .enum([
        'openai-completions',
        'openai-responses',
        'anthropic-messages',
        'google-generative-ai',
      ])
      .optional(),
    model: modelSchema.optional(),
  })
  .strict();
const mcpSchema = z
  .object({
    operation: z.enum(['upsert', 'policy', 'remove']),
    serverName: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    transport: z.enum(['stdio', 'http']).optional(),
    url: z.string().url().max(2048).optional(),
    command: z.string().min(1).max(512).optional(),
    args: z.array(z.string().max(512)).max(100).optional(),
    envNames: z
      .array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/))
      .max(50)
      .optional(),
    enabled: z.boolean().optional(),
    exposure: z.enum(['codemode', 'deferred', 'direct', 'hidden']).optional(),
    timeout: z.number().int().positive().max(3600).optional(),
    description: z.string().max(500).optional(),
    toolExposure: z
      .record(z.string(), z.enum(['codemode', 'deferred', 'direct', 'hidden']))
      .optional(),
  })
  .strict();
const keybindingSchema = z
  .object({
    action: z.string().regex(/^[A-Za-z0-9_.-]{1,160}$/),
    bindings: z.array(z.string().max(64)).max(20).optional(),
    reset: z.boolean().optional(),
  })
  .strict();
const presetChangesSchema = z
  .array(z.object({ path: z.array(z.string()).min(1).max(4), value: z.unknown() }).strict())
  .min(1)
  .max(40);
const agentEditSchema = z
  .object({
    fields: z.record(z.string().max(64), z.unknown()).optional(),
    body: z.string().max(MAX_BYTES).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value.fields || {}).length > 0 || value.body !== undefined, {
    message: 'Agent edit must change a supported field or prompt body.',
  });
const editSchema = z.union([
  z
    .object({
      intent: z.enum(['update', 'delete']),
      fileId: z.string().uuid(),
      expectedHash: z.string().regex(HASH),
      content: z.string().max(MAX_BYTES).optional(),
    })
    .strict()
    .refine((edit) => edit.intent !== 'update' || edit.content !== undefined, {
      message: 'Update requires content.',
    })
    .refine((edit) => edit.intent !== 'delete' || edit.content === undefined, {
      message: 'Delete cannot include content.',
    }),
  z
    .object({
      intent: z.literal('create'),
      createTarget: createTargetSchema,
      content: z.string().max(MAX_BYTES),
    })
    .strict(),
  z
    .object({
      intent: z.literal('set-setting'),
      fileId: z.string().uuid(),
      expectedHash: z.string().regex(HASH),
      path: z.array(z.string()).min(1).max(4),
      value: z.unknown(),
    })
    .strict(),
  z
    .object({
      intent: z.literal('set-settings'),
      fileId: z.string().uuid(),
      expectedHash: z.string().regex(HASH),
      changes: presetChangesSchema,
    })
    .strict(),
  z
    .object({
      intent: z.literal('set-agent'),
      fileId: z.string().uuid(),
      expectedHash: z.string().regex(HASH),
      changes: agentEditSchema,
    })
    .strict(),
  z
    .object({
      intent: z.literal('set-provider'),
      fileId: z.string().uuid(),
      expectedHash: z.string().regex(HASH),
      change: providerSchema,
    })
    .strict(),
  z
    .object({
      intent: z.literal('set-mcp'),
      fileId: z.string().uuid(),
      expectedHash: z.string().regex(HASH),
      change: mcpSchema,
    })
    .strict(),
  z
    .object({
      intent: z.literal('set-keybinding'),
      fileId: z.string().uuid(),
      expectedHash: z.string().regex(HASH),
      change: keybindingSchema,
    })
    .strict(),
]);
const proposalSchema = z.object({ edits: z.array(editSchema).min(1).max(MAX_EDITS) }).strict();
const idSchema = z.object({ changeSetId: z.string().uuid() }).strict();
const rollbackSchema = z.object({ appliedId: z.string().uuid() }).strict();
const recoverySchema = z.object({ journalId: z.string().uuid() }).strict();

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
function isWithin(root, target) {
  const rel = relative(resolve(root), resolve(target));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
function mutationError(code, message, status = 400, details = {}) {
  return Object.assign(new Error(message), { code, status, details });
}
function globalAnchor(context) {
  return isWithin(context.home, context.agentDirectory)
    ? context.home
    : dirname(context.agentDirectory);
}
function modeOf(stats) {
  return stats.mode & 0o777;
}
function hasSensitiveKeys(value) {
  if (Array.isArray(value)) return value.some(hasSensitiveKeys);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(
    ([key, child]) => SENSITIVE_KEY.test(key) || hasSensitiveKeys(child),
  );
}
function validateAgentField(key, value) {
  const allowed = new Set(['name', ...PI_SUBAGENTS_EDITOR_FIELDS]);
  if (!allowed.has(key))
    throw mutationError(
      'UNSUPPORTED_AGENT_FIELD',
      `Field ${key} is not editable in this adapter.`,
      422,
    );
  if (value === null && !['name', 'description'].includes(key)) return;
  if (
    key === 'name' &&
    (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value))
  )
    throw mutationError(
      'INVALID_AGENT_FIELD',
      'Agent name must use letters, numbers, dot, underscore, or hyphen.',
      422,
    );
  if (key === 'description' && (typeof value !== 'string' || !value.trim() || value.length > 1024))
    throw mutationError(
      'INVALID_AGENT_FIELD',
      'Agent description is required and limited to 1,024 characters.',
      422,
    );
  if (key === 'model' && (typeof value !== 'string' || !value.trim() || value.length > 200))
    throw mutationError(
      'INVALID_AGENT_FIELD',
      'Model must be inherit or a non-empty provider/model reference.',
      422,
    );
  if (
    key === 'thinking' &&
    !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'inherit'].includes(value)
  )
    throw mutationError(
      'INVALID_AGENT_FIELD',
      'Thinking level is not supported by the tested adapter.',
      422,
    );
  if (key === 'systemPromptMode' && !['append', 'replace'].includes(value))
    throw mutationError(
      'INVALID_AGENT_FIELD',
      'System prompt mode must be append or replace.',
      422,
    );
  if (
    [
      'advertise',
      'inheritProjectContext',
      'inheritGlobalContext',
      'inheritSkills',
      'async',
      'interactive',
      'allowNestedSubagents',
    ].includes(key) &&
    typeof value !== 'boolean'
  )
    throw mutationError('INVALID_AGENT_FIELD', `${key} must be a boolean.`, 422);
  if (
    ['timeoutMs', 'toolTimeoutMs', 'maxSubagentDepth'].includes(key) &&
    (!Number.isInteger(value) || value < 1 || value > 86400000)
  )
    throw mutationError('INVALID_AGENT_FIELD', `${key} must be a positive bounded integer.`, 422);
  if (
    [
      'aliases',
      'tools',
      'excludeTools',
      'subagentOnlyExtensions',
      'skills',
      'defaultReads',
      'defaultProgress',
      'allowedAgents',
    ].includes(key)
  ) {
    const valid =
      typeof value === 'string'
        ? value.length <= 8192
        : Array.isArray(value) &&
          value.length <= 128 &&
          value.every((item) => typeof item === 'string' && item.length <= 256);
    if (!valid)
      throw mutationError(
        'INVALID_AGENT_FIELD',
        `${key} must be a bounded string or list of strings.`,
        422,
      );
  }
  if (
    [
      'output',
      'acceptance',
      'acceptanceRole',
      'memory',
      'launcher',
      'defaultContext',
      'machine',
    ].includes(key)
  ) {
    let serialized;
    try {
      serialized = JSON.stringify(value);
    } catch {
      serialized = '';
    }
    if (
      !serialized ||
      serialized.length > 16384 ||
      hasSensitiveKeys(value) ||
      SECRET_PATTERN.test(serialized)
    )
      throw mutationError(
        'INVALID_AGENT_FIELD',
        `${key} must be bounded and contain no credential-like values.`,
        422,
      );
  }
  if (
    value !== null &&
    SECRET_PATTERN.test(typeof value === 'string' ? value : JSON.stringify(value))
  )
    throw mutationError(
      'SECRET_BEARING_CONTENT',
      `Credential-like content is not accepted in ${key}.`,
      422,
    );
}
function patchAgentSource(before, changes) {
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(before);
  if (!match) throw mutationError('VALIDATION_FAILED', 'Agent source requires YAML frontmatter.');
  const document = YAML.parseDocument(match[1], { keepSourceTokens: true, uniqueKeys: true });
  if (document.errors.length)
    throw mutationError('VALIDATION_FAILED', 'Agent YAML frontmatter is invalid.');
  const metadata = document.toJS() || {};
  for (const [key, value] of Object.entries(changes.fields || {})) {
    validateAgentField(key, value);
    if (value === null) document.delete(key);
    else document.set(key, value);
  }
  const parsedAfter = document.toJS() || {};
  if (!parsedAfter.name || !parsedAfter.description)
    throw mutationError('VALIDATION_FAILED', 'Agent frontmatter requires name and description.');
  if (hasSensitiveKeys(parsedAfter))
    throw mutationError(
      'SECRET_BEARING_CONTENT',
      'Agent frontmatter cannot contain credential fields.',
      422,
    );
  const lineEnding = match[0].includes('\r\n') ? '\r\n' : '\n';
  const yamlStart = match[0].indexOf(match[1]);
  const closingStart = match[0].lastIndexOf('\n---') + 1;
  if (yamlStart < 0 || closingStart <= yamlStart)
    throw mutationError('VALIDATION_FAILED', 'Agent frontmatter boundary could not be preserved.');
  const prefix = match[0].slice(0, yamlStart);
  const suffix = match[0].slice(closingStart);
  let serialized = document.toString({ lineWidth: 0 }).replace(/(?:\r?\n)+$/, '');
  const replacement = `${prefix}${serialized}${lineEnding}${suffix}`;
  const body = changes.body === undefined ? before.slice(match[0].length) : changes.body;
  return {
    content: replacement + body,
    beforeMetadata: metadata,
    afterMetadata: parsedAfter,
  };
}
function validateText(kind, content, targetName) {
  if (Buffer.byteLength(content, 'utf8') > MAX_BYTES)
    throw mutationError('FILE_TOO_LARGE', `Content exceeds ${MAX_BYTES} bytes.`);
  if (SECRET_PATTERN.test(content))
    throw mutationError(
      'SECRET_BEARING_CONTENT',
      'Credential-like content is not accepted by the guided editor. Keep secrets in Pi credential storage.',
      422,
    );
  if (SENSITIVE_LINE.test(content))
    throw mutationError(
      'SECRET_BEARING_CONTENT',
      'Credential-like fields are not accepted by the guided editor.',
      422,
    );
  if (kind === 'skill') {
    const match = /^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
    if (!match) throw mutationError('VALIDATION_FAILED', 'Skill requires YAML frontmatter.');
    let data;
    try {
      data = YAML.parse(match[1]);
    } catch (error) {
      throw mutationError('VALIDATION_FAILED', `Invalid skill YAML: ${error.message}`);
    }
    if (
      !data ||
      typeof data !== 'object' ||
      hasSensitiveKeys(data) ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(data.name || '') ||
      String(data.name).length > 64
    )
      throw mutationError(
        'VALIDATION_FAILED',
        'Skill metadata contains sensitive fields or an invalid name.',
      );
    if (data.name !== targetName)
      throw mutationError(
        'VALIDATION_FAILED',
        'Skill frontmatter name must match the selected directory name.',
      );
    if (typeof data.description !== 'string' || !data.description.trim())
      throw mutationError(
        'VALIDATION_FAILED',
        'Skill description is required. Long descriptions carry a portability/context warning but remain stageable.',
      );
  } else if (kind === 'agent') {
    const parsed = parseAgentDefinition(content);
    if (
      parsed.error ||
      hasSensitiveKeys(parsed.metadata) ||
      !parsed.metadata.name ||
      !parsed.metadata.description
    )
      throw mutationError(
        'VALIDATION_FAILED',
        parsed.error
          ? `Invalid agent YAML: ${parsed.error}`
          : 'Agent frontmatter requires name and description and cannot include credential fields.',
      );
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(String(parsed.metadata.name)))
      throw mutationError('VALIDATION_FAILED', 'Agent name contains unsupported characters.');
  } else if (kind === 'extension') {
    if (!EXTENSION_CODE_EXTENSIONS.has(extname(targetName).toLowerCase()))
      throw mutationError(
        'INVALID_EXTENSION_TARGET',
        'Only recognized JavaScript/TypeScript extension entry files can be edited.',
      );
  } else if (kind === 'command') {
    const match = /^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
    if (match)
      try {
        YAML.parse(match[1]);
      } catch (error) {
        throw mutationError('VALIDATION_FAILED', `Invalid prompt-template YAML: ${error.message}`);
      }
  } else if (['models-config', 'mcp-config', 'keybindings-config'].includes(kind)) {
    const data = parseConfigObject(content, kind);
    const valid =
      kind === 'models-config'
        ? !data.providers || Object.keys(data.providers).length === 0
        : kind === 'mcp-config'
          ? !data.mcpServers || Object.keys(data.mcpServers).length === 0
          : Object.keys(data).length === 0;
    if (!valid)
      throw mutationError(
        'VALIDATION_FAILED',
        'New configuration files must start empty; add resources through their guided editor.',
      );
  }
}
function targetFor(createTarget, context) {
  const { scope, kind, basename: name } = createTarget;
  const safeName = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name);
  if (kind === 'skill-import-file') {
    if (!['global', 'project', 'portable', 'portable-project'].includes(scope))
      throw mutationError('INVALID_TARGET', 'Unsupported skill import scope.');
    const parts = name.split('/');
    const skillName = parts.shift();
    if (
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skillName || '') ||
      skillName.length > 64 ||
      parts.length < 1 ||
      parts.some(
        (part) =>
          !part ||
          part.startsWith('.') ||
          part === '..' ||
          !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(part),
      )
    )
      throw mutationError(
        'INVALID_TARGET',
        'Imported skill paths must be safe relative files inside one named skill directory.',
      );
    const root =
      scope === 'global'
        ? join(context.agentDirectory, 'skills')
        : scope === 'portable'
          ? join(context.home, '.agents', 'skills')
          : scope === 'project'
            ? join(context.cwd, '.pi', 'skills')
            : join(context.cwd, '.agents', 'skills');
    const anchor =
      scope === 'global'
        ? globalAnchor(context)
        : scope === 'portable'
          ? context.home
          : context.cwd;
    const kind = parts.join('/') === 'SKILL.md' ? 'skill' : 'skill-asset';
    return {
      path: join(root, skillName, ...parts),
      allowedRoot: root,
      anchor,
      kind,
      targetName: skillName,
    };
  }
  if (['models-config', 'mcp-config', 'keybindings-config'].includes(kind)) {
    if (scope !== 'global' && scope !== 'project')
      throw mutationError(
        'INVALID_TARGET',
        'Configuration files must use global or project scope.',
      );
    const fileName =
      kind === 'models-config'
        ? 'models.json'
        : kind === 'mcp-config'
          ? 'mcp.json'
          : 'keybindings.json';
    if (name !== fileName)
      throw mutationError('INVALID_TARGET', `Configuration filename must be ${fileName}.`);
    const root = scope === 'global' ? context.agentDirectory : join(context.cwd, '.pi');
    return {
      path: join(root, fileName),
      allowedRoot: root,
      anchor: scope === 'global' ? globalAnchor(context) : context.cwd,
      kind,
      targetName: fileName,
    };
  }
  const piRoot = scope === 'global' ? context.agentDirectory : join(context.cwd, '.pi');
  if (kind === 'instruction') {
    if (scope !== 'global' && scope !== 'project')
      throw mutationError('INVALID_TARGET', 'Instructions must use global or project scope.');
    if (!ROOT_NAMES.has(name))
      throw mutationError('INVALID_TARGET', 'Instruction filename is not supported.');
    return {
      path: join(scope === 'global' ? context.agentDirectory : context.cwd, name),
      allowedRoot: scope === 'global' ? context.agentDirectory : context.cwd,
      anchor: scope === 'global' ? globalAnchor(context) : context.cwd,
      kind,
    };
  }
  if (kind === 'system-prompt' || kind === 'append-system') {
    if (scope !== 'global' && scope !== 'project')
      throw mutationError('INVALID_TARGET', 'Prompt files must use global or project scope.');
    const name = kind === 'system-prompt' ? 'SYSTEM.md' : 'APPEND_SYSTEM.md';
    return {
      path: join(piRoot, name),
      allowedRoot: piRoot,
      anchor: scope === 'global' ? globalAnchor(context) : context.cwd,
      kind,
    };
  }
  if (!safeName)
    throw mutationError(
      'INVALID_TARGET',
      'Resource name must be a safe basename using letters, numbers, dot, underscore, or hyphen.',
    );
  if (kind === 'skill') {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64)
      throw mutationError(
        'INVALID_TARGET',
        'Skill directory name must be lowercase letters, numbers, or hyphens (max 64 characters).',
      );
    const root =
      scope === 'global'
        ? join(context.agentDirectory, 'skills')
        : scope === 'portable'
          ? join(context.home, '.agents', 'skills')
          : scope === 'project'
            ? join(context.cwd, '.pi', 'skills')
            : scope === 'portable-project'
              ? join(context.cwd, '.agents', 'skills')
              : null;
    if (!root) throw mutationError('INVALID_TARGET', 'Unsupported skill scope.');
    const anchor =
      scope === 'global'
        ? globalAnchor(context)
        : scope === 'portable'
          ? context.home
          : context.cwd;
    return {
      path: join(root, name, 'SKILL.md'),
      allowedRoot: root,
      anchor,
      kind,
      targetName: name,
    };
  }
  if (scope !== 'global' && scope !== 'project')
    throw mutationError(
      'INVALID_TARGET',
      'Agent and command resources must use global or project scope.',
    );
  if (kind === 'agent') {
    const root =
      scope === 'global'
        ? join(context.agentDirectory, 'agents')
        : join(context.cwd, '.pi', 'agents');
    return {
      path: join(root, `${name}.md`),
      allowedRoot: root,
      anchor: scope === 'global' ? globalAnchor(context) : context.cwd,
      kind,
      targetName: name,
    };
  }
  if (kind === 'command') {
    const root =
      scope === 'global'
        ? join(context.agentDirectory, 'prompts')
        : join(context.cwd, '.pi', 'prompts');
    return {
      path: join(root, `${name}.md`),
      allowedRoot: root,
      anchor: scope === 'global' ? globalAnchor(context) : context.cwd,
      kind,
      targetName: name,
    };
  }
  throw mutationError('INVALID_TARGET', 'Unsupported create target.');
}
function existingTarget(file, context) {
  const path = file.path;
  const entry = file.entry;
  if (!entry.editable || !file.allowContent)
    throw mutationError(
      'SOURCE_READ_ONLY',
      'This source is not editable in the supported safe workflow.',
      403,
    );
  if (entry.kind === 'instruction') {
    if (entry.scope === 'global' && isWithin(context.agentDirectory, path))
      return {
        path,
        allowedRoot: context.agentDirectory,
        anchor: globalAnchor(context),
        kind: entry.kind,
        targetName: basename(path),
      };
    if (entry.scope === 'project' && dirname(path) === context.cwd)
      return {
        path,
        allowedRoot: context.cwd,
        anchor: context.cwd,
        kind: entry.kind,
        targetName: basename(path),
      };
  }
  if (['system-prompt', 'append-system'].includes(entry.kind)) {
    if (entry.scope === 'global' && isWithin(context.agentDirectory, path))
      return {
        path,
        allowedRoot: context.agentDirectory,
        anchor: globalAnchor(context),
        kind: entry.kind,
        targetName: basename(path),
      };
    if (entry.scope === 'project' && isWithin(join(context.cwd, '.pi'), path))
      return {
        path,
        allowedRoot: join(context.cwd, '.pi'),
        anchor: context.cwd,
        kind: entry.kind,
        targetName: basename(path),
      };
  }
  if (entry.kind === 'skill' || entry.kind === 'skill-asset') {
    const roots =
      entry.scope === 'global'
        ? [join(context.agentDirectory, 'skills')]
        : entry.scope === 'portable'
          ? [join(context.home, '.agents', 'skills')]
          : entry.scope === 'project'
            ? [join(context.cwd, '.pi', 'skills'), join(context.cwd, '.agents', 'skills')]
            : [];
    const root = roots.find((candidate) => isWithin(candidate, path));
    const anchor =
      entry.scope === 'global'
        ? globalAnchor(context)
        : entry.scope === 'portable'
          ? context.home
          : context.cwd;
    if (entry.kind === 'skill' && root && basename(path) === 'SKILL.md')
      return {
        path,
        allowedRoot: root,
        anchor,
        kind: entry.kind,
        targetName: basename(dirname(path)),
      };
    if (
      entry.kind === 'skill-asset' &&
      root &&
      entry.skillManifestId &&
      basename(path) !== 'SKILL.md'
    )
      return {
        path,
        allowedRoot: root,
        anchor,
        kind: entry.kind,
        targetName: relative(root, path),
      };
  }
  if (
    entry.kind === 'command' &&
    isWithin(
      entry.scope === 'global'
        ? join(context.agentDirectory, 'prompts')
        : join(context.cwd, '.pi', 'prompts'),
      path,
    )
  )
    return {
      path,
      allowedRoot:
        entry.scope === 'global'
          ? join(context.agentDirectory, 'prompts')
          : join(context.cwd, '.pi', 'prompts'),
      anchor: entry.scope === 'global' ? globalAnchor(context) : context.cwd,
      kind: entry.kind,
      targetName: basename(path, extname(path)),
    };
  if (entry.kind === 'agent') {
    const root =
      entry.scope === 'global'
        ? join(context.agentDirectory, 'agents')
        : join(context.cwd, '.pi', 'agents');
    if (isWithin(root, path))
      return {
        path,
        allowedRoot: root,
        anchor: entry.scope === 'global' ? globalAnchor(context) : context.cwd,
        kind: entry.kind,
        targetName: basename(path, '.md'),
      };
  }
  if (
    entry.kind === 'extension' &&
    entry.owner === 'local-extension' &&
    EXTENSION_CODE_EXTENSIONS.has(extname(path).toLowerCase())
  ) {
    const root =
      entry.scope === 'global'
        ? join(context.agentDirectory, 'extensions')
        : entry.scope === 'project'
          ? join(context.cwd, '.pi', 'extensions')
          : null;
    if (root && isWithin(root, path))
      return {
        path,
        allowedRoot: root,
        anchor: entry.scope === 'global' ? globalAnchor(context) : context.cwd,
        kind: entry.kind,
        targetName: basename(path),
      };
  }
  throw mutationError(
    'PATH_OUTSIDE_ALLOWED_ROOT',
    'This source is outside the editable roots supported by this workflow.',
    403,
  );
}
async function checkSafePath(anchor, allowedRoot, target, allowMissing) {
  if (!isWithin(allowedRoot, target))
    throw mutationError(
      'PATH_OUTSIDE_ALLOWED_ROOT',
      'Target escapes its authorized resource root.',
      403,
    );
  let trustedAnchor = resolve(anchor);
  try {
    trustedAnchor = await realpath(trustedAnchor);
  } catch {
    throw mutationError(
      'PATH_OUTSIDE_ALLOWED_ROOT',
      'The selected workspace root is unavailable.',
      403,
    );
  }
  try {
    await authorizePath(trustedAnchor, target, { allowMissing });
  } catch (error) {
    throw mutationError(
      error.message.includes('SYMLINK') ? 'SYMLINK_NOT_ALLOWED' : 'PATH_OUTSIDE_ALLOWED_ROOT',
      'Target path failed canonical root or symlink checks.',
      403,
    );
  }
}
async function ensurePrivateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  const wrongOwner = typeof process.getuid === 'function' && info.uid !== process.getuid();
  if (!info.isDirectory() || info.isSymbolicLink() || wrongOwner || (modeOf(info) & 0o077) !== 0)
    throw mutationError('STATE_DIR_UNSAFE', 'Pinotator state directory is not private.', 500);
}
async function readBackup(directory, name) {
  if (typeof name !== 'string' || !/^[a-f0-9-]+-[0-9]+\.bak$/.test(name))
    throw mutationError('RECOVERY_INVALID', 'Backup reference failed validation.', 500);
  const path = join(directory, name);
  const info = await lstat(path);
  const wrongOwner = typeof process.getuid === 'function' && info.uid !== process.getuid();
  if (!info.isFile() || info.isSymbolicLink() || wrongOwner || (modeOf(info) & 0o077) !== 0)
    throw mutationError('BACKUP_UNSAFE', 'A transaction backup is missing or not private.', 500);
  return readFile(path);
}
async function writeJsonAtomic(path, value) {
  await atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`, 0o600);
}
async function atomicWrite(path, contents, mode = 0o600, beforeRename = async () => {}) {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const temp = join(parent, `.${basename(path)}.pinotator-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temp, 'wx', mode);
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await beforeRename();
    await rename(temp, path);
    const dir = await open(parent, 'r');
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temp).catch(() => {});
    throw error;
  }
}
function publicEdit(edit) {
  return {
    intent: edit.intent,
    fileId: edit.fileId,
    displayPath: edit.displayPath,
    expectedHash: edit.expectedHash,
    targetHash: edit.afterHash,
    diff: edit.diff,
    validation: edit.validation,
    reloadRequirement: edit.reloadRequirement,
    targetKind: edit.kind,
    targetName: edit.targetName,
  };
}
function publicChange(change) {
  return {
    id: change.id,
    status: change.status,
    createdAt: change.createdAt,
    validation: change.validation,
    predictedEffects: change.predictedEffects,
    edits: change.edits.map(publicEdit),
    appliedId: change.appliedId,
    rollbackAvailable: Boolean(change.appliedId) && change.status === 'applied',
    rolledBackAt: change.rolledBackAt,
    error: change.error,
  };
}
function safeEndpointForDisplay(value) {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    if (url.search) url.search = '?[REDACTED]';
    url.hash = '';
    if (/\/(?:token|api[_-]?key|secret|password)\//i.test(url.pathname))
      url.pathname = '/[REDACTED]';
    return url.toString();
  } catch {
    return '[REDACTED]';
  }
}
function makeDiff(path, before, after, kind) {
  const mask = (value) => {
    const errors = [];
    const tree = parseJsonTree(value, errors, {
      allowTrailingComma: true,
      disallowComments: false,
    });
    if (!tree || errors.length)
      return value.replace(
        /(api[_-]?key|token|secret|password|authorization)(\s*[:=]\s*)([^,\n}]+)/gi,
        '$1$2[REDACTED]',
      );
    const ranges = [];
    const walk = (node, inheritedKey = '') => {
      if (node.type === 'object') {
        const children = node.children || [];
        for (const property of children) {
          const keyNode = property.children?.[0],
            valueNode = property.children?.[1];
          if (!keyNode || !valueNode) continue;
          const key = getNodeValue(keyNode);
          if (kind === 'mcp' && String(key) === 'env' && valueNode.type === 'object') {
            for (const envProperty of valueNode.children || []) {
              const envValue = envProperty.children?.[1];
              if (envValue)
                ranges.push({
                  offset: envValue.offset,
                  length: envValue.length,
                  content: JSON.stringify('[REDACTED]'),
                });
            }
          } else if (
            SENSITIVE_KEY.test(String(key)) ||
            (['mcp', 'models'].includes(kind) && ['headers', 'oauth'].includes(String(key))) ||
            (kind === 'mcp' && ['args'].includes(String(key)))
          )
            ranges.push({
              offset: valueNode.offset,
              length: valueNode.length,
              content: JSON.stringify('[REDACTED]'),
            });
          else if (
            ['mcp', 'models'].includes(kind) &&
            ['url', 'baseUrl'].includes(String(key)) &&
            valueNode.type === 'string'
          )
            ranges.push({
              offset: valueNode.offset,
              length: valueNode.length,
              content: JSON.stringify(safeEndpointForDisplay(valueNode.value)),
            });
          else walk(valueNode, String(key));
        }
      } else if (node.type === 'array')
        for (const child of node.children || []) walk(child, inheritedKey);
      else if (
        node.type === 'string' &&
        typeof node.value === 'string' &&
        node.value.startsWith('!')
      )
        ranges.push({
          offset: node.offset,
          length: node.length,
          content: JSON.stringify('[REDACTED: command resolver]'),
        });
    };
    walk(tree);
    const masked = applyJsonEdits(
      value,
      ranges.sort((a, b) => b.offset - a.offset),
    );
    return masked
      .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._~-]{16,})\b/g, '[REDACTED]')
      .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, '$1[REDACTED]@')
      .replace(/([?&][^=&#\s]+)=([^&#\s]+)/g, '$1=[REDACTED]')
      .replace(
        /((?:api[_-]?key|secret|token|password|authorization|credential)\s*[:=]\s*)[^\s,;]+/gi,
        '$1[REDACTED]',
      );
  };
  const safeBefore = ['models', 'mcp'].includes(kind) ? mask(before || '') : before || '';
  const safeAfter = ['models', 'mcp'].includes(kind) ? mask(after || '') : after || '';
  return createTwoFilesPatch(path, path, safeBefore, safeAfter, 'current', 'proposed', {
    context: 3,
  });
}
function settingPathAllowed(path) {
  if (
    !Array.isArray(path) ||
    path.length < 1 ||
    path.length > 4 ||
    path.some(
      (part) =>
        typeof part !== 'string' || !/^[a-zA-Z0-9_.:/-]{1,100}$/.test(part) || part.includes('..'),
    )
  )
    return false;
  const joined = path.join('.');
  return (
    [
      'defaultModel',
      'defaultProvider',
      'defaultThinkingLevel',
      'modelThinkingLevels',
      'enabledModels',
      'defaultTools',
      'defaultProjectTrust',
      'enableSkillCommands',
      'steeringMode',
      'followUpMode',
      'tuiMode',
      'theme',
      'quietStartup',
      'compaction.enabled',
      'compaction.reserveTokens',
      'compaction.keepRecentTokens',
      'retry.enabled',
      'retry.maxRetries',
      'retry.baseDelayMs',
      'retry.maxAgentDelayMs',
      'retry.provider.timeoutMs',
      'retry.provider.maxRetries',
      'retry.provider.maxRetryDelayMs',
      'subagents.defaultModel',
      'subagents.defaultThinking',
      'subagents.defaultProvider',
      'subagents.agentScope',
    ].includes(joined) ||
    /^subagents\.agentOverrides\.[^.]+\.(model|defaultProvider|thinking|tools|inheritProjectContext|inheritGlobalContext|inheritSkills|systemPromptMode)$/.test(
      joined,
    ) ||
    /^modelThinkingLevels\.[A-Za-z0-9_.:/-]+$/.test(joined)
  );
}
export function isSettingPresetPath(path) {
  return settingPathAllowed(path);
}
function parseConfigObject(raw, label) {
  const errors = [];
  const value = parseJson(raw, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length || !value || typeof value !== 'object' || Array.isArray(value))
    throw mutationError('VALIDATION_FAILED', `${label} must be a valid JSONC object.`);
  return value;
}
function patchJsonc(raw, path, value) {
  const edits = modifyJson(raw, path, value, {
    formattingOptions: {
      insertSpaces: true,
      tabSize: 2,
      eol: raw.includes('\r\n') ? '\r\n' : '\n',
    },
  });
  return applyJsonEdits(raw, edits);
}
function validateSafeEndpoint(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw mutationError('VALIDATION_FAILED', `${label} must be a valid URL.`);
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase());
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    /\/(?:token|api[_-]?key|secret|password)\//i.test(url.pathname) ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))
  )
    throw mutationError(
      'SECRET_BEARING_CONTENT',
      `${label} must use HTTPS or loopback HTTP and cannot embed credentials, secret-like paths, or query parameters.`,
      422,
    );
}
function validateModelChange(raw, change) {
  const data = parseConfigObject(raw, 'models.json');
  if (
    data.providers !== undefined &&
    (!data.providers || typeof data.providers !== 'object' || Array.isArray(data.providers))
  )
    throw mutationError('VALIDATION_FAILED', 'models.json providers must be an object.');
  if (change.operation === 'remove') {
    if (!data.providers?.[change.providerId])
      throw mutationError('SOURCE_NOT_FOUND', 'Provider does not exist in this models.json.', 404);
    return patchJsonc(raw, ['providers', change.providerId], undefined);
  }
  if (!change.name?.trim() || !change.baseUrl || !change.api || !change.model)
    throw mutationError(
      'VALIDATION_FAILED',
      'Provider name, base URL, API type, and one model are required.',
    );
  if (SECRET_PATTERN.test(JSON.stringify(change)) || SENSITIVE_LINE.test(JSON.stringify(change)))
    throw mutationError(
      'SECRET_BEARING_CONTENT',
      'Provider metadata cannot contain credentials; configure credential sources in Pi separately.',
      422,
    );
  validateSafeEndpoint(change.baseUrl, 'Provider base URL');
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(change.model.id) ||
    /[?&](?:key|token|secret|password)=/i.test(change.model.id)
  )
    throw mutationError('VALIDATION_FAILED', 'Model ID contains unsupported characters.');
  const existing = data.providers?.[change.providerId];
  if (
    existing !== undefined &&
    (!existing || typeof existing !== 'object' || Array.isArray(existing))
  )
    throw mutationError('VALIDATION_FAILED', 'Existing provider entry must be an object.');
  let output = raw;
  if (!data.providers) output = patchJsonc(output, ['providers'], {});
  const provider = data.providers?.[change.providerId] || {};
  for (const [key, value] of Object.entries({
    name: change.name.trim(),
    baseUrl: change.baseUrl,
    api: change.api,
  }))
    output = patchJsonc(output, ['providers', change.providerId, key], value);
  if (!Array.isArray(provider.models) && provider.models !== undefined)
    throw mutationError('VALIDATION_FAILED', 'Existing provider models must be an array.');
  const models = provider.models || [];
  const index = models.findIndex((model) => model?.id === change.model.id);
  const modelBase = index >= 0 ? models[index] : {};
  const modelFields = Object.fromEntries(
    Object.entries(change.model).filter(([, value]) => value !== undefined),
  );
  if (index >= 0) {
    for (const [key, value] of Object.entries(modelFields))
      output = patchJsonc(output, ['providers', change.providerId, 'models', index, key], value);
  } else
    output = patchJsonc(
      output,
      ['providers', change.providerId, 'models', models.length],
      modelFields,
    );
  const after = parseConfigObject(output, 'models.json');
  if (
    after.providers[change.providerId].models[index >= 0 ? index : models.length]?.id !==
    change.model.id
  )
    throw mutationError('VALIDATION_FAILED', 'Could not safely add the model to this provider.');
  return output;
}
const VALID_MCP_EXPOSURES = new Set(['codemode', 'deferred', 'direct', 'hidden']);
function validateMcpChange(raw, change, scope) {
  if (SECRET_PATTERN.test(change.serverName))
    throw mutationError(
      'SECRET_BEARING_CONTENT',
      'MCP server names cannot contain credential-like data.',
      422,
    );
  const data = parseConfigObject(raw, 'mcp.json');
  if (data.servers && !data.mcpServers)
    throw mutationError(
      'UNSUPPORTED_SCHEMA',
      'Legacy `servers` files are inspect-only; migrate to `mcpServers` with the installed Pi command.',
    );
  if (
    data.mcpServers !== undefined &&
    (!data.mcpServers || typeof data.mcpServers !== 'object' || Array.isArray(data.mcpServers))
  )
    throw mutationError('VALIDATION_FAILED', 'mcpServers must be an object.');
  const current = data.mcpServers?.[change.serverName];
  if (current !== undefined && (!current || typeof current !== 'object' || Array.isArray(current)))
    throw mutationError('VALIDATION_FAILED', 'Existing MCP server entry must be an object.');
  if (change.operation === 'remove') {
    if (!current)
      throw mutationError(
        'SOURCE_NOT_FOUND',
        'MCP server does not exist in this source file.',
        404,
      );
    return patchJsonc(raw, ['mcpServers', change.serverName], undefined);
  }
  if (
    Object.keys(change.toolExposure || {}).length > 100 ||
    Object.keys(change.toolExposure || {}).some((name) => !/^[A-Za-z0-9_.:-]{1,128}$/.test(name))
  )
    throw mutationError(
      'VALIDATION_FAILED',
      'toolExposure names are limited to 100 safe tool IDs.',
    );
  if (change.operation === 'policy') {
    if (!current && scope !== 'project')
      throw mutationError(
        'SOURCE_NOT_FOUND',
        'A global policy edit requires an existing server.',
        404,
      );
    if (
      change.enabled === undefined &&
      change.exposure === undefined &&
      change.toolExposure === undefined
    )
      throw mutationError('VALIDATION_FAILED', 'Set at least one MCP policy field.');
    let output = raw;
    if (!data.mcpServers) output = patchJsonc(output, ['mcpServers'], {});
    if (change.enabled !== undefined)
      output = patchJsonc(output, ['mcpServers', change.serverName, 'enabled'], change.enabled);
    if (change.exposure !== undefined)
      output = patchJsonc(output, ['mcpServers', change.serverName, 'exposure'], change.exposure);
    if (change.toolExposure !== undefined)
      output = patchJsonc(
        output,
        ['mcpServers', change.serverName, 'toolExposure'],
        change.toolExposure,
      );
    return output;
  }
  if (!change.transport)
    throw mutationError('VALIDATION_FAILED', 'Select stdio or HTTP transport.');
  if (change.transport === 'stdio') {
    if (!change.command || change.url)
      throw mutationError(
        'VALIDATION_FAILED',
        'Stdio MCP requires one executable command and no URL.',
      );
    if (/[\r\n\0]/.test(change.command) || change.command.trim() !== change.command)
      throw mutationError(
        'VALIDATION_FAILED',
        'Command must be one executable name or path, not a shell command string.',
      );
  } else {
    if (!change.url || change.command || change.args?.length || change.envNames?.length)
      throw mutationError(
        'VALIDATION_FAILED',
        'HTTP MCP requires a URL and does not accept stdio fields.',
      );
    validateSafeEndpoint(change.url, 'MCP server URL');
  }
  const args = change.args || [];
  if (
    args.some(
      (value) =>
        /\b(?:sk-[A-Za-z0-9_-]{16,}|Bearer\s+\S{16,})/i.test(value) ||
        SENSITIVE_LINE.test(value) ||
        /(?:^|\s)--?(?:api[_-]?key|secret|token|password|authorization)(?:=|\s|$)/i.test(value),
    )
  )
    throw mutationError(
      'SECRET_BEARING_CONTENT',
      'Do not put credentials or credential flags in MCP command arguments.',
      422,
    );
  const existing = current && typeof current === 'object' && !Array.isArray(current) ? current : {};
  if (
    current?.env !== undefined &&
    (!current.env || typeof current.env !== 'object' || Array.isArray(current.env))
  )
    throw mutationError(
      'VALIDATION_FAILED',
      'Existing MCP env must be an object; edit it manually to avoid losing credential values.',
    );
  if (
    change.description &&
    (SECRET_PATTERN.test(change.description) || SENSITIVE_LINE.test(change.description))
  )
    throw mutationError(
      'SECRET_BEARING_CONTENT',
      'MCP descriptions cannot contain credential-like values.',
      422,
    );
  const normalizedName = change.serverName.replace(/[-_]/g, '_').toLowerCase();
  if (
    Object.keys(data.mcpServers || {}).some(
      (name) =>
        name !== change.serverName && name.replace(/[-_]/g, '_').toLowerCase() === normalizedName,
    )
  )
    throw mutationError(
      'MCP_NAME_COLLISION',
      'Pi treats MCP names differing only by hyphen or underscore as a collision.',
      409,
    );
  let output = raw;
  if (!data.mcpServers) output = patchJsonc(output, ['mcpServers'], {});
  const base = ['mcpServers', change.serverName];
  const patchField = (key, value) => {
    if (value !== undefined) output = patchJsonc(output, [...base, key], value);
    else if (Object.hasOwn(current || {}, key))
      output = patchJsonc(output, [...base, key], undefined);
  };
  if (change.transport === 'stdio') {
    patchField('url', undefined);
    patchField('command', change.command);
    patchField('args', change.args ?? current?.args ?? []);
    if (change.envNames?.length) {
      for (const name of change.envNames)
        if (!Object.hasOwn(current?.env || {}, name))
          output = patchJsonc(output, [...base, 'env', name], '$' + '{' + name + '}');
    }
  } else {
    patchField('command', undefined);
    patchField('args', undefined);
    patchField('cwd', undefined);
    patchField('url', change.url);
  }
  for (const key of ['enabled', 'exposure', 'timeout', 'description', 'toolExposure'])
    if (change[key] !== undefined) patchField(key, change[key]);
  return output;
}
const MODIFIERS = new Set(['ctrl', 'shift', 'alt', 'super']);
const SPECIAL_KEYS = new Set([
  'escape',
  'esc',
  'enter',
  'return',
  'tab',
  'space',
  'backspace',
  'delete',
  'insert',
  'clear',
  'home',
  'end',
  'pageup',
  'pagedown',
  'up',
  'down',
  'left',
  'right',
]);
const SYMBOL_KEYS = new Set([
  '`',
  '-',
  '=',
  '[',
  ']',
  '\\',
  ';',
  "'",
  ',',
  '.',
  '/',
  '!',
  '@',
  '#',
  '$',
  '%',
  '^',
  '&',
  '*',
  '(',
  ')',
  '_',
  '+',
  '|',
  '~',
  '{',
  '}',
  ':',
  '<',
  '>',
  '?',
]);
function normalizeKeybinding(binding) {
  if (typeof binding !== 'string' || !binding.trim())
    throw mutationError('VALIDATION_FAILED', 'Key binding cannot be empty.');
  const parts = binding.toLowerCase().split('+');
  let key = parts.pop();
  if (key === '') {
    key = '+';
    if (parts.at(-1) === '') parts.pop();
  }
  const modifiers = parts;
  if (
    modifiers.some((modifier) => !MODIFIERS.has(modifier)) ||
    new Set(modifiers).size !== modifiers.length
  )
    throw mutationError('VALIDATION_FAILED', `Unsupported key combination: ${binding}`);
  const validKey =
    /^[a-z0-9]$/.test(key) ||
    /^f(?:[1-9]|1[0-2])$/.test(key) ||
    SPECIAL_KEYS.has(key) ||
    SYMBOL_KEYS.has(key);
  if (!validKey || (modifiers.length === 0 && !validKey))
    throw mutationError('VALIDATION_FAILED', `Unsupported key combination: ${binding}`);
  return [...modifiers.sort(), key.toLowerCase()].join('+');
}
function validateKeybindingChange(raw, change) {
  if (SECRET_PATTERN.test(change.action))
    throw mutationError(
      'SECRET_BEARING_CONTENT',
      'Keybinding action cannot contain credential-like data.',
      422,
    );
  const data = parseConfigObject(raw, 'keybindings.json');
  if (change.reset && change.bindings !== undefined)
    throw mutationError('VALIDATION_FAILED', 'Reset cannot be combined with explicit bindings.');
  if (change.reset) return patchJsonc(raw, [change.action], undefined);
  if (!change.bindings)
    throw mutationError('VALIDATION_FAILED', 'Bindings are required unless resetting this action.');
  const canonical = change.bindings.map(normalizeKeybinding);
  if (new Set(canonical).size !== canonical.length)
    throw mutationError('KEYBINDING_COLLISION', 'The same key is assigned twice to this action.');
  for (const [action, value] of Object.entries(data)) {
    if (action === change.action) continue;
    const existing = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
    if (
      existing.some((binding) => {
        if (typeof binding !== 'string') return false;
        try {
          return canonical.includes(normalizeKeybinding(binding));
        } catch {
          return false;
        }
      })
    )
      throw mutationError(
        'KEYBINDING_COLLISION',
        `This key is already assigned to ${action}.`,
        409,
      );
  }
  return patchJsonc(
    raw,
    [change.action],
    canonical.length === 1 ? change.bindings[0] : change.bindings,
  );
}
function validateSettingValue(path, value, scope) {
  const root = path[0],
    leaf = path.at(-1);
  if (root === 'defaultProjectTrust' && scope !== 'global')
    throw mutationError(
      'UNSUPPORTED_SETTING',
      'defaultProjectTrust is global-only in the installed Pi settings schema.',
      422,
    );
  const levels = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  if (
    ['defaultModel', 'defaultProvider', 'model', 'theme'].includes(leaf) &&
    typeof value !== 'string'
  )
    throw mutationError('VALIDATION_FAILED', `${leaf} must be a string.`);
  if (['defaultThinkingLevel', 'thinking', 'defaultThinking'].includes(leaf) && !levels.has(value))
    throw mutationError('VALIDATION_FAILED', `${leaf} must be a supported thinking level.`);
  if (
    ['enabledModels', 'defaultTools', 'tools'].includes(leaf) &&
    !(Array.isArray(value) && value.every((item) => typeof item === 'string'))
  )
    throw mutationError('VALIDATION_FAILED', `${leaf} must be a string array.`);
  if (root === 'defaultProjectTrust' && !['ask', 'always', 'never'].includes(value))
    throw mutationError('VALIDATION_FAILED', 'defaultProjectTrust must be ask, always, or never.');
  if (root === 'quietStartup' && typeof value !== 'boolean' && value !== 'header')
    throw mutationError('VALIDATION_FAILED', 'quietStartup must be boolean or header.');
  if (root === 'subagents' && leaf === 'agentScope' && !['user', 'project'].includes(value))
    throw mutationError('VALIDATION_FAILED', 'subagents.agentScope must be user or project.');
  if (root === 'steeringMode' && !['all', 'one-at-a-time'].includes(value))
    throw mutationError('VALIDATION_FAILED', 'steeringMode must be all or one-at-a-time.');
  if (root === 'followUpMode' && !['all', 'one-at-a-time'].includes(value))
    throw mutationError('VALIDATION_FAILED', 'followUpMode must be all or one-at-a-time.');
  if (root === 'tuiMode' && !['regular', 'fullscreen'].includes(value))
    throw mutationError('VALIDATION_FAILED', 'tuiMode must be regular or fullscreen.');
  const booleanFields = new Set([
    'enableSkillCommands',
    'inheritProjectContext',
    'inheritGlobalContext',
    'inheritSkills',
    'enabled',
  ]);
  if (
    (booleanFields.has(root) ||
      booleanFields.has(leaf) ||
      ['compaction.enabled', 'retry.enabled'].includes(joinPath(path))) &&
    typeof value !== 'boolean'
  )
    throw mutationError('VALIDATION_FAILED', `${joinPath(path)} must be boolean.`);
  if (
    [
      'reserveTokens',
      'keepRecentTokens',
      'maxRetries',
      'baseDelayMs',
      'maxAgentDelayMs',
      'timeoutMs',
      'maxRetryDelayMs',
    ].includes(leaf) &&
    (!Number.isInteger(value) || value < 0 || value > 10_000_000)
  )
    throw mutationError('VALIDATION_FAILED', `${leaf} must be a non-negative integer.`);
  if (
    root === 'modelThinkingLevels' &&
    path.length === 1 &&
    (!value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.values(value).some((level) => typeof level !== 'string' || !levels.has(level)))
  )
    throw mutationError(
      'VALIDATION_FAILED',
      'modelThinkingLevels must map model IDs to supported thinking levels.',
    );
  if (path.length > 1 && root === 'modelThinkingLevels' && !levels.has(value))
    throw mutationError(
      'VALIDATION_FAILED',
      'Model thinking value must be a supported thinking level.',
    );
}
function joinPath(path) {
  return path.join('.');
}
function renderSettingEdit(raw, path, value, scope) {
  if (SECRET_PATTERN.test(raw) || SENSITIVE_LINE.test(raw))
    throw mutationError(
      'SECRET_BEARING_FILE',
      'Settings contain credential-like values and cannot be targeted safely.',
      403,
    );
  const errors = [];
  const parsed = parseJson(raw, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length || !parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw mutationError(
      'VALIDATION_FAILED',
      `Settings JSON cannot be safely edited: ${errors.length ? printParseErrorCode(errors[0].error) : 'root must be an object'}.`,
    );
  if (hasSensitiveKeys(parsed))
    throw mutationError(
      'SECRET_BEARING_FILE',
      'This settings file contains sensitive fields; safe field editing is disabled for this source.',
      403,
    );
  if (!settingPathAllowed(path))
    throw mutationError(
      'UNSUPPORTED_SETTING',
      'This setting is not supported by the safe field editor.',
      422,
    );
  validateSettingValue(path, value, scope);
  if (SECRET_PATTERN.test(typeof value === 'string' ? value : JSON.stringify(value)))
    throw mutationError(
      'SECRET_BEARING_CONTENT',
      'Credential-like values cannot be staged in settings.',
      422,
    );
  const edits = modifyJson(raw, path, value, {
    formattingOptions: {
      insertSpaces: true,
      tabSize: 2,
      eol: raw.includes('\r\n') ? '\r\n' : '\n',
    },
  });
  const output = applyJsonEdits(raw, edits);
  const outputErrors = [];
  parseJson(output, outputErrors, { allowTrailingComma: true, disallowComments: false });
  if (outputErrors.length)
    throw mutationError('VALIDATION_FAILED', 'The targeted settings edit produced invalid JSON.');
  return output;
}

export function createMutationService({
  context,
  getDiscovery,
  refreshDiscovery = async () => {},
  publish = () => {},
  readOnly = false,
  stateDirectory,
  beforeCommitEdit = async () => {},
}: {
  context: ManagerContext;
  getDiscovery: GetDiscovery;
  refreshDiscovery?: () => Promise<unknown>;
  publish?: (event: string, data?: Record<string, unknown>) => void;
  readOnly?: boolean;
  stateDirectory?: string;
  beforeCommitEdit?: (edit: PreparedEdit, index: number) => Promise<void>;
}) {
  const changes = new Map();
  const applied = new Map();
  const stateRoot = resolve(
    stateDirectory ||
      join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'pinotator'),
  );
  const journalsRoot = join(stateRoot, 'transactions');
  const backupsRoot = join(stateRoot, 'backups');
  const ready = (async () => {
    try {
      const info = await lstat(journalsRoot);
      const wrongOwner = typeof process.getuid === 'function' && info.uid !== process.getuid();
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        wrongOwner ||
        (modeOf(info) & 0o077) !== 0
      )
        throw new Error('unsafe journal directory');
      for (const name of await readdir(journalsRoot)) {
        if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
        try {
          const journalPath = join(journalsRoot, name);
          const journalInfo = await lstat(journalPath);
          const wrongJournalOwner =
            typeof process.getuid === 'function' && journalInfo.uid !== process.getuid();
          if (
            !journalInfo.isFile() ||
            journalInfo.isSymbolicLink() ||
            wrongJournalOwner ||
            (modeOf(journalInfo) & 0o077) !== 0 ||
            journalInfo.size > 2 * 1024 * 1024
          )
            continue;
          const journal = JSON.parse(await readFile(journalPath, 'utf8'));
          if (journal.id !== name.slice(0, -5) || !/^[a-f0-9-]{36}$/.test(journal.id)) continue;
          if (['prepared', 'applying', 'partial'].includes(journal.status))
            changes.set(`recovery:${journal.id}`, { ...journal, recovery: true });
          if (['applied', 'rolled_back'].includes(journal.status) && journal.changeSetId) {
            if (journal.status === 'applied')
              applied.set(journal.id, {
                id: journal.id,
                journal,
                journalPath: join(journalsRoot, name),
                restoredAfterRestart: true,
              });
            if (journal.changeSetId)
              changes.set(journal.changeSetId, {
                id: journal.changeSetId,
                status: journal.status,
                rolledBackAt: journal.status === 'rolled_back' ? journal.updatedAt : undefined,
                createdAt: journal.createdAt,
                validation: [],
                predictedEffects: [],
                appliedId: journal.id,
                edits: (journal.files || []).map((file) => ({
                  intent: file.intent,
                  fileId: file.sourceId,
                  displayPath: file.displayPath,
                  expectedHash: file.expectedHash,
                  afterHash: file.afterHash,
                  diff: file.diff || '',
                  validation: [],
                  reloadRequirement: file.reloadRequirement || 'pi-reload',
                  kind: file.kind,
                  targetName: file.targetName,
                })),
              });
          }
        } catch {}
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  })();
  function markRolledBack(appliedId: string, at = new Date().toISOString()) {
    applied.delete(appliedId);
    for (const change of changes.values())
      if (change.appliedId === appliedId) {
        change.status = 'rolled_back';
        change.rolledBackAt = at;
      }
  }
  const getContext = () => ({
    ...context,
    cwd: resolve(context.cwd),
    home: resolve(context.home || homedir()),
    agentDirectory: resolve(context.agentDirectory),
  });

  async function prepareAgentEdit(input, discovery, ctx) {
    const editor = discovery.getAgentEditor?.(input.fileId);
    if (!editor || !editor.editable || editor.adapterVersion !== TESTED_PI_SUBAGENTS_VERSION)
      throw mutationError(
        'UNSUPPORTED_ADAPTER_VERSION',
        'Agent editing requires an editable source and the tested pi-subagents adapter version.',
        422,
      );
    const file = discovery.getFileForMutation(input.fileId);
    if (!file || file.entry.kind !== 'agent' || !['global', 'project'].includes(file.entry.scope))
      throw mutationError(
        'SOURCE_READ_ONLY',
        'Only supported global or project agent files can be edited.',
        403,
      );
    const root =
      file.entry.scope === 'global'
        ? join(ctx.agentDirectory, 'agents')
        : join(ctx.cwd, '.pi', 'agents');
    const anchor = file.entry.scope === 'global' ? globalAnchor(ctx) : ctx.cwd;
    if (!isWithin(root, file.path) || !file.entry.editable || file.entry.packageName)
      throw mutationError(
        'SOURCE_READ_ONLY',
        'Agent source is not an authorized editable target.',
        403,
      );
    await checkSafePath(anchor, root, file.path, false);
    const bytes = await readFile(file.path);
    const before = bytes.toString('utf8');
    if (!Buffer.from(before, 'utf8').equals(bytes))
      throw mutationError('BINARY_SOURCE_UNSUPPORTED', 'Agent source is not valid UTF-8.', 422);
    const currentHash = sha256(bytes);
    if (input.expectedHash !== currentHash || input.expectedHash !== file.entry.versionHash)
      throw mutationError(
        'CONFLICT_EXTERNAL_CHANGE',
        'Agent source changed since it was loaded.',
        409,
        { expectedHash: input.expectedHash, currentHash },
      );
    const {
      content: after,
      beforeMetadata,
      afterMetadata,
    } = patchAgentSource(before, input.changes);
    validateText('agent', after, afterMetadata.name);
    const canonicalName = afterMetadata.package
      ? `${afterMetadata.package}.${afterMetadata.name}`
      : afterMetadata.name;
    if (canonicalName !== editor.frontmatter.name) {
      const conflict = discovery
        .getResources('agent')
        .find(
          (resource) => resource.source?.fileId !== input.fileId && resource.name === canonicalName,
        );
      if (conflict)
        throw mutationError(
          'AGENT_NAME_CONFLICT',
          'Another discovered agent already uses that name.',
          409,
        );
    }
    const validation = [];
    if (file.entry.scope === 'project' && discovery.getEnvironment().trust !== 'trusted')
      validation.push({
        code: 'UNTRUSTED_PROJECT',
        severity: 'warning',
        message:
          'Pi may not load this project agent until the project is trusted; Pinotator will not change trust.',
      });
    if (Object.hasOwn(input.changes.fields || {}, 'name'))
      validation.push({
        code: 'STALE_AGENT_OVERRIDES',
        severity: 'warning',
        message:
          'Settings overrides keyed by the previous agent name are not renamed automatically; review them after Apply.',
      });
    for (const key of Object.keys(input.changes.fields || {}))
      if (editor.effectiveFields?.[key]?.source?.includes('override'))
        validation.push({
          code: 'AGENT_OVERRIDE_PRECEDENCE',
          severity: 'warning',
          message: `A settings override may continue to take precedence over the ${key} frontmatter value.`,
        });
    const info = await stat(file.path);
    return {
      intent: 'update',
      path: file.path,
      allowedRoot: root,
      anchor,
      kind: 'agent',
      targetName: afterMetadata.name,
      displayPath: file.entry.displayPath,
      before,
      after,
      expectedHash: currentHash,
      sourceId: input.fileId,
      mode: modeOf(info),
      validation,
      reloadRequirement: 'pi-reload',
      beforeMetadata,
    };
  }

  async function prepareStructuredEdit(input, discovery, ctx) {
    const file = discovery.getFileForMutation(input.fileId);
    if (!file)
      throw mutationError(
        'SOURCE_NOT_FOUND',
        'Source ID is not part of the current workspace inventory.',
        404,
      );
    const kind =
      input.intent === 'set-provider'
        ? 'models'
        : input.intent === 'set-mcp'
          ? 'mcp'
          : 'keybindings';
    if (file.entry.kind !== kind || !['global', 'project'].includes(file.entry.scope))
      throw mutationError(
        'SOURCE_READ_ONLY',
        `Only recognized global or project ${kind}.json files support structured editing.`,
        403,
      );
    const root = file.entry.scope === 'global' ? ctx.agentDirectory : join(ctx.cwd, '.pi');
    const anchor = file.entry.scope === 'global' ? globalAnchor(ctx) : ctx.cwd;
    const fileName = `${kind}.json`;
    if (resolve(file.path) !== resolve(join(root, fileName)))
      throw mutationError(
        'PATH_OUTSIDE_ALLOWED_ROOT',
        'Structured source does not match its authorized configuration target.',
        403,
      );
    await checkSafePath(anchor, root, file.path, false);
    const bytes = await readFile(file.path);
    if (!Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes))
      throw mutationError('BINARY_SOURCE_UNSUPPORTED', `${fileName} is not valid UTF-8.`, 422);
    const currentHash = sha256(bytes);
    if (input.expectedHash !== currentHash || input.expectedHash !== file.entry.versionHash)
      throw mutationError(
        'CONFLICT_EXTERNAL_CHANGE',
        `${fileName} changed since it was loaded.`,
        409,
        { expectedHash: input.expectedHash, currentHash },
      );
    const before = bytes.toString('utf8');
    let after,
      targetName,
      validation = [];
    if (input.intent === 'set-provider') {
      after = validateModelChange(before, input.change);
      targetName = input.change.providerId;
    } else if (input.intent === 'set-mcp') {
      after = validateMcpChange(before, input.change, file.entry.scope);
      targetName = input.change.serverName;
      if (file.entry.scope === 'project' && discovery.getEnvironment().trust !== 'trusted')
        validation.push({
          code: 'UNTRUSTED_PROJECT',
          severity: 'warning',
          message: 'Pi may not load this project MCP configuration until the project is trusted.',
        });
    } else {
      after = validateKeybindingChange(before, input.change);
      targetName = input.change.action;
      validation.push({
        code: 'DEFAULT_KEYBINDINGS_UNVERIFIED',
        severity: 'warning',
        message:
          'Collisions with Pi built-in or extension keybindings are not statically available; verify in Pi with /hotkeys.',
      });
      if (discovery.getEnvironment().piVersion !== TESTED_PI_VERSION)
        validation.push({
          code: 'PI_VERSION_UNVERIFIED',
          severity: 'warning',
          message: `Key grammar was reviewed against Pi ${TESTED_PI_VERSION}; installed Pi version is ${discovery.getEnvironment().piVersion || 'unknown'}.`,
        });
    }
    if (
      input.intent !== 'set-keybinding' &&
      discovery.getEnvironment().piVersion !== TESTED_PI_VERSION
    )
      validation.push({
        code: 'PI_VERSION_UNVERIFIED',
        severity: 'warning',
        message: `Structured schema behavior was reviewed against Pi ${TESTED_PI_VERSION}; installed Pi version is ${discovery.getEnvironment().piVersion || 'unknown'}.`,
      });
    const info = await stat(file.path);
    return {
      intent: 'update',
      structured: true,
      path: file.path,
      allowedRoot: root,
      anchor,
      kind,
      targetName,
      displayPath: file.entry.displayPath,
      before,
      after,
      expectedHash: currentHash,
      sourceId: input.fileId,
      mode: modeOf(info),
      validation,
      reloadRequirement: 'pi-reload',
    };
  }

  async function prepareEdit(input, discovery): Promise<PreparedEdit> {
    const ctx = getContext();
    if (input.intent === 'set-agent') return prepareAgentEdit(input, discovery, ctx);
    if (['set-provider', 'set-mcp', 'set-keybinding'].includes(input.intent))
      return prepareStructuredEdit(input, discovery, ctx);
    if (input.intent === 'create') {
      const target = targetFor(input.createTarget, ctx);
      validateText(
        target.kind,
        input.content,
        target.targetName || targetNameFromPath(target.path),
      );
      await checkSafePath(target.anchor, target.allowedRoot, target.path, true);
      if (
        await lstat(target.path).then(
          () => true,
          (error) => (error.code === 'ENOENT' ? false : Promise.reject(error)),
        )
      )
        throw mutationError('TARGET_EXISTS', 'Target file already exists.', 409);
      if (target.kind === 'agent') {
        const packages = discovery.getResources('package');
        const declaredIn = (scope) =>
          packages.some(
            (item) =>
              !item.installed &&
              item.scope === scope &&
              /(^|[/:])pi-subagents(?:$|[@/])/i.test(item.name),
          );
        const supported = packages.some(
          (item) =>
            item.installed &&
            item.name === 'pi-subagents' &&
            item.version === TESTED_PI_SUBAGENTS_VERSION &&
            ((item.scope === 'global' && declaredIn('global')) ||
              (item.scope === 'project' &&
                discovery.getEnvironment().trust === 'trusted' &&
                declaredIn('project'))),
        );
        if (!supported)
          throw mutationError(
            'UNSUPPORTED_ADAPTER_VERSION',
            'A tested pi-subagents installation is required before creating agent files.',
            422,
          );
      }
      const validation =
        input.createTarget.scope === 'project' && discovery.getEnvironment().trust !== 'trusted'
          ? [
              {
                code: 'UNTRUSTED_PROJECT',
                severity: 'warning',
                message:
                  'Pi may not load this project resource until the project is trusted; Pinotator will not change trust.',
              },
            ]
          : input.createTarget.scope === 'portable-project'
            ? [
                {
                  code: 'PORTABLE_SKILL_RUNTIME_UNKNOWN',
                  severity: 'warning',
                  message:
                    'Portable project skill activation and trust behavior are not verified by this build.',
                },
              ]
            : [];
      return {
        intent: 'create',
        path: target.path,
        allowedRoot: target.allowedRoot,
        anchor: target.anchor,
        kind: target.kind,
        targetName: target.targetName || targetNameFromPath(target.path),
        displayPath: target.path,
        before: '',
        after: input.content,
        expectedHash: null,
        sourceId: undefined,
        validation,
        reloadRequirement: 'pi-reload',
      };
    }
    const file = discovery.getFileForMutation(input.fileId);
    if (!file)
      throw mutationError(
        'SOURCE_NOT_FOUND',
        'Source ID is not part of the current workspace inventory.',
        404,
      );
    if (input.intent === 'set-setting' || input.intent === 'set-settings') {
      if (
        file.entry.kind !== 'settings' ||
        (file.entry.scope !== 'global' && file.entry.scope !== 'project')
      )
        throw mutationError(
          'SOURCE_READ_ONLY',
          'Only recognized global or project settings.json files support targeted field edits.',
          403,
        );
      const root = file.entry.scope === 'global' ? ctx.agentDirectory : join(ctx.cwd, '.pi');
      const anchor = file.entry.scope === 'global' ? globalAnchor(ctx) : ctx.cwd;
      if (resolve(file.path) !== resolve(join(root, 'settings.json')))
        throw mutationError(
          'PATH_OUTSIDE_ALLOWED_ROOT',
          'Settings source does not match its authorized target.',
          403,
        );
      await checkSafePath(anchor, root, file.path, false);
      const current = await readFile(file.path);
      if (!Buffer.from(current.toString('utf8'), 'utf8').equals(current))
        throw mutationError(
          'BINARY_SOURCE_UNSUPPORTED',
          'Non-UTF-8 settings files cannot be safely edited.',
          422,
        );
      const currentHash = sha256(current);
      if (input.expectedHash !== currentHash || input.expectedHash !== file.entry.versionHash)
        throw mutationError(
          'CONFLICT_EXTERNAL_CHANGE',
          'Settings changed since it was loaded.',
          409,
          { expectedHash: input.expectedHash, currentHash },
        );
      const before = current.toString('utf8');
      const changes =
        input.intent === 'set-setting' ? [{ path: input.path, value: input.value }] : input.changes;
      const seenPaths = new Set();
      let after = before;
      for (const change of changes) {
        const key = change.path.join('.');
        if (seenPaths.has(key))
          throw mutationError(
            'DUPLICATE_SETTING_PATH',
            'A settings preset cannot modify the same field twice.',
          );
        seenPaths.add(key);
        after = renderSettingEdit(after, change.path, change.value, file.entry.scope);
      }
      const statInfo = await stat(file.path);
      const validation =
        discovery.getEnvironment().piVersion !== TESTED_PI_VERSION
          ? [
              {
                code: 'PI_VERSION_UNVERIFIED',
                severity: 'warning',
                message: `Settings schema behavior was reviewed against Pi ${TESTED_PI_VERSION}; installed Pi version is ${discovery.getEnvironment().piVersion || 'unknown'}.`,
              },
            ]
          : [];
      const paths = changes.map((change) => change.path.join('.'));
      return {
        intent: 'update',
        path: file.path,
        allowedRoot: root,
        anchor,
        kind: 'settings',
        targetName: paths.join(', '),
        displayPath: file.entry.displayPath,
        before,
        after,
        expectedHash: currentHash,
        sourceId: input.fileId,
        mode: modeOf(statInfo),
        validation,
        reloadRequirement: paths.some((path) =>
          ['defaultModel', 'defaultProvider', 'defaultThinkingLevel'].includes(path),
        )
          ? 'new-session'
          : 'pi-reload',
      };
    }
    const target = existingTarget(file, ctx);
    await checkSafePath(target.anchor, target.allowedRoot, target.path, false);
    const current = await readFile(target.path);
    if (!Buffer.from(current.toString('utf8'), 'utf8').equals(current))
      throw mutationError(
        'BINARY_SOURCE_UNSUPPORTED',
        'Non-UTF-8 source files cannot be safely edited.',
        422,
      );
    const currentHash = sha256(current);
    if (input.expectedHash !== currentHash || input.expectedHash !== file.entry.versionHash)
      throw mutationError(
        'CONFLICT_EXTERNAL_CHANGE',
        'Source changed since it was loaded. Refresh and compare before staging.',
        409,
        { expectedHash: input.expectedHash, currentHash },
      );
    const before = current.toString('utf8');
    if (SECRET_PATTERN.test(before) || SENSITIVE_LINE.test(before))
      throw mutationError(
        'SECRET_BEARING_FILE',
        'This source contains credential-like content and cannot be safely diffed in the browser.',
        403,
      );
    let after = input.intent === 'delete' ? '' : before;
    if (input.intent === 'update') {
      validateText(target.kind, input.content, target.targetName);
      after = input.content;
    }
    const statInfo = await stat(target.path);
    return {
      intent: input.intent,
      path: target.path,
      allowedRoot: target.allowedRoot,
      anchor: target.anchor,
      kind: target.kind,
      targetName: target.targetName,
      displayPath: file.entry.displayPath,
      before,
      after,
      expectedHash: currentHash,
      sourceId: input.fileId,
      mode: modeOf(statInfo),
      validation:
        target.kind === 'extension'
          ? [
              {
                code: 'EXTENSION_SYNTAX_UNVERIFIED',
                severity: 'warning',
                message:
                  'Extension syntax and runtime behavior were not checked; inspect the diff and verify with Pi before relying on this code.',
              },
            ]
          : [],
      reloadRequirement: target.kind === 'extension' ? 'new-session' : 'pi-reload',
    };
  }

  return {
    ready,
    async list() {
      await ready;
      return [...changes.values()].filter((item) => !item.recovery).map(publicChange);
    },
    async get(id) {
      await ready;
      const item = changes.get(id);
      return item && !item.recovery ? publicChange(item) : null;
    },
    async recovery() {
      await ready;
      return [...changes.values()]
        .filter((item) => item.recovery)
        .map((item) => ({
          id: item.id,
          status: item.status,
          updatedAt: item.updatedAt,
          operation: item.operation || 'apply',
          files: (item.files || []).map((file) => file.displayPath),
        }));
    },
    async propose(payload) {
      await ready;
      if (readOnly) throw mutationError('READ_ONLY', 'This Pinotator instance is read-only.', 403);
      if ([...changes.values()].some((item) => item.recovery))
        throw mutationError(
          'RECOVERY_REQUIRED',
          'Inspect and resolve the incomplete transaction before staging new edits.',
          409,
        );
      const parsed = proposalSchema.safeParse(payload);
      if (!parsed.success)
        throw mutationError(
          'INVALID_INPUT',
          parsed.error.issues.map((issue) => issue.message).join(' '),
          400,
        );
      const discovery = await getDiscovery();
      const edits = [];
      const targets = new Set();
      for (const input of parsed.data.edits) {
        const edit = await prepareEdit(input, discovery);
        const key = resolve(edit.path);
        if (targets.has(key))
          throw mutationError(
            'DUPLICATE_TARGET',
            'A changeset cannot edit the same file more than once.',
            400,
          );
        targets.add(key);
        edit.afterHash = edit.intent === 'delete' ? null : sha256(edit.after);
        edit.diff = makeDiff(edit.displayPath, edit.before, edit.after, edit.kind);
        edits.push(edit);
      }
      const validation = edits.flatMap((edit) => edit.validation);
      const predictedEffects = edits
        .map((edit) => {
          const resourceMatches = edit.sourceId
            ? discovery
                .getResources()
                .filter((resource) => resource.source?.fileId === edit.sourceId)
            : [];
          return resourceMatches.length
            ? resourceMatches.map((resource) => ({
                resourceId: resource.id,
                before: resource.state,
                after: 'unknown',
              }))
            : [
                {
                  resourceId: null,
                  name: edit.targetName,
                  before: 'absent',
                  after: edit.intent === 'delete' ? 'absent' : 'unknown',
                },
              ];
        })
        .flat();
      const id = randomUUID();
      const change = {
        id,
        status: validation.some((item) => item.severity === 'error') ? 'failed' : 'validated',
        createdAt: new Date().toISOString(),
        validation,
        predictedEffects,
        edits,
      };
      changes.set(id, change);
      return publicChange(change);
    },
    async validate(payload) {
      await ready;
      const { changeSetId } = idSchema.parse(payload);
      const change = changes.get(changeSetId);
      if (!change || change.recovery)
        throw mutationError('CHANGE_NOT_FOUND', 'Change set not found.', 404);
      if (['applied', 'rolled_back'].includes(change.status))
        throw mutationError(
          'CHANGE_COMPLETED',
          'Completed changesets cannot be revalidated or reapplied.',
          409,
        );
      const issues = change.edits.flatMap((edit) =>
        (edit.validation || []).filter((issue) => issue.severity === 'warning'),
      );
      for (const edit of change.edits) {
        try {
          await checkSafePath(edit.anchor, edit.allowedRoot, edit.path, edit.intent === 'create');
          if (edit.intent === 'create') {
            if (
              await lstat(edit.path).then(
                () => true,
                (error) => (error.code === 'ENOENT' ? false : Promise.reject(error)),
              )
            )
              issues.push({
                code: 'TARGET_EXISTS',
                severity: 'error',
                message: 'Create target now exists.',
              });
          } else {
            const bytes = await readFile(edit.path);
            const currentHash = sha256(bytes);
            if (currentHash !== edit.expectedHash)
              issues.push({
                code: 'CONFLICT_EXTERNAL_CHANGE',
                severity: 'error',
                message: 'Source changed after staging.',
                sourceId: edit.sourceId,
              });
            if (edit.intent === 'update' && !edit.structured)
              validateText(edit.kind, edit.after, edit.targetName);
            if (edit.structured) parseConfigObject(edit.after, `${edit.kind}.json`);
          }
        } catch (error) {
          issues.push({
            code: error.code || 'VALIDATION_FAILED',
            severity: 'error',
            message: error.message,
          });
        }
      }
      change.validation = issues;
      change.status = issues.some((issue) => issue.severity === 'error') ? 'conflict' : 'validated';
      return publicChange(change);
    },
    async recover(payload) {
      await ready;
      if (readOnly) throw mutationError('READ_ONLY', 'This Pinotator instance is read-only.', 403);
      const { journalId } = recoverySchema.parse(payload);
      const key = `recovery:${journalId}`;
      const journal = changes.get(key);
      if (!journal || !journal.recovery)
        throw mutationError(
          'RECOVERY_NOT_FOUND',
          'No incomplete transaction with that ID was found.',
          404,
        );
      await ensurePrivateDirectory(stateRoot);
      await ensurePrivateDirectory(journalsRoot);
      await ensurePrivateDirectory(backupsRoot);
      const isRollback = journal.operation === 'rollback';
      const effects = [];
      for (const file of journal.files || []) {
        await checkSafePath(file.anchor, file.allowedRoot, file.path, true);
        const current = await lstat(file.path).then(
          async (info) => (info.isFile() ? sha256(await readFile(file.path)) : 'not-file'),
          (error) => (error.code === 'ENOENT' ? null : Promise.reject(error)),
        );
        const beforeState = current === file.expectedHash;
        const afterState = current === file.afterHash;
        if (!beforeState && !afterState)
          throw mutationError(
            'CONFLICT_EXTERNAL_CHANGE',
            'A source changed after the interrupted transaction; recovery will not overwrite it.',
            409,
            { displayPath: file.displayPath, currentHash: current },
          );
        effects.push({ file, needsRestore: isRollback ? afterState : afterState });
      }
      for (let i = effects.length - 1; i >= 0; i--) {
        const { file, needsRestore } = effects[i];
        if (!needsRestore) continue;
        await checkSafePath(file.anchor, file.allowedRoot, file.path, true);
        if (file.backupFile) {
          if (!/^[a-f0-9-]+-[0-9]+\.bak$/.test(file.backupFile))
            throw mutationError('RECOVERY_INVALID', 'Backup reference failed validation.', 500);
          const backup = await readBackup(backupsRoot, file.backupFile);
          await atomicWrite(file.path, backup, file.mode || 0o600, async () => {
            await checkSafePath(file.anchor, file.allowedRoot, file.path, true);
          });
        } else await unlink(file.path);
      }
      journal.status = isRollback ? 'rolled_back' : 'recovered';
      journal.recoveredAt = new Date().toISOString();
      journal.updatedAt = journal.recoveredAt;
      await writeJsonAtomic(join(journalsRoot, `${journal.id}.json`), journal);
      if (isRollback && journal.rollbackOf) {
        try {
          const originalPath = join(journalsRoot, `${journal.rollbackOf}.json`);
          const original = JSON.parse(await readFile(originalPath, 'utf8'));
          original.status = 'rolled_back';
          original.updatedAt = journal.updatedAt;
          await writeJsonAtomic(originalPath, original);
        } catch {}
        markRolledBack(journal.rollbackOf);
      }
      changes.delete(key);
      await refreshDiscovery().catch(() => {});
      publish('resource_changed', { generation: Date.now() });
      return {
        recovered: true,
        journalId,
        restoredFiles: effects
          .filter((item) => item.needsRestore)
          .map((item) => item.file.displayPath),
      };
    },
    async discard(payload) {
      await ready;
      const { changeSetId } = idSchema.parse(payload);
      const change = changes.get(changeSetId);
      if (!change || change.recovery)
        throw mutationError('CHANGE_NOT_FOUND', 'Change set not found.', 404);
      if (['applied', 'rolled_back'].includes(change.status))
        throw mutationError(
          'CHANGE_COMPLETED',
          'Completed changesets cannot be discarded; applied changes require rollback.',
          409,
        );
      changes.delete(changeSetId);
      return { discarded: true };
    },
    async apply(payload) {
      await ready;
      if (readOnly) throw mutationError('READ_ONLY', 'This Pinotator instance is read-only.', 403);
      const { changeSetId } = idSchema.parse(payload);
      const change = changes.get(changeSetId);
      if (!change || change.recovery)
        throw mutationError('CHANGE_NOT_FOUND', 'Change set not found.', 404);
      const checked = await this.validate({ changeSetId });
      if (checked.status !== 'validated')
        throw mutationError(
          'VALIDATION_FAILED',
          'Change set has conflicts or validation errors.',
          409,
          { validation: checked.validation },
        );
      await ensurePrivateDirectory(stateRoot);
      await ensurePrivateDirectory(journalsRoot);
      await ensurePrivateDirectory(backupsRoot);
      const appliedId = randomUUID();
      const journal: TransactionJournal = {
        id: appliedId,
        changeSetId,
        operation: 'apply',
        status: 'prepared',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        files: [],
      };
      for (let i = 0; i < change.edits.length; i++) {
        const edit = change.edits[i];
        const backupFile = edit.intent === 'create' ? null : `${appliedId}-${i}.bak`;
        if (backupFile) await atomicWrite(join(backupsRoot, backupFile), edit.before, 0o600);
        journal.files.push({
          displayPath: edit.displayPath,
          path: edit.path,
          allowedRoot: edit.allowedRoot,
          anchor: edit.anchor,
          intent: edit.intent,
          expectedHash: edit.expectedHash,
          afterHash: edit.afterHash,
          backupFile,
          mode: edit.mode || 0o600,
          kind: edit.kind,
          targetName: edit.targetName,
          sourceId: edit.sourceId,
          reloadRequirement: edit.reloadRequirement,
          diff: edit.diff,
          completed: false,
        });
      }
      const journalPath = join(journalsRoot, `${appliedId}.json`);
      await writeJsonAtomic(journalPath, journal);
      journal.status = 'applying';
      await writeJsonAtomic(journalPath, journal);
      try {
        for (let i = 0; i < change.edits.length; i++) {
          const edit = change.edits[i];
          await beforeCommitEdit(edit, i);
          await checkSafePath(edit.anchor, edit.allowedRoot, edit.path, edit.intent === 'create');
          const currentHash = edit.intent === 'create' ? null : sha256(await readFile(edit.path));
          if (currentHash !== edit.expectedHash)
            throw mutationError(
              'CONFLICT_EXTERNAL_CHANGE',
              `Source changed before commit: ${edit.displayPath}`,
              409,
            );
          if (edit.intent === 'delete') {
            await checkSafePath(edit.anchor, edit.allowedRoot, edit.path, false);
            if (sha256(await readFile(edit.path)) !== edit.expectedHash)
              throw mutationError(
                'CONFLICT_EXTERNAL_CHANGE',
                `Source changed at commit time: ${edit.displayPath}`,
                409,
              );
            await unlink(edit.path);
          } else {
            await mkdir(dirname(edit.path), { recursive: true, mode: 0o700 });
            await checkSafePath(edit.anchor, edit.allowedRoot, edit.path, true);
            await atomicWrite(edit.path, edit.after, edit.mode || 0o600, async () => {
              await checkSafePath(edit.anchor, edit.allowedRoot, edit.path, true);
              const latestHash = await lstat(edit.path).then(
                async (info) => (info.isFile() ? sha256(await readFile(edit.path)) : 'not-file'),
                (error) => (error.code === 'ENOENT' ? null : Promise.reject(error)),
              );
              if (latestHash !== edit.expectedHash)
                throw mutationError(
                  'CONFLICT_EXTERNAL_CHANGE',
                  `Source changed at commit time: ${edit.displayPath}`,
                  409,
                );
            });
          }
          const committedHash = edit.intent === 'delete' ? null : sha256(await readFile(edit.path));
          if (committedHash !== edit.afterHash)
            throw mutationError(
              'WRITE_VERIFY_FAILED',
              `Could not verify committed file: ${edit.displayPath}`,
              500,
            );
          journal.files[i].completed = true;
          journal.updatedAt = new Date().toISOString();
          await writeJsonAtomic(journalPath, journal);
        }
        journal.status = 'applied';
        journal.updatedAt = new Date().toISOString();
        await writeJsonAtomic(journalPath, journal);
      } catch (error) {
        journal.status = 'partial';
        journal.error = error.code || 'WRITE_FAILED';
        journal.updatedAt = new Date().toISOString();
        await writeJsonAtomic(journalPath, journal);
        let recovered = true;
        for (let i = journal.files.length - 1; i >= 0; i--) {
          const entry = journal.files[i];
          try {
            await checkSafePath(entry.anchor, entry.allowedRoot, entry.path, true);
            const actual = await lstat(entry.path).then(
              async (info) => (info.isFile() ? sha256(await readFile(entry.path)) : 'not-file'),
              (error) => (error.code === 'ENOENT' ? null : Promise.reject(error)),
            );
            if (actual === entry.afterHash) {
              if (entry.backupFile)
                await atomicWrite(
                  entry.path,
                  await readBackup(backupsRoot, entry.backupFile),
                  entry.mode,
                  async () => {
                    await checkSafePath(entry.anchor, entry.allowedRoot, entry.path, true);
                  },
                );
              else await unlink(entry.path);
              entry.recovered = true;
            } else if (actual !== entry.expectedHash) recovered = false;
          } catch {
            recovered = false;
          }
        }
        journal.status = recovered ? 'recovered' : 'partial';
        journal.updatedAt = new Date().toISOString();
        await writeJsonAtomic(journalPath, journal);
        if (!recovered) changes.set(`recovery:${journal.id}`, { ...journal, recovery: true });
        throw mutationError(
          recovered ? error.code || 'WRITE_FAILED' : 'PARTIAL_WRITE_RECOVERY',
          recovered
            ? 'Apply failed; already-written files were restored.'
            : 'Apply was interrupted and needs recovery review.',
          recovered ? error.status || 500 : 500,
          { journalId: appliedId },
        );
      }
      const rollbackToken = randomUUID();
      const record = {
        id: appliedId,
        changeSetId,
        rollbackToken,
        journalPath,
        journal,
        changeset: change,
        appliedAt: new Date().toISOString(),
      };
      applied.set(appliedId, record);
      change.status = 'applied';
      change.appliedId = appliedId;
      change.rollbackToken = rollbackToken;
      await refreshDiscovery().catch(() => {});
      publish('resource_changed', { generation: Date.now() });
      return {
        ...publicChange(change),
        appliedId,
        rollbackToken,
        files: change.edits.map((edit) => ({
          displayPath: edit.displayPath,
          hash: edit.afterHash,
        })),
        reloadRequirement: 'pi-reload',
      };
    },
    async rollback(payload) {
      await ready;
      if (readOnly) throw mutationError('READ_ONLY', 'This Pinotator instance is read-only.', 403);
      const { appliedId } = rollbackSchema.parse(payload);
      const record = applied.get(appliedId);
      if (!record)
        throw mutationError(
          'ROLLBACK_NOT_FOUND',
          'No retained rollback record exists for this applied change.',
          404,
        );
      const journal = record.journal;
      for (const file of journal.files) {
        const actual = await lstat(file.path).then(
          async (info) => (info.isFile() ? sha256(await readFile(file.path)) : 'not-file'),
          (error) => (error.code === 'ENOENT' ? null : Promise.reject(error)),
        );
        if (actual !== file.afterHash)
          throw mutationError(
            'CONFLICT_EXTERNAL_CHANGE',
            'A file changed after apply; rollback would overwrite newer work.',
            409,
            { displayPath: file.displayPath, expectedHash: file.afterHash, currentHash: actual },
          );
      }
      await ensurePrivateDirectory(stateRoot);
      await ensurePrivateDirectory(journalsRoot);
      await ensurePrivateDirectory(backupsRoot);
      const rollbackId = randomUUID();
      const rollbackPath = join(journalsRoot, `${rollbackId}.json`);
      const rollbackJournal: TransactionJournal = {
        id: rollbackId,
        rollbackOf: appliedId,
        operation: 'rollback',
        status: 'prepared',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        files: journal.files.map((file) => ({ ...file, rollbackCompleted: false })),
      };
      await writeJsonAtomic(rollbackPath, rollbackJournal);
      rollbackJournal.status = 'applying';
      await writeJsonAtomic(rollbackPath, rollbackJournal);
      try {
        for (let i = rollbackJournal.files.length - 1; i >= 0; i--) {
          const file = rollbackJournal.files[i];
          await checkSafePath(file.anchor, file.allowedRoot, file.path, true);
          const actual = await lstat(file.path).then(
            async (info) => (info.isFile() ? sha256(await readFile(file.path)) : 'not-file'),
            (error) => (error.code === 'ENOENT' ? null : Promise.reject(error)),
          );
          if (actual !== file.afterHash)
            throw mutationError('CONFLICT_EXTERNAL_CHANGE', 'File changed during rollback.', 409, {
              displayPath: file.displayPath,
            });
          if (file.backupFile) {
            const backup = await readBackup(backupsRoot, file.backupFile);
            await atomicWrite(file.path, backup, file.mode, async () => {
              await checkSafePath(file.anchor, file.allowedRoot, file.path, true);
              const latest = await lstat(file.path).then(
                async (info) => (info.isFile() ? sha256(await readFile(file.path)) : 'not-file'),
                (error) => (error.code === 'ENOENT' ? null : Promise.reject(error)),
              );
              if (latest !== file.afterHash)
                throw mutationError(
                  'CONFLICT_EXTERNAL_CHANGE',
                  'File changed during rollback.',
                  409,
                );
            });
          } else await unlink(file.path);
          file.rollbackCompleted = true;
          rollbackJournal.updatedAt = new Date().toISOString();
          await writeJsonAtomic(rollbackPath, rollbackJournal);
        }
        rollbackJournal.status = 'rolled_back';
        rollbackJournal.updatedAt = new Date().toISOString();
        await writeJsonAtomic(rollbackPath, rollbackJournal);
        journal.status = 'rolled_back';
        journal.updatedAt = rollbackJournal.updatedAt;
        await writeJsonAtomic(join(journalsRoot, `${journal.id}.json`), journal);
        markRolledBack(appliedId, rollbackJournal.updatedAt);
      } catch (error) {
        rollbackJournal.status = 'partial';
        rollbackJournal.error = error.code || 'ROLLBACK_FAILED';
        rollbackJournal.updatedAt = new Date().toISOString();
        await writeJsonAtomic(rollbackPath, rollbackJournal);
        changes.set(`recovery:${rollbackId}`, { ...rollbackJournal, recovery: true });
        throw mutationError(
          'PARTIAL_WRITE_RECOVERY',
          'Rollback was partial and needs recovery review.',
          500,
          { journalId: rollbackId },
        );
      }
      await refreshDiscovery().catch(() => {});
      publish('resource_changed', { generation: Date.now() });
      return {
        rolledBack: true,
        rollbackId,
        files: rollbackJournal.files.map((file) => file.displayPath),
      };
    },
  };
}

function targetNameFromPath(path) {
  return basename(dirname(path)) === 'skills' ? basename(path) : basename(path, extname(path));
}
