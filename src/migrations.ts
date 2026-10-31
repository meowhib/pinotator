import type { GetDiscovery, ManagerContext } from './types.js';
import { TESTED_PI_VERSION } from './pi-compat.js';
import { TESTED_PI_SUBAGENTS_VERSION } from './adapters/pi-subagents.js';

function versionTuple(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value || '');
  return match ? match.slice(1, 4).map(Number) : null;
}
function compareVersions(before, current) {
  const a = versionTuple(before);
  const b = versionTuple(current);
  if (!a || !b) return 'unknown';
  for (let index = 0; index < 3; index++) {
    if (b[index] > a[index]) return 'upgrade';
    if (b[index] < a[index]) return 'downgrade';
  }
  return 'same';
}

/** Read-only, evidence-linked migration guidance; it never rewrites settings or resources. */
export function createMigrationService({
  getDiscovery,
  snapshots,
}: {
  getDiscovery: GetDiscovery;
  snapshots: ReturnType<typeof import('./snapshots.js').createSnapshotService>;
}) {
  return {
    async report() {
      const discovery = await getDiscovery();
      const environment = discovery.getEnvironment();
      const currentVersion = environment.piVersion || 'unknown';
      const currentAgents = discovery.getResources('agent');
      const baselines = await snapshots.list();
      const changes = [];
      for (const baseline of baselines.slice(0, 100)) {
        const snapshot = await snapshots.get(baseline.id);
        const direction = compareVersions(snapshot.piVersion, currentVersion);
        if (snapshot.piVersion !== currentVersion)
          changes.push({
            kind: 'pi-version',
            baselineId: snapshot.id,
            baselineLabel: snapshot.label,
            before: snapshot.piVersion || 'unknown',
            after: currentVersion,
            direction,
            severity: direction === 'upgrade' ? 'review' : 'warning',
            message:
              direction === 'upgrade'
                ? `Pi changed from ${snapshot.piVersion || 'unknown'} to ${currentVersion}; compare the saved inventory and re-check supported schemas before editing.`
                : `Pi version differs from this baseline (${snapshot.piVersion || 'unknown'} → ${currentVersion}); semantics are not inferred across versions.`,
          });
        const previousAgents = new Map<string, { adapterVersion?: string }>(
          snapshot.resources
            .filter((resource) => resource.kind === 'agent')
            .map((resource) => [resource.name, resource]),
        );
        for (const agent of currentAgents) {
          const previous = previousAgents.get(agent.name);
          if (!previous || previous.adapterVersion === agent.adapterVersion) continue;
          changes.push({
            kind: 'adapter-version',
            baselineId: snapshot.id,
            baselineLabel: snapshot.label,
            resource: agent.name,
            before: previous.adapterVersion || 'unknown',
            after: agent.adapterVersion || 'unknown',
            severity: 'warning',
            message: `The adapter version for ${agent.name} changed; review the resource diff and adapter compatibility before staging edits.`,
          });
        }
      }
      const compatibility =
        currentVersion === TESTED_PI_VERSION ? 'verified-tested-version' : 'unknown';
      const agentsByAdapter = new Map();
      for (const agent of currentAgents) {
        const version = agent.adapterVersion || 'unknown';
        const entry = agentsByAdapter.get(version) || {
          version,
          count: 0,
          compatibility: agent.adapterCompatibility || 'unknown',
        };
        entry.count += 1;
        agentsByAdapter.set(version, entry);
      }
      return {
        certainty: 'version-evidence-only',
        current: {
          piVersion: currentVersion,
          testedPiVersion: TESTED_PI_VERSION,
          compatibility,
          adapterVersions: [...agentsByAdapter.values()],
          testedPiSubagentsVersion: TESTED_PI_SUBAGENTS_VERSION,
        },
        baselines: baselines.map((baseline) => ({
          id: baseline.id,
          label: baseline.label,
          createdAt: baseline.createdAt,
          piVersion: baseline.piVersion || 'unknown',
          branch: baseline.branch,
        })),
        changes,
        checklist: [
          'Create a private configuration snapshot immediately before changing Pi or an adapter package.',
          'After upgrading, compare the snapshot in the same workspace and review changed, added, removed, and unknown resources.',
          `Runtime-assisted behavior is only verified for Pi ${TESTED_PI_VERSION}; all other versions remain unknown.`,
          `The bundled pi-subagents semantics are tested against ${TESTED_PI_SUBAGENTS_VERSION}; other versions remain inspect-only.`,
          'Migration guidance is evidence and a review checklist, not an automatic schema rewrite or rollback.',
        ],
        limitations: [
          'Pi and community-package release notes are not fetched; version differences do not imply a specific schema migration.',
          'Imported snapshots are read-only and may not describe the current local workspace.',
          'A same-version baseline does not establish that runtime, extension, provider, or session behavior is unchanged.',
        ],
      };
    },
  };
}
