import type { GetDiscovery, ManagerContext } from './types.js';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { findInstalledPiPackage, VERIFIED_PI_RUNTIME_VERSION } from './effective-runtime.js';

const requestSchema = z
  .object({
    resourceId: z.string().uuid(),
    expectedHash: z.string().regex(/^[a-f0-9]{64}$/),
    arguments: z.string().max(8192),
    confirmed: z.literal(true),
  })
  .strict();
const SECRET_PATTERN =
  /\b(?:sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._~-]{16,})\b|https?:\/\/[^/@\s]+:[^/@\s]+@[^\s]+|[?&](?:api[_-]?key|token|secret|password)=/i;
const SENSITIVE_LINE =
  /^\s*(?:api[_-]?key|secret|token|password|authorization|credential|private[_-]?key|client[_-]?secret|access[_-]?key)\s*[:=]\s*\S/im;
function error(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status });
}
function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function createPromptPlaygroundService(options: {
  getDiscovery: GetDiscovery;
  loadPromptModule?: (packageRoot: string) => Promise<any>;
}) {
  const { getDiscovery, loadPromptModule } = options;
  const importPromptModule =
    loadPromptModule ||
    ((packageRoot) =>
      import(pathToFileURL(join(packageRoot, 'dist', 'core', 'prompt-templates.js')).href));

  return {
    async expand(payload) {
      const parsed = requestSchema.safeParse(payload);
      if (!parsed.success)
        throw error('INVALID_INPUT', parsed.error.issues.map((issue) => issue.message).join(' '));
      const discovery = await getDiscovery();
      const resource = discovery.getResource(parsed.data.resourceId);
      if (
        !resource ||
        resource.kind !== 'command' ||
        resource.commandType !== 'prompt-template' ||
        resource.owner !== 'pi-core' ||
        !resource.source?.fileId
      )
        throw error('PROMPT_NOT_FOUND', 'Select a discovered file-backed Pi prompt template.', 404);
      const file = discovery.getFileForMutation(resource.source.fileId);
      if (
        !file ||
        file.entry.kind !== 'command' ||
        !['global', 'project'].includes(file.entry.scope) ||
        file.entry.packageName ||
        !file.allowContent
      )
        throw error(
          'PROMPT_SOURCE_UNSUPPORTED',
          'This template source is not available for safe preview.',
          403,
        );
      if (parsed.data.expectedHash !== file.entry.versionHash)
        throw error(
          'PROMPT_CHANGED',
          'Template changed since it was loaded. Refresh before previewing.',
          409,
        );
      const bytes = await readFile(file.path);
      if (digest(bytes) !== parsed.data.expectedHash)
        throw error(
          'PROMPT_CHANGED',
          'Template changed since it was loaded. Refresh before previewing.',
          409,
        );
      const raw = bytes.toString('utf8');
      if (
        !Buffer.from(raw, 'utf8').equals(bytes) ||
        SECRET_PATTERN.test(raw) ||
        SENSITIVE_LINE.test(raw)
      )
        throw error(
          'PROMPT_SECRET_REDACTED',
          'Credential-like or binary template content cannot be previewed.',
          422,
        );
      if (SECRET_PATTERN.test(parsed.data.arguments) || SENSITIVE_LINE.test(parsed.data.arguments))
        throw error('PROMPT_SECRET_REDACTED', 'Do not enter credentials in prompt arguments.', 422);
      const environment = discovery.getEnvironment();
      if (environment.piVersion !== VERIFIED_PI_RUNTIME_VERSION || !environment.piBinary)
        throw error(
          'UNSUPPORTED_PI_VERSION',
          'Prompt expansion is verified only for installed Pi 1.4.0.',
          422,
        );
      const packageRoot = await findInstalledPiPackage(
        environment.piBinary,
        VERIFIED_PI_RUNTIME_VERSION,
      );
      const promptModule = await importPromptModule(packageRoot);
      if (
        typeof promptModule.loadPromptTemplates !== 'function' ||
        typeof promptModule.expandPromptTemplate !== 'function'
      )
        throw error(
          'PI_PROMPT_API_UNKNOWN',
          'Installed Pi prompt-template API is not the reviewed version.',
          424,
        );
      const templateName = basename(file.path).replace(/\.md$/i, '');
      const loaded = promptModule.loadPromptTemplates({
        cwd: environment.workingDirectory,
        agentDir: environment.agentDirectory,
        promptPaths: [file.path],
        includeDefaults: false,
      });
      if (
        loaded.diagnostics?.length ||
        !loaded.templates?.some((template) => template.name === templateName)
      )
        throw error(
          'PROMPT_LOAD_FAILED',
          'Pi could not parse this file as a prompt template.',
          422,
        );
      const template = loaded.templates.find((candidate) => candidate.name === templateName);
      const latestBytes = await readFile(file.path);
      if (digest(latestBytes) !== parsed.data.expectedHash)
        throw error(
          'PROMPT_CHANGED',
          'Template changed during preview. Refresh before trying again.',
          409,
        );
      const invocation = `/${templateName}${parsed.data.arguments ? ` ${parsed.data.arguments}` : ''}`;
      const expanded = promptModule.expandPromptTemplate(invocation, [template]);
      if (expanded === invocation)
        throw error(
          'PROMPT_EXPANSION_FAILED',
          'Pi did not recognize the selected prompt template.',
          422,
        );
      if (Buffer.byteLength(expanded, 'utf8') > 128 * 1024)
        throw error('PROMPT_OUTPUT_LIMIT', 'Expanded prompt exceeds the preview size bound.', 413);
      if (SECRET_PATTERN.test(expanded) || SENSITIVE_LINE.test(expanded))
        throw error(
          'PROMPT_SECRET_REDACTED',
          'Expanded output contains credential-like text and was withheld.',
          422,
        );
      return {
        template: templateName,
        piVersion: VERIFIED_PI_RUNTIME_VERSION,
        expansionMode: 'installed-pi-core-static',
        executed: false,
        submitted: false,
        argumentsParsed: true,
        output: expanded,
      };
    },
  };
}
