import type { GetDiscovery, ManagerContext } from './types.js';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const VERIFIED_PI_RUNTIME_VERSION = '1.4.0';
const PI_PACKAGE_NAME = '@earendil-works/pi-coding-agent';
const MAX_RUNTIME_MODELS = 500;
const MAX_RUNTIME_RESOURCES = 2000;

const hash = (value) => createHash('sha256').update(value).digest('hex');

export async function findInstalledPiPackage(binary, expectedVersion) {
  let directory = dirname(await realpath(binary));
  for (let depth = 0; depth < 7; depth++) {
    const manifestPath = join(directory, 'package.json');
    try {
      const info = await lstat(manifestPath);
      if (info.isFile() && !info.isSymbolicLink()) {
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
        if (manifest.name === PI_PACKAGE_NAME) {
          if (manifest.version !== expectedVersion)
            throw Object.assign(new Error('Installed Pi package and CLI versions differ.'), {
              code: 'PI_PACKAGE_VERSION_MISMATCH',
              status: 409,
            });
          return directory;
        }
      }
    } catch (error) {
      if (error.code === 'PI_PACKAGE_VERSION_MISMATCH') throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw Object.assign(new Error('The installed Pi SDK package could not be matched safely.'), {
    code: 'PI_SDK_UNAVAILABLE',
    status: 424,
  });
}

function fileIdByPath(files) {
  return new Map(files.map((file) => [resolve(file.displayPath), file.id]));
}
function describeSource(sourcePath, ids) {
  if (!sourcePath || typeof sourcePath !== 'string') return { sourceId: null, sourcePath: null };
  const path = resolve(sourcePath);
  return { sourceId: ids.get(path) || null, sourcePath: path };
}
function safeEndpointOrigin(baseUrl) {
  if (typeof baseUrl !== 'string') return null;
  try {
    const parsed = new URL(baseUrl);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password)
      return null;
    return parsed.origin;
  } catch {
    return null;
  }
}
function modelDescriptor(model, runtime) {
  const auth = runtime.getProviderAuthStatus(model.provider);
  return {
    ref: `${model.provider}/${model.id}`,
    endpointOrigin: safeEndpointOrigin(model.baseUrl),
    provider: model.provider,
    id: model.id,
    name: typeof model.name === 'string' ? model.name.slice(0, 200) : model.id,
    reasoning: typeof model.reasoning === 'boolean' ? model.reasoning : 'unknown',
    input: Array.isArray(model.input)
      ? model.input.filter((value) => ['text', 'image'].includes(value))
      : [],
    contextWindow: Number.isFinite(model.contextWindow) ? model.contextWindow : undefined,
    maxTokens: Number.isFinite(model.maxTokens) ? model.maxTokens : undefined,
    cost:
      model.cost && typeof model.cost === 'object'
        ? {
            input: Number.isFinite(model.cost.input) ? model.cost.input : undefined,
            output: Number.isFinite(model.cost.output) ? model.cost.output : undefined,
            cacheRead: Number.isFinite(model.cost.cacheRead) ? model.cost.cacheRead : undefined,
            cacheWrite: Number.isFinite(model.cost.cacheWrite) ? model.cost.cacheWrite : undefined,
          }
        : undefined,
    credentials: auth
      ? { configured: Boolean(auth.configured), source: auth.source || 'unknown' }
      : { configured: false, source: 'unknown' },
    source: 'installed-pi-runtime',
  };
}

export function createEffectiveRuntimeService(options: {
  getDiscovery: GetDiscovery;
  loadSdk?: (packageRoot: string) => Promise<any>;
  findPackageRoot?: (binary: string, expectedVersion: string) => Promise<string>;
}) {
  const { getDiscovery, loadSdk, findPackageRoot = findInstalledPiPackage } = options;
  let lastModels = [];
  const importSdk =
    loadSdk ||
    (async (packageRoot) => import(pathToFileURL(join(packageRoot, 'dist', 'index.js')).href));

  return {
    async inspect(payload) {
      if (payload?.confirmed !== true)
        throw Object.assign(
          new Error('Explicit confirmation is required for Pi runtime inspection.'),
          {
            code: 'CONFIRMATION_REQUIRED',
            status: 400,
          },
        );

      const discovery = await getDiscovery();
      const environment = discovery.getEnvironment();
      if (environment.piVersion !== VERIFIED_PI_RUNTIME_VERSION || !environment.piBinary)
        throw Object.assign(
          new Error('Effective inspection is supported only for verified Pi 1.4.0.'),
          {
            code: 'UNSUPPORTED_PI_VERSION',
            status: 422,
          },
        );

      const packageRoot = await findPackageRoot(environment.piBinary, VERIFIED_PI_RUNTIME_VERSION);
      const sdk = await importSdk(packageRoot);
      for (const exported of ['SettingsManager', 'DefaultResourceLoader', 'ModelRuntime'])
        if (typeof sdk[exported] !== 'function')
          throw Object.assign(
            new Error('The installed Pi package does not expose the reviewed inspection API.'),
            {
              code: 'PI_SDK_API_UNKNOWN',
              status: 424,
            },
          );

      const projectTrusted = environment.mode !== 'global' && environment.trust === 'trusted';
      const settingsManager = sdk.SettingsManager.create(
        environment.workingDirectory,
        environment.agentDirectory,
        {
          projectTrusted,
        },
      );
      const resourceLoader = new sdk.DefaultResourceLoader({
        cwd: environment.workingDirectory,
        agentDir: environment.agentDirectory,
        settingsManager,
        noExtensions: true,
        noThemes: true,
        disabledBuiltinExtensions: ['mcp'],
        additionalExtensionPaths: [],
        extensionFactories: [],
      });
      await resourceLoader.reload();

      const modelRuntime = await sdk.ModelRuntime.create({
        authPath: join(environment.agentDirectory, 'auth.json'),
        modelsPath: join(environment.agentDirectory, 'models.json'),
        allowModelNetwork: false,
        refreshOnCreate: false,
        signal: AbortSignal.timeout(10_000),
      });
      const settings = settingsManager.getSettings();
      const staticFiles = discovery.getFiles();
      const ids = fileIdByPath(staticFiles);
      const settingsView = {
        defaultProvider: settings.defaultProvider,
        defaultModel: settings.defaultModel,
        defaultThinkingLevel: settings.defaultThinkingLevel,
        enabledModels: Array.isArray(settings.enabledModels)
          ? [...settings.enabledModels]
          : undefined,
        enableSkillCommands: settingsManager.getEnableSkillCommands(),
      };
      const models = modelRuntime
        .getAllModels()
        .slice(0, MAX_RUNTIME_MODELS)
        .map((model) => modelDescriptor(model, modelRuntime));
      lastModels = models;
      const skills = resourceLoader
        .getSkills()
        .skills.slice(0, MAX_RUNTIME_RESOURCES)
        .map((skill) => ({
          kind: 'skill',
          name: skill.name,
          description: skill.description,
          disableModelInvocation: skill.disableModelInvocation,
          ...describeSource(skill.filePath, ids),
          baseDirectory: resolve(skill.baseDir),
        }));
      const prompts = resourceLoader
        .getPrompts()
        .prompts.slice(0, MAX_RUNTIME_RESOURCES)
        .map((prompt) => ({
          kind: 'command',
          name: `/${prompt.name}`,
          description: prompt.description,
          argumentHint: prompt.argumentHint,
          ...describeSource(prompt.filePath, ids),
          contentHash: hash(prompt.content),
        }));
      const contextFiles = resourceLoader
        .getAgentsFiles()
        .agentsFiles.slice(0, MAX_RUNTIME_RESOURCES)
        .map((file) => ({
          kind: 'instruction',
          ...describeSource(file.path, ids),
          contentHash: hash(file.content),
          characters: file.content.length,
        }));
      const systemSource = resourceLoader.getSystemPromptSource()?.path;
      const systemPrompt = resourceLoader.getSystemPrompt();
      const appendSources = resourceLoader
        .getAppendSystemPromptSources()
        .map((source) => source.path);
      const appendTexts = resourceLoader.getAppendSystemPrompt();
      const model =
        settings.defaultProvider && settings.defaultModel
          ? modelRuntime.getModel(settings.defaultProvider, settings.defaultModel)
          : undefined;
      const diagnostics = [
        ...resourceLoader.getSkills().diagnostics.map(({ message, path }) => ({
          kind: 'skill',
          message: String(message).slice(0, 500),
          ...describeSource(path, ids),
        })),
        ...resourceLoader.getPrompts().diagnostics.map(({ message, path }) => ({
          kind: 'command',
          message: String(message).slice(0, 500),
          ...describeSource(path, ids),
        })),
      ].slice(0, 500);

      return {
        piVersion: environment.piVersion,
        verifiedRuntime: true,
        inspectionMode: 'installed-pi-core-no-extensions',
        sideEffects: {
          projectExtensionsExecuted: false,
          mcpConnected: false,
          modelNetworkAccess: false,
        },
        trust: projectTrusted
          ? 'trusted'
          : environment.mode === 'global'
            ? 'not_applicable'
            : environment.trust,
        settings: settingsView,
        selectedModel: model ? `${model.provider}/${model.id}` : null,
        modelSource: model
          ? 'installed-pi-model-runtime'
          : settings.defaultModel
            ? 'unresolved'
            : 'none',
        models,
        resources: { skills, prompts, contextFiles },
        systemPrompt: {
          ...describeSource(systemSource, ids),
          contentHash: typeof systemPrompt === 'string' ? hash(systemPrompt) : null,
          characters: typeof systemPrompt === 'string' ? systemPrompt.length : 0,
        },
        appendedSystemPrompts: appendTexts.map((content, index) => ({
          ...describeSource(appendSources[index], ids),
          contentHash: hash(content),
          characters: content.length,
        })),
        diagnostics,
        limits: { models: MAX_RUNTIME_MODELS, resourcesPerKind: MAX_RUNTIME_RESOURCES },
      };
    },
    async testGeneration(payload) {
      if (payload?.confirmed !== true)
        throw Object.assign(new Error('Explicit confirmation is required for a model test.'), {
          code: 'CONFIRMATION_REQUIRED',
          status: 400,
        });
      if (
        typeof payload.modelRef !== 'string' ||
        payload.modelRef.length > 300 ||
        /[\u0000-\u001f]/.test(payload.modelRef)
      )
        throw Object.assign(new Error('Choose one recognized provider/model identity.'), {
          code: 'INVALID_MODEL',
          status: 400,
        });
      const separator = payload.modelRef.indexOf('/');
      const provider = payload.modelRef.slice(0, separator);
      const modelId = payload.modelRef.slice(separator + 1);
      if (
        separator < 1 ||
        !/^[A-Za-z0-9_-]{1,64}$/.test(provider) ||
        !modelId ||
        modelId.length > 240 ||
        /[\s\u0000-\u001f]/.test(modelId)
      )
        throw Object.assign(new Error('Choose one recognized provider/model identity.'), {
          code: 'INVALID_MODEL',
          status: 400,
        });
      const discovery = await getDiscovery();
      const environment = discovery.getEnvironment();
      if (environment.piVersion !== VERIFIED_PI_RUNTIME_VERSION || !environment.piBinary)
        throw Object.assign(new Error('Model testing is supported only for verified Pi 1.4.0.'), {
          code: 'UNSUPPORTED_PI_VERSION',
          status: 422,
        });
      try {
        const packageRoot = await findPackageRoot(
          environment.piBinary,
          VERIFIED_PI_RUNTIME_VERSION,
        );
        const sdk = await importSdk(packageRoot);
        if (typeof sdk.ModelRuntime !== 'function')
          throw Object.assign(new Error('Reviewed model runtime API is unavailable.'), {
            code: 'PI_SDK_API_UNKNOWN',
            status: 424,
          });
        const modelRuntime = await sdk.ModelRuntime.create({
          authPath: join(environment.agentDirectory, 'auth.json'),
          modelsPath: join(environment.agentDirectory, 'models.json'),
          allowModelNetwork: false,
          refreshOnCreate: false,
          signal: AbortSignal.timeout(10_000),
        });
        const model = modelRuntime.getModel(provider, modelId);
        if (!model)
          throw Object.assign(
            new Error('The selected provider/model is not in Pi’s offline catalog.'),
            { code: 'MODEL_NOT_FOUND', status: 404 },
          );
        const auth = modelRuntime.getProviderAuthStatus(provider);
        if (!auth?.configured)
          throw Object.assign(
            new Error('Pi reports no configured authorization for this provider.'),
            { code: 'PROVIDER_NOT_CONFIGURED', status: 422 },
          );
        if (auth.source === 'models_json_command')
          throw Object.assign(
            new Error('Model tests will not execute a models.json credential command resolver.'),
            { code: 'CREDENTIAL_COMMAND_UNSUPPORTED', status: 422 },
          );
        const outputLimit =
          Number.isInteger(model.maxTokens) && model.maxTokens > 0
            ? Math.min(48, model.maxTokens)
            : 48;
        const result = await modelRuntime.completeSimple(
          model,
          {
            messages: [
              {
                role: 'user',
                content: 'Reply with exactly: Pinotator connection test succeeded',
                timestamp: Date.now(),
              },
            ],
          },
          { maxTokens: outputLimit, deferred: false, signal: AbortSignal.timeout(20_000) },
        );
        const usage = result.usage;
        return {
          modelRef: `${provider}/${modelId}`,
          status:
            result.stopReason === 'error' || result.errorMessage
              ? 'provider-error'
              : result.stopReason === 'deferred'
                ? 'deferred'
                : 'completed',
          stopReason: result.stopReason,
          usage: usage
            ? {
                inputTokens: Number.isFinite(usage.input) ? usage.input : null,
                outputTokens: Number.isFinite(usage.output) ? usage.output : null,
                totalTokens: Number.isFinite(usage.totalTokens) ? usage.totalTokens : null,
                reportedCostUsd: Number.isFinite(usage.cost?.total) ? usage.cost.total : null,
              }
            : null,
          caveat: `A real provider request was sent with a fixed minimal prompt and an output cap of ${outputLimit} tokens. Provider billing, tokenization, and response behavior may differ from Pi’s reported usage.`,
        };
      } catch (error) {
        if (
          [
            'PI_SDK_API_UNKNOWN',
            'PI_PACKAGE_VERSION_MISMATCH',
            'PI_SDK_UNAVAILABLE',
            'MODEL_NOT_FOUND',
            'PROVIDER_NOT_CONFIGURED',
            'CREDENTIAL_COMMAND_UNSUPPORTED',
          ].includes(error.code)
        )
          throw error;
        throw Object.assign(
          new Error('The model test failed or timed out; provider error details are withheld.'),
          { code: 'MODEL_TEST_FAILED', status: 502 },
        );
      }
    },
    getLastModels() {
      return lastModels.map((model) => ({
        ...model,
        input: [...model.input],
        cost: model.cost ? { ...model.cost } : undefined,
        credentials: { ...model.credentials },
      }));
    },
  };
}
