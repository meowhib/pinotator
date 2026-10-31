/** Configuration/plugin schemas are open-ended. Runtime parsers and redaction still
 * validate these records before they cross the API or filesystem boundary. */
export type ConfigRecord = Record<string, any>;

export interface ManagerContext {
  cwd: string;
  home: string;
  agentDirectory: string;
  mode: 'global' | 'project';
  readOnly?: boolean;
  projectTrust?: string;
  repoRoot?: string;
  stateDirectory?: string;
}

export interface Diagnostic {
  code: string;
  severity: string;
  message: string;
  sourceId?: string;
}

export interface FileEntry extends ConfigRecord {
  id: string;
  displayPath: string;
  scope: string;
  owner: string;
  kind: string;
  versionHash: string;
  size: number;
  modifiedAt: string;
  editable: boolean;
  trust: string;
}

export interface StoredFile {
  entry: FileEntry;
  path: string;
  raw: string;
  bytes: Buffer;
  allowContent: boolean;
}

export interface Resource extends ConfigRecord {
  id: string;
  kind: string;
  name: string;
  description: string;
  state: string;
  scope: string;
  owner: string;
  source?: {
    fileId: string;
    displayPath: string;
    scope: string;
    owner: string;
    packageName?: string;
    versionHash: string;
    trust: string;
  };
  diagnostics: Diagnostic[];
  explanation: string[];
}

export interface PreparedEdit {
  intent: string;
  path: string;
  allowedRoot: string;
  anchor: string;
  kind: string;
  targetName?: string;
  displayPath: string;
  before: string;
  after: string;
  expectedHash: string | null;
  sourceId?: string;
  mode?: number;
  validation: Diagnostic[];
  reloadRequirement: string;
  beforeMetadata?: ConfigRecord;
  afterHash?: string | null;
  diff?: string;
}

export interface TransactionJournal {
  id: string;
  changeSetId?: string;
  rollbackOf?: string;
  operation: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  files: ConfigRecord[];
  error?: string;
}

export type Discovery = Awaited<ReturnType<typeof import('./discovery.js').createDiscovery>>;
export type GetDiscovery = () => Promise<Discovery>;
