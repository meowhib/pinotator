import { useSyncExternalStore } from 'react';
import {
  Activity,
  Blocks,
  BookOpen,
  Bot,
  Boxes,
  CircleGauge,
  Command,
  FileCode2,
  GitBranch,
  GitCompareArrows,
  History,
  Keyboard,
  Layers3,
  Network,
  Radio,
  Settings2,
  ShieldCheck,
  Sparkles,
  WandSparkles,
  Workflow,
  type LucideIcon,
} from 'lucide-react';

export const navigationGroups: { label: string; items: [string, string, LucideIcon][] }[] = [
  {
    label: 'Workspace',
    items: [
      ['/', 'Overview', CircleGauge],
      ['/instructions', 'Instructions', BookOpen],
      ['/agents', 'Agents', Bot],
      ['/skills', 'Skills', Sparkles],
      ['/commands', 'Commands', Command],
    ],
  },
  {
    label: 'Configuration',
    items: [
      ['/models', 'Models', Layers3],
      ['/providers', 'Providers', Boxes],
      ['/extensions', 'Extensions & packages', Blocks],
      ['/mcp', 'MCP servers', Network],
      ['/settings', 'Settings', Settings2],
      ['/keybindings', 'Keybindings', Keyboard],
    ],
  },
  {
    label: 'Tools & insights',
    items: [
      ['/effective', 'Effective Pi state', Activity],
      ['/analysis', 'Dependencies & cost', Workflow],
      ['/companion', 'Pi sessions', Radio],
      ['/snapshots', 'Snapshots & compare', GitCompareArrows],
      ['/migration', 'Version migration', History],
      ['/templates', 'Templates', WandSparkles],
      ['/sources', 'Files & sources', FileCode2],
      ['/changes', 'Changes', GitBranch],
      ['/diagnostics', 'Diagnostics', ShieldCheck],
    ],
  },
];

export const sections = navigationGroups.flatMap((group) =>
  group.items.map(([path, label]) => [path, label]),
);

let stagedCount = 0;
const countListeners = new Set<() => void>();
const subscribeCount = (listener: () => void) => {
  countListeners.add(listener);
  return () => {
    countListeners.delete(listener);
  };
};
export function updateStagedCount(count: number) {
  if (stagedCount === count) return;
  stagedCount = count;
  countListeners.forEach((listener) => listener());
}

export function Navigation({ onNavigate }: { onNavigate?: () => void }) {
  const root = '/' + location.pathname.split('/')[1];
  const count = useSyncExternalStore(subscribeCount, () => stagedCount);
  return (
    <nav aria-label="Configuration sections" className="navigation">
      {navigationGroups.map((group) => (
        <div className="nav-group" key={group.label}>
          <p className="nav-label">{group.label}</p>
          {group.items.map(([path, label, Icon]) => (
            <a
              href={path}
              key={path}
              className={`nav-link${root === path ? ' active' : ''}`}
              aria-current={root === path ? 'page' : undefined}
              onClick={onNavigate}
            >
              <Icon size={16} aria-hidden="true" />
              <span>{label}</span>
              {path === '/changes' && (
                <span
                  className="nav-count"
                  data-changes-count
                  hidden={!count}
                  aria-label={`${count} staged changes`}
                >
                  {count}
                </span>
              )}
            </a>
          ))}
        </div>
      ))}
    </nav>
  );
}

export function Brand() {
  return (
    <a className="brand" href="/" aria-label="Pinotator home">
      <span className="brand-mark">
        <Layers3 size={19} strokeWidth={1.8} aria-hidden="true" />
      </span>
      <span>
        <strong>Pinotator</strong>
        <small>Pi configuration studio</small>
      </span>
    </a>
  );
}
