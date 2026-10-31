import type { ConfigRecord } from '../types.js';

export interface StaticAdapter<Parsed, Resolved> {
  id: string;
  contractVersion: number;
  testedVersions: readonly string[];
  parse(text: string): Parsed;
  resolve(parsed: Parsed, options?: ConfigRecord): Resolved;
  describe?(): { status: string; message: string };
}

export const ADAPTER_CONTRACT_VERSION = 1;
const ID = /^[a-z][a-z0-9-]{0,63}$/;

// This registry only accepts adapter modules explicitly bundled by a developer.
// It never searches package directories or imports project/extension code at runtime.
export function createAdapterRegistry<Parsed, Resolved>(
  adapters: readonly StaticAdapter<Parsed, Resolved>[] = [],
) {
  const registered = new Map<string, StaticAdapter<Parsed, Resolved>>();
  function register(adapter: StaticAdapter<Parsed, Resolved>) {
    if (
      !adapter ||
      typeof adapter !== 'object' ||
      adapter.contractVersion !== ADAPTER_CONTRACT_VERSION ||
      !ID.test(adapter.id || '') ||
      typeof adapter.parse !== 'function' ||
      typeof adapter.resolve !== 'function' ||
      !Array.isArray(adapter.testedVersions) ||
      adapter.testedVersions.some(
        (version) => typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version),
      )
    )
      throw new TypeError('Adapter does not satisfy the static adapter contract.');
    if (registered.has(adapter.id))
      throw new TypeError(`Adapter is already registered: ${adapter.id}`);
    const copy = Object.freeze({
      id: adapter.id,
      contractVersion: adapter.contractVersion,
      testedVersions: Object.freeze([...adapter.testedVersions]),
      parse: adapter.parse,
      resolve: adapter.resolve,
      describe:
        typeof adapter.describe === 'function'
          ? adapter.describe
          : () => ({ status: 'unknown', message: 'Adapter provides no static description.' }),
    });
    registered.set(copy.id, copy);
    return copy;
  }
  for (const adapter of adapters) register(adapter);
  return Object.freeze({
    register,
    list: () =>
      [...registered.values()].map((adapter) => ({
        id: adapter.id,
        contractVersion: adapter.contractVersion,
        testedVersions: [...adapter.testedVersions],
      })),
    resolve: (id: string, version: string | null) => {
      const adapter = registered.get(id);
      if (!adapter)
        return {
          compatibility: 'unknown',
          adapter: null,
          reason: 'No bundled adapter is registered.',
        };
      return adapter.testedVersions.includes(version)
        ? { compatibility: 'supported', adapter, reason: 'Version is explicitly tested.' }
        : {
            compatibility: 'unknown',
            adapter,
            reason: `Adapter version is not tested: ${version || 'unknown'}.`,
          };
    },
  });
}
