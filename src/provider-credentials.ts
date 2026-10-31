import { lstat } from 'node:fs/promises';
import { dirname, join, parse, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import type { GetDiscovery } from './types.js';
import type { createModelCatalogService } from './model-catalog.js';

const requestSchema = z
  .object({
    provider: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/),
    apiKey: z.string().min(8).max(8192),
    confirmed: z.literal(true),
    replaceExisting: z.boolean().default(false),
    configuration: z.record(z.string(), z.string().max(500)).default({}),
  })
  .strict();

const setupFields: Record<string, { name: string; label: string; placeholder?: string }[]> = {
  azure: [
    {
      name: 'AZURE_OPENAI_BASE_URL',
      label: 'Azure base URL (if not already configured)',
      placeholder: 'https://your-resource.openai.azure.com',
    },
    { name: 'AZURE_OPENAI_RESOURCE_NAME', label: 'Azure resource name (alternative to base URL)' },
  ],
  'cloudflare-workers-ai': [{ name: 'CLOUDFLARE_ACCOUNT_ID', label: 'Cloudflare account ID' }],
  'cloudflare-ai-gateway': [
    { name: 'CLOUDFLARE_ACCOUNT_ID', label: 'Cloudflare account ID' },
    { name: 'CLOUDFLARE_GATEWAY_ID', label: 'Cloudflare gateway ID' },
  ],
  'amazon-bedrock': [
    {
      name: 'AWS_REGION',
      label: 'AWS region (optional if already configured)',
      placeholder: 'us-east-1',
    },
  ],
};
const failure = (code: string, message: string, status = 400) =>
  Object.assign(new Error(message), { code, status });

// auth.json is a privileged fixed destination, not an inventory-editable file.
// Reject links (including ancestors/hardlinks), special files, permissive modes,
// and large stores before asking Pi's version-reviewed, locking writer to act.
async function checkAuthPath(agentDirectory: string) {
  const path = join(resolve(agentDirectory), 'auth.json');
  let current = path;
  let exists = false;
  for (;;) {
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || (current !== path && !info.isDirectory()))
        throw failure('UNSAFE_AUTH_PATH', 'Credential storage contains an unsafe path.', 422);
      if (current === path) {
        exists = true;
        if (
          !info.isFile() ||
          info.nlink !== 1 ||
          info.size > 1024 * 1024 ||
          (info.mode & 0o077) !== 0 ||
          (process.getuid && info.uid !== process.getuid())
        )
          throw failure(
            'UNSAFE_AUTH_STORE',
            'Pi auth.json must be a private, owner-owned regular file (0600) with no links and at most 1 MiB.',
            422,
          );
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const parent = dirname(current);
    if (parent === current || current === parse(current).root) break;
    current = parent;
  }
  return { path, exists };
}

