import type { ModelCatalog } from '../../src/model-catalog.js';

let pending: Promise<ModelCatalog>;
export function invalidateModelCatalog() {
  pending = undefined;
}
export function loadModelCatalog(refresh = false) {
  if (refresh) pending = undefined;
  if (!pending)
    pending = fetch('/api/models/catalog', { credentials: 'same-origin', cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error('Could not load the local Pi model catalog.');
        return response.json() as Promise<ModelCatalog>;
      })
      .catch((error) => {
        pending = undefined;
        throw error;
      });
  return pending;
}
