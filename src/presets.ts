import type { GetDiscovery, ManagerContext } from './types.js';
import { z } from 'zod';
import { isAbsolute } from 'node:path';
import { parse as parseJson } from 'jsonc-parser';
import { isSettingPresetPath } from './mutations.js';

const exportSchema = z
  .object({
    fileId: z.string().uuid(),
    name: z.string().trim().min(1).max(80).default('Pi settings preset'),
    confirmed: z.literal(true),
  })
  .strict();
const stageSchema = z
  .object({
    fileId: z.string().uuid(),
    expectedHash: z.string().regex(/^[a-f0-9]{64}$/),
    presetBase64: z.string().max(1_500_000),
    filename: z.string().max(120),
    confirmed: z.literal(true),
  })
  .strict();
const SECRET =
  /\b(?:sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._~-]{16,})\b|https?:\/\/[^/@\s]+:[^/@\s]+@[^\s]+|[?&](?:api[_-]?key|token|secret|password)=/i;
const SCALAR_PATHS = [
  ['defaultModel'],
  ['defaultProvider'],
  ['defaultThinkingLevel'],
  ['modelThinkingLevels'],
  ['enabledModels'],
  ['defaultTools'],
  ['enableSkillCommands'],
  ['steeringMode'],
  ['followUpMode'],
  ['tuiMode'],
  ['theme'],
  ['quietStartup'],
];
function fail(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status });
}
function getPath(value, path) {
  return path.reduce(
    (node, key) => (node && typeof node === 'object' ? node[key] : undefined),
    value,
  );
}
function candidatePaths(settings) {
  const paths = [...SCALAR_PATHS];
  for (const field of ['enabled', 'reserveTokens', 'keepRecentTokens'])
    if (settings.compaction && Object.hasOwn(settings.compaction, field))
      paths.push(['compaction', field]);
  for (const field of ['enabled', 'maxRetries', 'baseDelayMs', 'maxAgentDelayMs'])
    if (settings.retry && Object.hasOwn(settings.retry, field)) paths.push(['retry', field]);
  for (const field of ['timeoutMs', 'maxRetries', 'maxRetryDelayMs'])
    if (settings.retry?.provider && Object.hasOwn(settings.retry.provider, field))
      paths.push(['retry', 'provider', field]);
  for (const field of ['defaultModel', 'defaultThinking', 'defaultProvider', 'agentScope'])
    if (settings.subagents && Object.hasOwn(settings.subagents, field))
      paths.push(['subagents', field]);
  for (const [agent, overrides] of Object.entries(settings.subagents?.agentOverrides || {}))
    if (/^[A-Za-z0-9_-]{1,80}$/.test(agent) && overrides && typeof overrides === 'object')
      for (const field of [
        'model',
        'defaultProvider',
        'thinking',
        'tools',
        'inheritProjectContext',
        'inheritGlobalContext',
        'inheritSkills',
        'systemPromptMode',
      ])
        if (Object.hasOwn(overrides, field))
          paths.push(['subagents', 'agentOverrides', agent, field]);
  return paths;
}
function parseSettings(raw) {
  const errors = [];
  const value = parseJson(raw, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length || !value || typeof value !== 'object' || Array.isArray(value))
    throw fail('INVALID_SETTINGS', 'Settings file is not valid JSONC.', 422);
  return value;
}
function validateValue(path, value) {
  if (!isSettingPresetPath(path))
    throw fail('UNSUPPORTED_SETTING', `Preset setting ${path.join('.')} is not supported.`, 422);
  let visited = 0;
  const inspect = (item, depth = 0) => {
    if (depth > 8 || ++visited > 2000)
      throw fail('INVALID_PRESET', 'Preset value exceeds safe structural limits.', 413);
    if (Array.isArray(item)) {
      item.forEach((child) => inspect(child, depth + 1));
      return;
    }
    if (item && typeof item === 'object') {
      for (const [key, child] of Object.entries(item)) {
        if (
          /(api.?key|secret|token|password|authorization|credential|private.?key|client.?secret|headers|oauth)/i.test(
            key,
          )
        )
          throw fail('SECRET_BEARING_CONTENT', 'Preset contains credential-like fields.', 422);
        inspect(child, depth + 1);
      }
      return;
    }
    if (
      typeof item === 'string' &&
      (SECRET.test(item) ||
        isAbsolute(item) ||
        /^[A-Za-z]:\\/.test(item) ||
        /https?:\/\/[^\s?#]+\?[^\s]*/i.test(item) ||
        /(?:api[_-]?key|secret|token|password|authorization|credential)\s*[:=]/i.test(item))
    )
      throw fail('SECRET_BEARING_CONTENT', 'Preset contains credential-like content.', 422);
  };
  inspect(value);
}
export function createPresetService({
  getDiscovery,
  propose,
}: {
  getDiscovery: GetDiscovery;
  propose: (payload: unknown) => Promise<any>;
}) {
  return {
    async exportPreset(payload) {
      const request = exportSchema.parse(payload);
      const discovery = await getDiscovery();
      const file = discovery.getFileForMutation(request.fileId);
      if (
        !file ||
        file.entry.kind !== 'settings' ||
        !['global', 'project'].includes(file.entry.scope)
      )
        throw fail(
          'SOURCE_READ_ONLY',
          'Choose a recognized global or project settings.json file.',
          403,
        );
      const settings = parseSettings(file.raw);
      const paths = candidatePaths(settings);
      const values = [];
      for (const path of paths) {
        if (!isSettingPresetPath(path)) continue;
        const value = getPath(settings, path);
        if (value === undefined) continue;
        try {
          validateValue(path, value);
          values.push({ path, value });
        } catch {}
      }
      return {
        schemaVersion: 1,
        name: request.name,
        exportedAt: new Date().toISOString(),
        settings: values,
      };
    },
    async stagePreset(payload) {
      const request = stageSchema.parse(payload);
      const discovery = await getDiscovery();
      const file = discovery.getFileForMutation(request.fileId);
      if (
        !file ||
        file.entry.kind !== 'settings' ||
        !['global', 'project'].includes(file.entry.scope)
      )
        throw fail(
          'SOURCE_READ_ONLY',
          'Choose a recognized global or project settings.json file.',
          403,
        );
      if (
        !/^[A-Za-z0-9._ -]{1,120}$/.test(request.filename) ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
          request.presetBase64,
        )
      )
        throw fail('INVALID_PRESET', 'Preset upload is not valid base64 JSON.');
      const bytes = Buffer.from(request.presetBase64, 'base64');
      if (bytes.length > 1_000_000) throw fail('PRESET_TOO_LARGE', 'Preset exceeds 1 MiB.', 413);
      let preset;
      try {
        preset = JSON.parse(bytes.toString('utf8'));
      } catch {
        throw fail('INVALID_PRESET', 'Preset is not valid JSON.');
      }
      if (
        preset?.schemaVersion !== 1 ||
        typeof preset.name !== 'string' ||
        !Array.isArray(preset.settings) ||
        preset.settings.length < 1 ||
        preset.settings.length > 40
      )
        throw fail('INVALID_PRESET', 'Preset schema is unsupported or has no settings.');
      const seen = new Set();
      const changes = preset.settings.map((item) => {
        const change = z
          .object({ path: z.array(z.string()).min(1).max(4), value: z.unknown() })
          .strict()
          .parse(item);
        const key = change.path.join('.');
        if (seen.has(key)) throw fail('INVALID_PRESET', 'Preset contains duplicate setting paths.');
        seen.add(key);
        validateValue(change.path, change.value);
        return change;
      });
      return propose({
        edits: [
          {
            intent: 'set-settings',
            fileId: request.fileId,
            expectedHash: request.expectedHash,
            changes,
          },
        ],
      });
    },
  };
}