export function createProviderCredentialsService({
  getDiscovery,
  catalogService,
}: {
  getDiscovery: GetDiscovery;
  catalogService: ReturnType<typeof createModelCatalogService>;
}) {
  async function authModule() {
    const { packageRoot } = await catalogService.loadCore();
    return import(pathToFileURL(join(packageRoot, 'dist', 'core', 'auth-storage.js')).href);
  }
  return {
    async catalog() {
      const catalog = await catalogService.get();
      const types = new Map<string, 'api_key' | 'oauth'>();
      let credentialsMessage = '';
      if (catalog.available)
        try {
          const environment = (await getDiscovery()).getEnvironment();
          const { path, exists } = await checkAuthPath(environment.agentDirectory);
          if (exists) {
            const { ReadOnlyAuthStorage } = await authModule();
            for (const item of await new ReadOnlyAuthStorage(path).list({
              signal: AbortSignal.timeout(3000),
            }))
              if (item.type === 'api_key' || item.type === 'oauth')
                types.set(item.providerId, item.type);
          }
        } catch {
          credentialsMessage =
            'Stored credential metadata could not be inspected safely. Existing credentials will not be overwritten without confirmation.';
        }
      return {
        ...catalog,
        credentialsMessage,
        providers: catalog.providers.map((provider) => ({
          ...provider,
          storedCredential: types.get(provider.id),
          setupFields: setupFields[provider.id] || [],
        })),
      };
    },
    async save(payload: unknown) {
      // Never propagate schema/storage/SDK errors: secret-bearing request values
      // and existing credential contents must not appear in HTTP errors or logs.
      const parsed = requestSchema.safeParse(payload);
      if (!parsed.success)
        throw failure(
          'INVALID_CREDENTIAL_REQUEST',
          'Choose a provider, enter an API key, and explicitly confirm the local save.',
        );
      const request = parsed.data;
      if (/\s|[\x00-\x1f\x7f]/.test(request.apiKey) || /^[!$]/.test(request.apiKey))
        throw failure(
          'INVALID_API_KEY',
          'Enter a literal API key without whitespace, environment interpolation, or command resolvers.',
        );
      const discovery = await getDiscovery();
      const environment = discovery.getEnvironment();
      if (environment.readOnly) throw failure('READ_ONLY', 'This workspace is read-only.', 403);
      const { runtime } = await catalogService.loadCore();
      const provider = runtime.getProvider(request.provider);
      if (typeof provider?.auth?.apiKey?.login !== 'function')
        throw failure(
          'API_KEY_UNSUPPORTED',
          'This built-in provider does not support API-key setup.',
          422,
        );
      const allowed = new Set((setupFields[request.provider] || []).map((field) => field.name));
      const configuration: Record<string, string> = {};
      for (const [name, value] of Object.entries(request.configuration)) {
        if (!allowed.has(name))
          throw failure(
            'INVALID_PROVIDER_CONFIGURATION',
            'Unsupported provider configuration field.',
          );
        if (!value.trim()) continue;
        if (name.endsWith('_BASE_URL')) {
          let url: URL;
          try {
            url = new URL(value);
          } catch {
            throw failure('INVALID_PROVIDER_CONFIGURATION', 'Use a valid HTTPS provider base URL.');
          }
          if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
            throw failure(
              'INVALID_PROVIDER_CONFIGURATION',
              'Use HTTPS without credentials, query strings, or fragments.',
            );
        } else if (!/^[a-zA-Z0-9_-]{1,128}$/.test(value))
          throw failure(
            'INVALID_PROVIDER_CONFIGURATION',
            'Use a valid account, gateway, resource, or region identifier.',
          );
        configuration[name] = value;
      }
      const { path } = await checkAuthPath(environment.agentDirectory);
      const { AuthStorage } = await authModule();
      try {
        const storage = AuthStorage.create(path);
        await storage.modify(
          request.provider,
          async (current) => {
            await checkAuthPath(environment.agentDirectory);
            if (current && !request.replaceExisting)
              throw failure(
                'CREDENTIAL_EXISTS',
                'A credential already exists. Confirm replacement before saving.',
                409,
              );
            const env = {
              ...(current?.type === 'api_key' ? current.env || {} : {}),
              ...configuration,
            };
            return {
              type: 'api_key',
              key: request.apiKey,
              ...(Object.keys(env).length ? { env } : {}),
            };
          },
          { signal: AbortSignal.timeout(5000) },
        );
        await checkAuthPath(environment.agentDirectory);
      } catch (error) {
        if (['CREDENTIAL_EXISTS', 'UNSAFE_AUTH_PATH', 'UNSAFE_AUTH_STORE'].includes(error.code))
          throw error;
        throw failure(
          'CREDENTIAL_SAVE_FAILED',
          'The API key could not be saved safely. Check Pi credential storage permissions and retry.',
          422,
        );
      }
      return { saved: true, provider: request.provider, storage: 'pi-auth-json', verified: false };
    },
  };
}
