import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { GetDiscovery } from './types.js';
import { findInstalledPiPackage } from './effective-runtime.js';
import { TESTED_PI_VERSION } from './pi-compat.js';

export interface CatalogModel {
  ref: string;
  id: string;
  provider: string;
  name: string;
  source: 'bundled' | 'configured';
}
export interface CatalogProvider {
  id: string;
  name: string;
  apiKeySupported: boolean;
  storedCredential?: 'api_key' | 'oauth';
  setupFields?: { name: string; label: string; placeholder?: string }[];
}
export interface ModelCatalog {
  available: boolean;
  piVersion?: string;
  message: string;
  credentialsMessage?: string;
  providers: CatalogProvider[];
  models: CatalogModel[];
}

export function createModelCatalogService({ getDiscovery }: { getDiscovery: GetDiscovery }) {
  let core: Promise<{ runtime: any; packageRoot: string }>;
  async function loadCore() {
    const environment = (await getDiscovery()).getEnvironment();
    if (environment.piVersion !== TESTED_PI_VERSION || !environment.piBinary)
      throw Object.assign(new Error('The bundled catalog requires verified Pi 1.4.0.'), {
        code: 'UNSUPPORTED_PI_VERSION',
        status: 422,
      });
    if (!core)
      core = (async () => {
        const packageRoot = await findInstalledPiPackage(environment.piBinary, TESTED_PI_VERSION);
        const sdk = await import(pathToFileURL(join(packageRoot, 'dist', 'index.js')).href);
        // No auth store, user model configuration, availability checks, extension
        // loading, credential resolvers, or network refresh during enumeration.
        const runtime = await sdk.ModelRuntime.create({
          modelsPath: null,
          credentials: {
            read: async () => undefined,
            list: async () => [],
            modify: async () => {
              throw new Error('Read-only catalog');
            },
            delete: async () => {
              throw new Error('Read-only catalog');
            },
          },
          refreshOnCreate: false,
          allowModelNetwork: false,
        });
        return { runtime, packageRoot };
      })().catch((error) => {
        core = undefined;
        throw error;
      });
    return core;
  }
  return {
    loadCore,
    async get(): Promise<ModelCatalog> {
      const discovery = await getDiscovery();
      const environment = discovery.getEnvironment();
      const models = new Map<string, CatalogModel>();
      const providers = new Map<string, CatalogProvider>();
      let available = false;
      try {
        const { runtime } = await loadCore();
        for (const provider of runtime.getProviders()) {
          providers.set(provider.id, {
            id: provider.id,
            name: provider.name || provider.id,
            apiKeySupported: typeof provider.auth?.apiKey?.login === 'function',
          });
        }
        for (const model of runtime.getModels().slice(0, 4000)) {
          const ref = `${model.provider}/${model.id}`;
          models.set(ref, {
            ref,
            id: model.id,
            provider: model.provider,
            name: String(model.name || model.id).slice(0, 200),
            source: 'bundled',
          });
        }
        available = true;
      } catch {
        /* Unknown Pi versions still expose safely inventoried declarations. */
      }
      for (const model of discovery.getResources('model')) {
        if (typeof model.provider !== 'string' || typeof model.modelId !== 'string') continue;
        const ref = `${model.provider}/${model.modelId}`;
        models.set(ref, {
          ref,
          id: model.modelId,
          provider: model.provider,
          name: model.description || model.modelId,
          source: 'configured',
        });
        if (!providers.has(model.provider))
          providers.set(model.provider, {
            id: model.provider,
            name: model.provider,
            apiKeySupported: false,
          });
      }
      return {
        available,
        piVersion: environment.piVersion,
        message: available
          ? 'Bundled Pi chat models and local declarations. No network, credential resolution, or extensions were used; availability is not verified.'
          : 'The bundled catalog requires verified Pi 1.4.0. Local declarations and manual model references remain available.',
        providers: [...providers.values()].sort((a, b) => a.name.localeCompare(b.name)),
        models: [...models.values()].sort(
          (a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name),
        ),
      };
    },
  };
}
