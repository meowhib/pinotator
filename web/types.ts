import type { ConfigRecord, Diagnostic, Discovery, FileEntry, Resource } from '../src/types.js';
import type { createAnalysisService } from '../src/analysis.js';
import type { createEffectiveRuntimeService } from '../src/effective-runtime.js';

export type AnalysisGraph = Awaited<ReturnType<ReturnType<typeof createAnalysisService>['graph']>>;
export type EffectiveRuntime = Awaited<
  ReturnType<ReturnType<typeof createEffectiveRuntimeService>['inspect']>
>;

export interface BrowserState {
  env: Omit<ReturnType<Discovery['getEnvironment']>, 'capabilities'> & {
    capabilities: Record<string, string | boolean>;
  };
  overview: ReturnType<Discovery['getOverview']>;
  resources: Resource[];
  files: FileEntry[];
  diagnostics: Diagnostic[];
  instructions: ReturnType<Discovery['getEffectiveInstructions']>;
  changes: ConfigRecord[];
  recovery: ConfigRecord[];
  snapshots: ConfigRecord[];
  effectiveRuntime: EffectiveRuntime;
}

export interface AgentChanges {
  fields?: ConfigRecord;
  body?: string;
}

export interface ProviderModel {
  id: string;
  name: string;
  reasoning: boolean;
  input: string[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: Record<string, number>;
}

export interface McpChange {
  operation: string;
  serverName: string;
  transport: string;
  enabled: boolean;
  exposure: string;
  description: string;
  timeout?: number;
  toolExposure?: Record<string, string>;
  url?: string;
  command?: string;
  args?: string[];
  envNames?: string[];
}
