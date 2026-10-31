import YAML from 'yaml';
import type { ConfigRecord } from '../types.js';

export interface ParsedAgentDefinition {
  metadata: ConfigRecord;
  body: string;
  error: string | null;
  unknownFields: string[];
}
export interface AgentResolutionOptions {
  userSettings?: ConfigRecord;
  projectSettings?: ConfigRecord;
  trust?: string;
  scope?: string;
  adapterVersion?: string | null;
}
interface FieldResolution {
  value: unknown;
  source: string;
}

import { ADAPTER_CONTRACT_VERSION } from './registry.js';

export const TESTED_PI_SUBAGENTS_VERSION = '0.84.0';
export const PI_SUBAGENTS_EDITOR_FIELDS = Object.freeze([
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
]);
const knownFields = new Set([
  'name',
  'package',
  'name',
  'package',
  'description',
  'advertise',
  'aliases',
  'tools',
  'excludeTools',
  'extensions',
  'subagentOnlyExtensions',
  'model',
  'thinking',
  'systemPromptMode',
  'inheritProjectContext',
  'inheritGlobalContext',
  'inheritSkills',
  'skills',
  'skillPath',
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
]);

export function parseAgentDefinition(text: string): ParsedAgentDefinition {
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/.exec(text);
  if (!match) return { metadata: {}, body: text, error: null, unknownFields: [] };
  try {
    const parsed = YAML.parse(match[1]);
    const metadata = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    return {
      metadata,
      body: text.slice(match[0].length),
      error: null,
      unknownFields: Object.keys(metadata).filter((key) => !knownFields.has(key)),
    };
  } catch (error) {
    return {
      metadata: {},
      body: text.slice(match[0].length),
      error: error.message,
      unknownFields: [],
    };
  }
}

function valueAt(object: ConfigRecord, path: string) {
  return path
    .split('.')
    .reduce((node, key) => (node && typeof node === 'object' ? node[key] : undefined), object);
}
function chooseOverride(settings: ConfigRecord, agentName: string, field: string) {
  const record = settings?.subagents?.agentOverrides?.[agentName];
  return record && typeof record === 'object' && Object.hasOwn(record, field)
    ? record[field]
    : undefined;
}
function chooseField(
  agent: { name: string; canonicalName: string; metadata: ConfigRecord },
  settings: ConfigRecord,
  projectSettings: ConfigRecord,
  field: string,
  defaultField: string,
  trust: string,
  fallback: unknown,
): FieldResolution {
  const project =
    trust === 'trusted'
      ? (chooseOverride(projectSettings, agent.canonicalName, field) ??
        chooseOverride(projectSettings, agent.name, field))
      : undefined;
  const user =
    chooseOverride(settings, agent.canonicalName, field) ??
    chooseOverride(settings, agent.name, field);
  if (project !== undefined) return { value: project, source: 'project-settings-override' };
  if (user !== undefined) return { value: user, source: 'global-settings-override' };
  if (agent.metadata[field] !== undefined)
    return { value: agent.metadata[field], source: 'frontmatter' };
  const projectDefault =
    trust === 'trusted' ? valueAt(projectSettings, `subagents.${defaultField}`) : undefined;
  const userDefault = valueAt(settings, `subagents.${defaultField}`);
  if (projectDefault !== undefined)
    return { value: projectDefault, source: 'project-settings-default' };
  if (userDefault !== undefined) return { value: userDefault, source: 'global-settings-default' };
  return { value: fallback, source: 'inherited' };
}

export function resolveAgentDefinition(
  parsed: ParsedAgentDefinition,
  {
    userSettings = {},
    projectSettings = {},
    trust = 'unknown',
    scope = 'global',
    adapterVersion = null,
  }: AgentResolutionOptions = {},
) {
  const metadata = parsed.metadata || {};
  const name = String(metadata.name || '').trim();
  const canonicalName = metadata.package && name ? `${metadata.package}.${name}` : name;
  const agent = { name, canonicalName, metadata };
  const supported = adapterVersion === TESTED_PI_SUBAGENTS_VERSION;
  const model = chooseField(
    agent,
    userSettings,
    projectSettings,
    'model',
    'defaultModel',
    trust,
    'inherit',
  );
  const thinking = chooseField(
    agent,
    userSettings,
    projectSettings,
    'thinking',
    'defaultThinking',
    trust,
    undefined,
  );
  const projectProviderOverrides =
    trust === 'trusted'
      ? valueAt(projectSettings, 'subagents.agentOverridesByProvider')
      : undefined;
  const userProviderOverrides = valueAt(userSettings, 'subagents.agentOverridesByProvider');
  const providerOverrides = {
    ...(userProviderOverrides || {}),
    ...(projectProviderOverrides || {}),
  };
  const providerDependentOverride = Object.values(providerOverrides).some(
    (records) => records && (records[canonicalName] || records[name]),
  );
  const effectiveModel = providerDependentOverride
    ? { value: model.value, source: 'provider-scoped-override-may-apply', certainty: 'unknown' }
    : {
        ...model,
        certainty: !supported ? 'unknown' : model.value === 'inherit' ? 'runtime-only' : 'static',
      };
  const trustBlocked = (scope === 'project' || scope === 'ancestor') && trust === 'untrusted';
  const effectiveFields: Record<string, FieldResolution> = {};
  for (const field of [
    'description',
    'tools',
    'excludeTools',
    'systemPromptMode',
    'inheritProjectContext',
    'inheritGlobalContext',
    'inheritSkills',
    'skills',
    'extensions',
    'allowedAgents',
    'disabled',
  ]) {
    effectiveFields[field] = chooseField(
      agent,
      userSettings,
      projectSettings,
      field,
      '__none__',
      trust,
      undefined,
    );
  }
  return {
    canonicalName,
    model: effectiveModel,
    thinking: { ...thinking, certainty: supported ? 'static' : 'unknown' },
    effectiveFields,
    adapter: {
      id: 'pi-subagents',
      version: adapterVersion || 'unknown',
      tested: supported,
      compatibility: supported ? 'supported' : 'unknown',
    },
    state: trustBlocked ? 'untrusted' : 'unknown',
    unknownFields: parsed.unknownFields || [],
    diagnostics: [
      ...(parsed.error ? ['Invalid YAML frontmatter.'] : []),
      ...(!supported ? ['Adapter schema version is not in this build’s tested version set.'] : []),
      ...(effectiveModel.certainty === 'runtime-only'
        ? [
            'Model is inherited from the parent session and cannot be fixed without session context.',
          ]
        : []),
      ...(providerDependentOverride
        ? ['A provider-scoped override may change this model depending on the parent provider.']
        : []),
    ],
  };
}

export const piSubagentsAdapter = Object.freeze({
  id: 'pi-subagents',
  contractVersion: ADAPTER_CONTRACT_VERSION,
  testedVersions: Object.freeze([TESTED_PI_SUBAGENTS_VERSION]),
  parse: parseAgentDefinition,
  resolve: resolveAgentDefinition,
  describe: () => ({
    status: 'static-only',
    message: 'Agent files and settings are parsed without loading extension code.',
  }),
});
