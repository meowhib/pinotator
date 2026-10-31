import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { AppShell } from './components/app-shell.js';
import { sections, updateStagedCount } from './navigation.js';
import { CommandPalette } from './components/command-palette.js';
import { showToast } from './components/toaster.js';
import { installFormControls } from './lib/form-controls.js';
import { loadModelCatalog, invalidateModelCatalog } from './lib/model-catalog.js';
import type {
  AgentChanges,
  AnalysisGraph,
  BrowserState,
  McpChange,
  ProviderModel,
} from './types.js';
import type { ConfigRecord } from '../src/types.js';

const app = document.getElementById('app');
if (!app) throw new Error('Missing application root.');
// Commit the shell before attaching the existing imperative page controllers.
// React owns only the shell; controllers own the contents of its empty containers.
flushSync(() => createRoot(app).render(<AppShell />));

const kindForPath = {
  '/agents': 'agent',
  '/skills': 'skill',
  '/commands': 'command',
  '/models': 'model',
  '/providers': 'provider',
  '/mcp': 'mcp',
  '/settings': 'setting',
};
const listFilters = new Map<string, { query: string; scope: string; origin?: string }>();
const state: BrowserState = {
  env: null,
  overview: null,
  resources: [],
  files: [],
  diagnostics: [],
  instructions: null,
  changes: [],
  recovery: [],
  snapshots: [],
  effectiveRuntime: null,
};
let externalRefreshPending = false;
let providerCatalog: Awaited<ReturnType<typeof loadModelCatalog>>;
let providerCatalogPending = false;
let providerCatalogFailure = false;
const main = document.getElementById('main');
installFormControls(main);
const make = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: unknown,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (tag === 'pre') {
    node.tabIndex = 0;
    node.setAttribute('role', 'group');
    node.setAttribute(
      'aria-label',
      className === 'diff-preview' ? 'Proposed diff' : 'Code preview',
    );
  }
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
};
const link = (href, label, className = '') => {
  const a = make('a', className, label);
  a.href = href;
  return a;
};

const paletteActions = [
  ...sections.map(([path, label]) => ({ label: `Go to ${label}`, path })),
  { label: 'Create agent', path: '/agents?create=agent' },
  { label: 'Create skill', path: '/skills?create=skill' },
  { label: 'Create prompt command', path: '/commands?create=command' },
  { label: 'Create instruction file', path: '/changes?create=instruction' },
  { label: 'Create system prompt', path: '/changes?create=system-prompt' },
  { label: 'Create appended system prompt', path: '/changes?create=append-system' },
  { label: 'Edit agents', path: '/agents' },
  { label: 'Edit skills', path: '/skills' },
  { label: 'Edit prompt commands', path: '/commands' },
  { label: 'Review staged changes', path: '/changes' },
  { label: 'Refresh local inventory', refresh: true },
  { label: 'Keyboard shortcut help', help: true },
];
let shortcutsEnabled = true;
try {
  shortcutsEnabled = localStorage.getItem('pinotator.keyboard-shortcuts') !== 'false';
} catch {
  /* Keyboard shortcuts remain enabled for this page lifetime. */
}
let paletteRoot: ReturnType<typeof createRoot>;
let paletteKey = 0;
function openPalette(mode = 'commands') {
  if (!paletteRoot) {
    const container = make('div');
    document.body.append(container);
    paletteRoot = createRoot(container);
  }
  const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  flushSync(() =>
    paletteRoot.render(
      <CommandPalette
        key={++paletteKey}
        initialMode={mode}
        actions={paletteActions}
        enabled={shortcutsEnabled}
        returnFocus={returnFocus}
        onEnabledChange={(enabled) => {
          shortcutsEnabled = enabled;
          try {
            localStorage.setItem('pinotator.keyboard-shortcuts', String(enabled));
          } catch {
            /* Optional preference. */
          }
        }}
        onAction={(action) => {
          if (action.path) navigate(action.path);
          else if (action.refresh) document.getElementById('refresh').click();
        }}
      />,
    ),
  );
}
document.getElementById('palette-open').addEventListener('click', () => openPalette());
let pendingGo = false;
let pendingGoTimer;
document.addEventListener('keydown', (event) => {
  const target = event.target;
  const typing =
    target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
  if (shortcutsEnabled && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    openPalette();
    return;
  }
  if (shortcutsEnabled && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
    const active = document.activeElement;
    const editor = active instanceof Element ? active.closest('.guided-editor') : null;
    const stageForm =
      active instanceof Element ? active.closest('form[data-stage-shortcut="true"]') : null;
    if (stageForm instanceof HTMLFormElement) {
      event.preventDefault();
      stageForm.requestSubmit();
      return;
    }
    if (editor) {
      event.preventDefault();
      notify('This editor is preview-only; use its Preview action. No file was written.');
      return;
    }
  }
  if (
    shortcutsEnabled &&
    (event.metaKey || event.ctrlKey) &&
    event.shiftKey &&
    event.key === 'Enter'
  ) {
    event.preventDefault();
    navigate('/changes');
    return;
  }
  if (!shortcutsEnabled || typing || event.metaKey || event.ctrlKey || event.altKey) return;
  const focusedResource =
    target instanceof Element
      ? target.closest<HTMLAnchorElement>('table.resource-table a.resource-name')
      : null;
  if (focusedResource && (event.key.toLowerCase() === 'j' || event.key.toLowerCase() === 'k')) {
    const links = [
      ...main.querySelectorAll<HTMLAnchorElement>('table.resource-table a.resource-name'),
    ];
    const index = links.indexOf(focusedResource);
    const next = links[index + (event.key.toLowerCase() === 'j' ? 1 : -1)];
    if (next) {
      event.preventDefault();
      next.focus();
      next.click();
    }
    return;
  }
  if (event.key === '/') {
    const search = main.querySelector('input[type="search"]');
    if (search instanceof HTMLInputElement) {
      event.preventDefault();
      search.focus();
    }
    return;
  }
  if (event.key === '?') {
    event.preventDefault();
    openPalette('shortcuts');
    return;
  }
  if (pendingGo) {
    pendingGo = false;
    clearTimeout(pendingGoTimer);
    const destination = { d: '/', a: '/agents', s: '/skills', m: '/models' }[
      event.key.toLowerCase()
    ];
    if (destination) navigate(destination);
    return;
  }
  if (event.key.toLowerCase() === 'g') {
    pendingGo = true;
    clearTimeout(pendingGoTimer);
    pendingGoTimer = setTimeout(() => {
      pendingGo = false;
    }, 1200);
  }
});

async function api(path) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`Local request failed (${response.status})`);
  return response.json();
}
async function mutate(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'x-pinotator-csrf': '1',
    },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok)
    throw Object.assign(new Error(result.message || `Local request failed (${response.status})`), {
      code: result.error,
      details: result.details,
    });
  return result;
}
function canEdit() {
  return Boolean(state.env?.capabilities?.mutation);
}
function refreshPendingExternalChanges() {
  if (!externalRefreshPending) return;
  externalRefreshPending = false;
  state.effectiveRuntime = null;
  load().catch(showError);
}
// The window owns page scroll; the sidebar owns its independent scroll area.
// New sections start at the top, resource selections keep their list position,
// and back/forward restores the exact entry rather than the browser's best guess.
history.scrollRestoration = 'manual';
let scrollFrame = 0;
window.addEventListener(
  'scroll',
  () => {
    cancelAnimationFrame(scrollFrame);
    scrollFrame = requestAnimationFrame(saveScrollPosition);
  },
  { passive: true },
);
function saveScrollPosition() {
  history.replaceState({ ...history.state, scrollY: window.scrollY }, '');
}
function navigate(path) {
  const destination = new URL(path, location.href);
  const preserveScroll =
    destination.pathname.split('/')[1] === location.pathname.split('/')[1] &&
    destination.search === location.search &&
    matchMedia('(min-width: 1100px)').matches;
  const scroll = preserveScroll ? window.scrollY : 0;
  saveScrollPosition();
  if (`${location.pathname}${location.search}` !== `${destination.pathname}${destination.search}`)
    history.pushState({ scrollY: scroll }, '', path);
  render({ scroll, focus: true });
  refreshPendingExternalChanges();
}
function notify(message: string, review = false) {
  showToast(message, review);
}
async function staged(message = 'Changes staged. Your files have not changed.') {
  try {
    state.changes = await api('/api/changes');
    updateStagedCount(
      state.changes.filter((change) => !['applied', 'rolled_back'].includes(change.status)).length,
    );
  } catch {
    notify(
      'Changes staged, but the review count could not be refreshed. Open Changes to review.',
      true,
    );
    return;
  }
  notify(message, true);
}
async function stageProposal(edit) {
  try {
    await mutate('/api/changes/propose', { edits: [edit] });
    await staged();
    return true;
  } catch (error) {
    notify(error.message);
    return false;
  }
}
async function load() {
  const [
    overview,
    resources,
    files,
    diagnostics,
    instructions,
    environment,
    changes,
    recovery,
    snapshots,
  ] = await Promise.all([
    api('/api/overview'),
    api('/api/resources'),
    api('/api/files'),
    api('/api/diagnostics'),
    api('/api/instructions/preview'),
    api('/api/environment'),
    api('/api/changes'),
    api('/api/recovery'),
    api('/api/snapshots'),
  ]);
  externalRefreshPending = false;
  state.overview = overview;
  state.env = environment;
  state.resources = resources;
  invalidateModelCatalog();
  providerCatalog = undefined;
  providerCatalogFailure = false;
  state.files = files;
  state.diagnostics = diagnostics;
  state.instructions = instructions;
  state.changes = changes;
  state.recovery = recovery;
  state.snapshots = snapshots;
  document.getElementById('cwd').textContent = state.env.workingDirectory;
  document.getElementById('cwd').title = state.env.workingDirectory;
  document.getElementById('pi-version').textContent = state.env.piVersion
    ? `Pi ${state.env.piVersion}`
    : 'Pi not found';
  document.getElementById('trust').textContent = `Trust: ${state.env.trust}`;
  document.getElementById('trust').className = `pill trust-${state.env.trust}`;
  document.getElementById('mode-label').textContent =
    `${state.env.mode} workspace${state.env.readOnly ? ' · read-only' : ''}`;
  render();
}
function currentPath() {
  return decodeURIComponent(location.pathname.replace(/\/$/, '') || '/');
}
function routeContext(path) {
  if (path === '/') return { page: 'dashboard' };
  if (path === '/instructions') return { page: 'instructions' };
  if (path === '/effective') return { page: 'effective' };
  if (path === '/analysis') return { page: 'analysis' };
  if (path === '/companion') return { page: 'companion' };
  if (path === '/migration') return { page: 'migration' };
  if (path === '/templates') return { page: 'templates' };
  if (path.startsWith('/sources/')) return { page: 'source', id: path.split('/')[2] };
  if (path === '/sources') return { page: 'sources' };
  if (path === '/diagnostics') return { page: 'diagnostics' };
  if (path === '/changes') return { page: 'changes' };
  if (path === '/snapshots') return { page: 'snapshots' };
  if (path === '/keybindings') return { page: 'keybindings' };
  if (path === '/extensions' || path.startsWith('/extensions/'))
    return { page: 'extensions', id: path.split('/')[2] };
  const root = '/' + path.split('/')[1];
  if (kindForPath[root]) return { page: 'list', root, id: path.split('/')[2] };
  return { page: 'empty', title: 'Not found', message: 'This section is not available.' };
}
function panel(title, subtitle = '') {
  const section = make('section', 'panel');
  const header = make('div', 'panel-header');
  header.append(make('h2', '', title));
  if (subtitle) header.append(make('p', 'muted', subtitle));
  section.append(header);
  return section;
}
function badge(label, extra = '') {
  return make('span', `badge ${extra}`, label);
}
function sourceLink(source) {
  return source?.fileId
    ? link(
        `/sources/${encodeURIComponent(source.fileId)}`,
        'Open source',
        'button secondary compact',
      )
    : null;
}
function stateLabel(value) {
  return (
    {
      active: 'Active',
      shadowed: 'Shadowed',
      excluded: 'Excluded',
      untrusted: 'Untrusted',
      invalid: 'Invalid',
      unknown: 'Unknown',
    }[value] || 'Unknown'
  );
}
function fmt(value) {
  if (value === undefined || value === null || value === '') return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
function addDiagnostics(parent, entries = []) {
  if (!entries.length) {
    parent.append(make('p', 'muted', 'No diagnostics.'));
    return;
  }
  const list = make('ul', 'diagnostic-list');
  for (const item of entries) {
    const row = make('li', `severity-${item.severity || 'info'}`);
    row.append(badge(item.severity || 'info'), make('span', '', item.message || item.code));
    if (item.sourceId) {
      const file = state.files.find((f) => f.id === item.sourceId);
      if (file) row.append(sourceLink({ fileId: file.id }));
    }
    list.append(row);
  }
  parent.append(list);
}
function renderDashboard() {
  const page = make('div', 'page dashboard-page');
  const pendingChanges = state.changes.filter(
    (change) => !['applied', 'rolled_back'].includes(change.status),
  );
  const findings = [...state.diagnostics].sort(
    (a, b) =>
      (({ error: 0, warning: 1, info: 2 })[a.severity] ?? 3) -
      ({ error: 0, warning: 1, info: 2 }[b.severity] ?? 3),
  );
  page.append(
    make('h1', '', 'Your Pi configuration, in view.'),
    make(
      'p',
      'lead',
      'Inspect local resources, investigate findings, and review changes before they reach your files.',
    ),
  );
  const actions = make('div', 'page-actions');
  actions.append(
    link('/effective', 'Inspect effective state', 'button secondary'),
    link(
      '/changes',
      pendingChanges.length ? `Review changes · ${pendingChanges.length}` : 'Review changes',
      'button',
    ),
  );
  page.append(actions);

  const review = make('section', 'dashboard-review');
  review.setAttribute('aria-label', 'Workspace review');
  const reviewCopy = make('div', 'dashboard-review-copy');
  reviewCopy.append(
    make(
      'h2',
      '',
      findings.length
        ? `${findings.length} diagnostic finding${findings.length === 1 ? '' : 's'} to review`
        : 'No passive diagnostics reported',
    ),
    make(
      'p',
      'muted',
      findings.length
        ? 'Start with the findings below. Inventory checks do not verify running sessions.'
        : 'Static checks found no issues. Runtime readiness is still unverified.',
    ),
  );
  review.append(reviewCopy, link('/diagnostics', 'View diagnostics →', 'text-link'));
  if (state.env.readOnly) {
    review.append(
      make(
        'p',
        'dashboard-access muted',
        'Read-only workspace · Editing and workspace launching are disabled.',
      ),
    );
  } else if (pendingChanges.length) {
    review.append(
      make(
        'p',
        'dashboard-access muted',
        `${pendingChanges.length} changeset${pendingChanges.length === 1 ? '' : 's'} awaiting review. Files change only after explicit Apply.`,
      ),
    );
  }
  page.append(review);

  const primary = make('div', 'dashboard-primary');
  const inventory = panel(
    'Resource inventory',
    `${state.resources.length} candidates across ${state.files.length} source files. Counts describe discovery, not runtime health.`,
  );
  inventory.classList.add('dashboard-inventory');
  const groups: { label: string; items: [string, string, string][] }[] = [
    {
      label: 'Workspace',
      items: [
        ['agent', 'Agents', '/agents'],
        ['skill', 'Skills', '/skills'],
        ['command', 'Commands', '/commands'],
        ['instruction', 'Instructions', '/instructions'],
      ],
    },
    {
      label: 'Configuration',
      items: [
        ['model', 'Models', '/models'],
        ['provider', 'Providers', '/providers'],
        ['setting', 'Settings', '/settings'],
        ['mcp', 'MCP servers', '/mcp'],
      ],
    },
    {
      label: 'Extensions',
      items: [
        ['extension', 'Extensions', '/extensions'],
        ['package', 'Packages', '/extensions'],
        ['keybinding', 'Keybindings', '/keybindings'],
      ],
    },
  ];
  const groupedKinds = new Set(groups.flatMap((group) => group.items.map(([kind]) => kind)));
  const otherItems: [string, string, string][] = Object.keys(state.overview.counts || {})
    .filter((kind) => !groupedKinds.has(kind))
    .map((kind) => [kind, kind.replaceAll('-', ' '), '/sources']);
  if (otherItems.length) groups.push({ label: 'Other sources', items: otherItems });
  for (const group of groups) {
    const section = make('div', 'inventory-group');
    section.append(make('h3', '', group.label));
    const rows = make('div', 'inventory-links');
    for (const [kind, label, href] of group.items) {
      const row = link(href, '', 'inventory-link');
      row.append(
        make('span', '', label),
        make('strong', '', state.overview.counts?.[kind] || 0),
        make('span', 'inventory-arrow', '→'),
      );
      row.lastElementChild.setAttribute('aria-hidden', 'true');
      rows.append(row);
    }
    section.append(rows);
    inventory.append(section);
  }
  const statuses = make('div', 'inventory-status');
  statuses.append(make('strong', '', 'Candidate status'));
  for (const [status, count] of Object.entries(state.overview.states || {})) {
    if (count) statuses.append(badge(`${count} ${stateLabel(status)}`, `status-${status}`));
  }
  if (!state.resources.length) {
    statuses.append(
      make('span', '', 'No candidates discovered. Check source paths and workspace context.'),
    );
  }
  inventory.append(statuses, link('/sources', 'Browse source files →', 'text-link'));
  primary.append(inventory);

  const context = make('div', 'dashboard-stack');
  const diagnosticPanel = panel(
    'Diagnostics',
    'Highest-severity findings first · passive checks only',
  );
  diagnosticPanel.classList.add('dashboard-diagnostics');
  if (findings.length) addDiagnostics(diagnosticPanel, findings.slice(0, 4));
  else
    diagnosticPanel.append(
      make(
        'p',
        'muted',
        'No findings from passive checks. Extensions, MCP servers, and model calls have not been tested.',
      ),
    );
  diagnosticPanel.append(
    link(
      '/diagnostics',
      findings.length > 4 ? `View all ${findings.length} findings →` : 'Open diagnostics →',
      'text-link',
    ),
  );
  context.append(diagnosticPanel);

  const startupModel = state.overview.startupModel;
  const modelPanel = panel(
    'Startup model',
    'Configured default for new sessions, not the model of a running session.',
  );
  const modelName = startupModel?.provider
    ? `${startupModel.provider}/${startupModel.value}`
    : startupModel?.value || 'Not configured';
  modelPanel.append(make('p', 'dashboard-model-name', modelName));
  const modelDetails = make('dl', 'detail-list');
  for (const [label, value] of [
    ['Source scope', startupModel?.sourceScope || '—'],
    ['Readiness', startupModel?.readiness || 'unknown'],
    ['Certainty', startupModel?.effectiveCertainty || 'unknown'],
    ['Source path', startupModel?.sourcePath || '—'],
  ])
    modelDetails.append(make('dt', '', label), make('dd', '', value));
  modelPanel.append(modelDetails, link('/models', 'Inspect models →', 'text-link'));
  context.append(modelPanel);
  primary.append(context);
  page.append(primary);

  const environment = panel(
    'Environment & provenance',
    'Launch context is fixed for this Pinotator instance.',
  );
  environment.classList.add('dashboard-environment');
  const dl = make('dl', 'detail-list');
  for (const [label, value] of [
    ['Working directory', state.env.workingDirectory],
    ['Project root', state.env.projectRoot || 'Global-only'],
    ['Pi executable', state.env.piBinary || 'Not detected'],
    ['Pi version', state.env.piVersion || 'Unknown'],
    ['Agent directory', state.env.agentDirectory],
    ['Trust', state.env.trust],
  ])
    dl.append(make('dt', '', label), make('dd', '', value));
  environment.append(dl);
  const safety = make(
    'p',
    'muted dashboard-safety',
    'Passive inspection only. Extensions, MCP servers, package scripts, credential commands, and model calls are not executed. Your files remain the source of truth.',
  );
  environment.append(safety);
  page.append(environment);

  const workspacePanel = make('details', 'panel dashboard-workspaces');
  workspacePanel.append(make('summary', '', 'Open another workspace'));
  workspacePanel.append(
    make(
      'p',
      'muted',
      'Keep this context intact. Launch another project in a separate protected Pinotator instance.',
    ),
  );
  const form = make('form', 'form-stack');
  const workspacePath = labeledInput(form, 'Absolute project directory', 'e.g. /srv/my-project');
  workspacePath.required = true;
  const rememberLabel = make('label', 'dashboard-remember');
  const rememberInput = make('input');
  rememberInput.type = 'checkbox';
  rememberLabel.append(rememberInput, make('span', '', 'Remember this project locally'));
  form.append(rememberLabel);
  const openButton = make('button', 'button', 'Open separate workspace');
  openButton.type = 'submit';
  openButton.disabled = !canEdit();
  workspacePath.disabled = !canEdit();
  rememberInput.disabled = !canEdit();
  form.append(openButton);
  if (!canEdit())
    form.append(
      make('p', 'muted', 'Workspace launching is unavailable in this read-only instance.'),
    );
  const recentList = make('div', 'profile-list');
  const workspaceFeedback = make('p', 'muted');
  workspaceFeedback.setAttribute('role', 'status');
  workspacePanel.append(form, workspaceFeedback, recentList);
  let launching = false;
  const launchWorkspace = async (projectPath, remember) => {
    if (launching || !canEdit()) return;
    if (!projectPath.startsWith('/')) {
      workspaceFeedback.textContent = 'Enter an absolute project directory, starting with /.';
      workspacePath.focus();
      return;
    }
    launching = true;
    openButton.disabled = true;
    openButton.textContent = 'Opening workspace…';
    workspacePanel.setAttribute('aria-busy', 'true');
    workspaceFeedback.textContent = '';
    const child = window.open('about:blank', '_blank');
    if (child) child.opener = null;
    try {
      const result = await mutate('/api/workspaces/open', {
        path: projectPath,
        remember,
        confirmed: true,
      });
      if (child) child.location.replace(result.url);
      else {
        const anchor = link(result.url, `Continue to ${result.path}`, 'text-link');
        anchor.target = '_blank';
        anchor.rel = 'noopener noreferrer';
        workspaceFeedback.append(anchor);
      }
      if (child) workspaceFeedback.textContent = 'Workspace opened in a separate tab.';
      await renderRecentWorkspaces();
    } catch (error) {
      child?.close();
      workspaceFeedback.textContent = error.message;
    } finally {
      launching = false;
      openButton.disabled = !canEdit();
      openButton.textContent = 'Open separate workspace';
      workspacePanel.removeAttribute('aria-busy');
    }
  };
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void launchWorkspace(workspacePath.value.trim(), rememberInput.checked);
  });
  const renderRecentWorkspaces = async () => {
    try {
      const recent = await api('/api/workspaces/recent');
      recentList.replaceChildren();
      if (!recent.length) recentList.append(make('p', 'muted', 'No remembered workspaces yet.'));
      for (const item of recent) {
        const row = make('div', 'profile-row');
        row.append(make('span', '', item.path));
        const reopen = make('button', 'button compact secondary', 'Open');
        reopen.type = 'button';
        reopen.setAttribute('aria-label', `Open workspace ${item.path}`);
        reopen.disabled = !canEdit();
        reopen.addEventListener('click', () => launchWorkspace(item.path, true));
        row.append(reopen);
        recentList.append(row);
      }
    } catch (error) {
      recentList.replaceChildren(make('p', 'warning', error.message));
    }
  };
  let recentLoaded = false;
  workspacePanel.addEventListener('toggle', () => {
    if (workspacePanel.open && !recentLoaded) {
      recentLoaded = true;
      void renderRecentWorkspaces();
    }
  });
  page.append(workspacePanel);
  return page;
}
function mcpRemovalButton(item) {
  const file = state.files.find((candidate) => candidate.id === item.source?.fileId);
  const remove = make('button', 'button secondary compact', 'Remove server');
  remove.type = 'button';
  remove.setAttribute('aria-label', `Stage removal of MCP server ${item.name} from ${item.scope}`);
  const structuredEditable = file?.kind === 'mcp' && ['global', 'project'].includes(file.scope);
  remove.disabled = !canEdit() || !structuredEditable || Boolean(item.legacySchema);
  remove.title = !canEdit()
    ? 'Read-only workspace'
    : item.legacySchema
      ? 'Legacy MCP schema is inspect-only'
      : !structuredEditable
        ? 'Source does not support structured editing'
        : 'Stage for review; does not disconnect a running session';
  remove.addEventListener('click', async () => {
    if (
      !confirm(
        `Stage removal of MCP server ${item.name} from ${file.displayPath}? Files change only after Apply. Removing a project override may expose the global definition. Running sessions and stored OAuth credentials are not changed.`,
      )
    )
      return;
    remove.disabled = true;
    remove.textContent = 'Staging…';
    const success = await stageProposal({
      intent: 'set-mcp',
      fileId: file.id,
      expectedHash: file.versionHash,
      change: { operation: 'remove', serverName: item.name },
    });
    remove.textContent = success ? 'Removal staged' : 'Remove server';
    remove.disabled = success;
  });
  return remove;
}
function renderTable(resources, root) {
  const table = make('table', 'resource-table');
  const caption = make('caption', 'sr-only', `${resources.length} resources`);
  table.append(caption);
  const thead = make('thead');
  const tr = make('tr');
  for (const title of [
    'Name',
    'Description',
    'Scope',
    'Status',
    'Origin',
    ...(root === '/mcp' ? ['Actions'] : []),
  ])
    tr.append(make('th', '', title));
  thead.append(tr);
  table.append(thead);
  const body = make('tbody');
  for (const item of resources) {
    const row = make('tr');
    const nameCell = make('td');
    nameCell.append(link(`${root}/${encodeURIComponent(item.id)}`, item.name, 'resource-name'));
    const descriptionCell = make('td', 'description-cell');
    const description = make('span', 'resource-description', item.description || '—');
    description.title = item.description || '';
    descriptionCell.append(description);
    const originCell = make('td', 'origin-cell');
    const origin = make(
      'span',
      'resource-origin',
      item.source?.displayPath || item.owner || 'unknown',
    );
    origin.title = origin.textContent;
    originCell.append(origin);
    row.append(
      nameCell,
      descriptionCell,
      make('td', '', item.scope || 'unknown'),
      make('td', 'resource-status'),
      originCell,
    );
    row
      .querySelector('.resource-status')
      .append(badge(stateLabel(item.state), `status-${item.state || 'unknown'}`));
    if (root === '/mcp') {
      const actions = make('td', 'row-actions');
      actions.append(mcpRemovalButton(item));
      row.append(actions);
    }
    body.append(row);
  }
  table.append(body);
  return table;
}
function settingControl(item, path, value, label) {
  const row = make('div', 'edit-field');
  row.append(make('label', '', label || path.join('.')));
  let input, readValue;
  if (typeof value === 'boolean') {
    input = make('input');
    input.type = 'checkbox';
    input.checked = value;
    readValue = () => input.checked;
  } else if (['defaultThinkingLevel', 'thinking', 'defaultThinking'].includes(path.at(-1))) {
    input = make('select', 'search');
    for (const optionValue of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
      const option = make('option', '', optionValue);
      option.value = optionValue;
      input.append(option);
    }
    input.value = value || 'medium';
    readValue = () => input.value;
  } else if (['defaultProjectTrust'].includes(path.at(-1))) {
    input = make('select', 'search');
    for (const optionValue of ['ask', 'always', 'never']) {
      const option = make('option', '', optionValue);
      option.value = optionValue;
      input.append(option);
    }
    input.value = value || 'ask';
    readValue = () => input.value;
  } else if (['steeringMode', 'followUpMode'].includes(path.at(-1))) {
    input = make('select', 'search');
    for (const optionValue of ['all', 'one-at-a-time']) {
      const option = make('option', '', optionValue);
      option.value = optionValue;
      input.append(option);
    }
    input.value = value || 'one-at-a-time';
    readValue = () => input.value;
  } else if (path.at(-1) === 'tuiMode') {
    input = make('select', 'search');
    for (const optionValue of ['fullscreen', 'regular']) {
      const option = make('option', '', optionValue);
      option.value = optionValue;
      input.append(option);
    }
    input.value = value || 'fullscreen';
    readValue = () => input.value;
  } else if (Array.isArray(value)) {
    input = make('input', 'search');
    input.value = value.join(', ');
    input.placeholder = 'Comma-separated values';
    readValue = () =>
      input.value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
  } else if (typeof value === 'number') {
    input = make('input', 'search');
    input.type = 'number';
    input.value = String(value);
    readValue = () => Number(input.value);
  } else if (value && typeof value === 'object') {
    input = make('textarea', 'editor');
    input.value = JSON.stringify(value, null, 2);
    readValue = () => JSON.parse(input.value);
  } else {
    input = make('input', 'search');
    input.value = value == null ? '' : String(value);
    readValue = () => input.value;
  }
  input.setAttribute('aria-label', label || path.join('.'));
  input.id = `setting-${item.id}-${path.join('-')}`;
  row.querySelector('label').htmlFor = input.id;
  const button = make('button', 'button', 'Stage setting');
  button.type = 'button';
  button.addEventListener('click', () => {
    try {
      if (item.name === 'defaultProjectTrust' && item.source?.scope !== 'global')
        throw new Error('This setting is global-only in the installed Pi schema.');
      stageProposal({
        intent: 'set-setting',
        fileId: item.source.fileId,
        expectedHash: item.source.versionHash,
        path,
        value: readValue(),
      });
    } catch (error) {
      notify(error.message);
    }
  });
  row.append(
    input,
    button,
    make(
      'p',
      'muted',
      'Targeted JSONC patch preserves unrelated keys and comments. Runtime changes still require Pi reload or a new session.',
    ),
  );
  return row;
}
function renderAgentEditor(container, item, editor) {
  const creating = Boolean(editor.creating);
  if (!editor.editable)
    throw new Error('This agent is not editable with the tested adapter version.');
  const form = make('form', 'guided-editor');
  form.dataset.stageShortcut = 'true';
  form.append(make('h3', '', creating ? 'Agent configuration' : `Guided editor · ${item.name}`));
  form.append(
    make(
      'p',
      'muted',
      creating
        ? 'Choose the name, purpose, prompt, and optional overrides. Expand advanced settings for the full reviewed adapter field set.'
        : 'Only recognized frontmatter fields are updated. Unknown fields and comments are preserved. Apply remains a separate step.',
    ),
  );
  if (editor.parseError)
    throw new Error(
      'Invalid YAML frontmatter must be fixed in the raw source view before guided editing.',
    );
  const controls = new Map();
  const current = editor.frontmatter || {};
  const scope = creating
    ? selectField(
        form,
        'Target scope',
        state.env.mode === 'global'
          ? [['global', 'Global Pi']]
          : [
              ['project', 'Project Pi'],
              ['global', 'Global Pi'],
            ],
      )
    : null;
  let fieldContainer: HTMLElement = form;
  const addControl = (
    key: string,
    label: string,
    type = 'text',
    options: { values?: string[]; placeholder?: string } = {},
  ) => {
    const wrapper = make('label', 'field');
    wrapper.append(make('span', '', label));
    let control;
    if (type === 'textarea' || type === 'json') {
      control = make('textarea', '');
      control.rows = type === 'json' ? 4 : 3;
      control.value =
        type === 'json'
          ? current[key] === undefined
            ? ''
            : JSON.stringify(current[key], null, 2)
          : (current[key] ?? '');
    } else if (type === 'select') {
      control = make('select', 'input');
      const values = [
        ...new Set([...(options.values || []), ...(current[key] ? [current[key]] : [])]),
      ];
      for (const value of values) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = value;
        control.append(option);
      }
      control.value = current[key] || options.values?.[0] || '';
    } else {
      control = make('input', 'input');
      control.type = type;
      if (type === 'checkbox') control.checked = Boolean(current[key]);
      else control.value = current[key] ?? '';
    }
    if (options.placeholder) control.placeholder = options.placeholder;
    wrapper.append(control);
    fieldContainer.append(wrapper);
    controls.set(key, { control, type });
  };
  addControl('name', 'Agent name', 'text');
  addControl('description', 'Description', 'textarea');
  controls.get('name').control.required = true;
  controls.get('name').control.pattern = '[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}';
  controls.get('description').control.required = true;
  controls.get('description').control.maxLength = 1024;
  addControl('model', 'Model (optional)', 'text');
  controls.get('model').control.dataset.modelPicker = 'true';
  addControl('thinking', 'Thinking level', 'select', {
    values: ['inherit', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  });
  addControl('systemPromptMode', 'System prompt mode', 'select', { values: ['append', 'replace'] });
  addControl('tools', 'Allowed tools (one per line; blank uses adapter defaults)', 'textarea');
  addControl('skills', 'Explicit skills (one per line; optional)', 'textarea');
  const advanced = make('details', 'advanced-fields');
  advanced.append(make('summary', '', 'Advanced agent configuration'));
  const advancedBody = make('div', 'form-stack');
  advanced.append(advancedBody);
  form.append(advanced);
  fieldContainer = advancedBody;
  for (const key of ['excludeTools', 'aliases', 'allowedAgents', 'subagentOnlyExtensions'])
    addControl(key, `${key} (one per line)`, 'textarea');
  for (const key of [
    'advertise',
    'inheritProjectContext',
    'inheritGlobalContext',
    'inheritSkills',
    'async',
    'interactive',
    'allowNestedSubagents',
  ])
    addControl(key, key, 'checkbox');
  for (const key of ['timeoutMs', 'toolTimeoutMs', 'maxSubagentDepth'])
    addControl(key, key, 'number');
  for (const key of [
    'output',
    'defaultReads',
    'defaultProgress',
    'acceptance',
    'acceptanceRole',
    'memory',
    'launcher',
    'defaultContext',
    'machine',
  ])
    addControl(key, `${key} (JSON)`, 'json');
  const promptLabel = make('label', 'field');
  promptLabel.append(make('span', '', 'Agent prompt body'));
  const prompt = make('textarea', '');
  prompt.rows = 12;
  prompt.value = editor.body || '';
  prompt.disabled = Boolean(editor.bodyRedacted);
  promptLabel.append(prompt);
  form.append(promptLabel);
  if (editor.bodyRedacted)
    form.append(
      make(
        'p',
        'warning',
        'Prompt text contains redacted credential-like content. Body editing is disabled; metadata-only edits preserve the original bytes.',
      ),
    );
  if (editor.unknownFields?.length)
    form.append(
      make(
        'p',
        'muted',
        `Unrecognized frontmatter is preserved without interpretation: ${editor.unknownFields.join(', ')}.`,
      ),
    );
  if (editor.effectiveModel)
    form.append(
      make(
        'p',
        'muted',
        `Current effective model: ${editor.effectiveModel.value} (${editor.effectiveModel.source}; ${editor.effectiveModel.certainty}). Settings overrides may continue to win.`,
      ),
    );
  const submit = make(
    'button',
    'button',
    creating ? 'Review staged agent creation' : 'Review staged agent edit',
  );
  submit.type = 'submit';
  form.append(submit);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    submit.disabled = true;
    try {
      const fields = {};
      for (const [key, { control, type }] of controls) {
        const oldValue = current[key];
        let value;
        if (type === 'checkbox') value = control.checked;
        else if (type === 'number') value = control.value === '' ? null : Number(control.value);
        else if (type === 'json') {
          if (!control.value.trim()) value = null;
          else
            try {
              value = JSON.parse(control.value);
            } catch {
              throw new Error(`${key} must contain valid JSON.`);
            }
        } else if (
          [
            'tools',
            'excludeTools',
            'aliases',
            'skills',
            'allowedAgents',
            'subagentOnlyExtensions',
          ].includes(key)
        )
          value = control.value
            .split(/\r?\n|,/)
            .map((part) => part.trim())
            .filter(Boolean);
        else value = control.value.trim();
        if (type !== 'checkbox' && (value === '' || (Array.isArray(value) && value.length === 0)))
          value = null;
        if (type === 'checkbox' && oldValue === undefined && value === false) continue;
        if (JSON.stringify(value) !== JSON.stringify(oldValue ?? null)) fields[key] = value;
      }
      if (creating) {
        const frontmatter = Object.fromEntries(
          Object.entries({ ...current, ...fields }).filter(([, value]) => value !== null),
        );
        const yaml = Object.entries(frontmatter)
          .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
          .join('\n');
        await mutate('/api/changes/propose', {
          edits: [
            {
              intent: 'create',
              createTarget: {
                scope: scope.value,
                kind: 'agent',
                basename: String(frontmatter.name),
              },
              content: `---\n${yaml}\n---\n\n${prompt.value}`,
            },
          ],
        });
        await staged();
        return;
      }
      const changes: AgentChanges = {};
      if (Object.keys(fields).length) changes.fields = fields;
      if (!prompt.disabled && prompt.value !== (editor.body || '')) changes.body = prompt.value;
      if (!Object.keys(changes).length) throw new Error('No changes to stage.');
      await mutate('/api/changes/propose', {
        edits: [
          { intent: 'set-agent', fileId: editor.fileId, expectedHash: editor.versionHash, changes },
        ],
      });
      await staged();
    } catch (error) {
      notify(error.message);
    } finally {
      submit.disabled = false;
    }
  });
  container.replaceChildren(form);
}

async function renderSkillEditor(container, item, manifestFile) {
  const assets = state.files.filter((file) => file.skillManifestId === manifestFile.id);
  const sources = [manifestFile, ...assets];
  const documents = [];
  for (const file of sources) {
    const source = await api(`/api/source?id=${encodeURIComponent(file.id)}`);
    documents.push({
      file,
      content: source.content || '',
      redacted: Boolean(source.redacted) || (source.content || '').includes('[REDACTED]'),
    });
  }
  const form = make('form', 'guided-editor');
  form.dataset.stageShortcut = 'true';
  form.append(make('h3', '', `Multi-file skill editor · ${item.name}`));
  form.append(
    make(
      'p',
      'muted',
      'Edit the manifest and text assets together as one staged changeset. New files are created non-executable. Binary files and credential-like content remain unsupported.',
    ),
  );
  for (const document of documents) {
    const section = make('section', 'skill-file-editor');
    section.append(
      make(
        'strong',
        '',
        document.file === manifestFile
          ? 'SKILL.md'
          : document.file.displayPath.split(/[\\/]/).slice(-2).join('/'),
      ),
    );
    const textarea = make('textarea', '');
    textarea.rows = document.file === manifestFile ? 10 : 6;
    textarea.value = document.content;
    textarea.setAttribute(
      'aria-label',
      document.file === manifestFile
        ? 'Skill manifest (SKILL.md)'
        : `Edit skill file ${document.file.displayPath}`,
    );
    textarea.disabled = document.redacted || !document.file.editable;
    section.append(textarea);
    const record = { ...document, textarea };
    if (document.file !== manifestFile) {
      const removeLabel = make('label', 'field');
      const remove = make('input', '');
      remove.type = 'checkbox';
      removeLabel.append(remove, make('span', '', 'Delete this file on Apply'));
      section.append(removeLabel);
      record.remove = remove;
    }
    if (document.redacted)
      section.append(
        make(
          'p',
          'warning',
          'This source contains redacted content and cannot be edited in the browser.',
        ),
      );
    form.append(section);
    document.record = record;
  }
  const newPath = make('input', 'input');
  newPath.placeholder = 'references/new-guide.md';
  const newContent = make('textarea', '');
  newContent.rows = 5;
  const pathLabel = make('label', 'field');
  pathLabel.append(make('span', '', 'Add file path'), newPath);
  const contentLabel = make('label', 'field');
  contentLabel.append(make('span', '', 'New file content'), newContent);
  form.append(pathLabel, contentLabel);
  const submit = make('button', 'button', 'Review all skill-file changes');
  submit.type = 'submit';
  form.append(submit);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const edits = [];
      for (const document of documents) {
        const { file, content, textarea, redacted, remove } = document.record;
        if (remove?.checked) {
          edits.push({ intent: 'delete', fileId: file.id, expectedHash: file.versionHash });
        } else if (!redacted && textarea.value !== content) {
          edits.push({
            intent: 'update',
            fileId: file.id,
            expectedHash: file.versionHash,
            content: textarea.value,
          });
        }
      }
      if (newPath.value.trim() || newContent.value) {
        const basename = newPath.value.trim().replace(/^\/+|\.+$/g, '');
        if (!basename || !newContent.value)
          throw new Error('Provide both a safe new file path and its content.');
        const scope =
          manifestFile.scope === 'global'
            ? 'global'
            : manifestFile.scope === 'portable'
              ? 'portable'
              : manifestFile.owner === 'portable-skill'
                ? 'portable-project'
                : 'project';
        const skillName = manifestFile.displayPath.split(/[\\/]/).slice(-2, -1)[0];
        edits.push({
          intent: 'create',
          createTarget: { scope, kind: 'skill-import-file', basename: `${skillName}/${basename}` },
          content: newContent.value,
        });
      }
      if (!edits.length) throw new Error('No skill-file changes to stage.');
      await mutate('/api/changes/propose', { edits });
      await staged();
    } catch (error) {
      notify(error.message);
    }
  });
  container.replaceChildren(form);
}

function renderResourceDetail(item) {
  const box = make('div', 'resource-detail');
  box.append(make('h2', '', item.name), badge(stateLabel(item.state), `status-${item.state}`));
  box.append(make('p', 'muted', item.description || 'No description provided.'));
  const details = make('dl', 'detail-list');
  for (const [label, value] of [
    ['Kind', item.kind],
    ['Scope', item.scope],
    ['Owner', item.owner],
    ['State', stateLabel(item.state)],
    ['Source path', item.source?.displayPath],
    ['Trust', item.source?.trust],
    ['Source hash', item.source?.versionHash],
  ])
    details.append(make('dt', '', label), make('dd', '', fmt(value)));
  if (item.adapter) {
    details.append(
      make('dt', '', 'Adapter'),
      make(
        'dd',
        '',
        `${item.adapter} ${item.adapterVersion || ''} (${item.adapterCompatibility || 'unverified'})`,
      ),
    );
  }
  if (item.effectiveModel) {
    details.append(
      make('dt', '', 'Effective model'),
      make(
        'dd',
        '',
        `${fmt(item.effectiveModel.value)} · ${item.effectiveModel.source} · ${item.effectiveModel.certainty}`,
      ),
    );
  }
  if (item.readiness) {
    details.append(make('dt', '', 'Provider readiness'), make('dd', '', item.readiness));
  }
  if (item.baseUrl) {
    details.append(make('dt', '', 'Endpoint origin'), make('dd', '', item.baseUrl));
  }
  if (item.capabilities) {
    details.append(make('dt', '', 'Capabilities / cost'), make('dd', '', fmt(item.capabilities)));
  }
  if (item.transport) {
    details.append(make('dt', '', 'Transport'), make('dd', '', item.transport));
  }
  if (item.kind === 'extension') {
    details.append(
      make('dt', '', 'Entry-point candidate'),
      make(
        'dd',
        '',
        item.entryPointCandidate
          ? 'Yes, based on a recognized declaration/layout; runtime not loaded.'
          : 'Not established by a recognized entry-point layout.',
      ),
      make('dt', '', 'Entry-point layout'),
      make('dd', '', item.entryPointLayout || 'unknown'),
      make('dt', '', 'Runtime registrations'),
      make('dd', '', 'Unknown — extension code was not executed.'),
    );
    if (item.configuredPath)
      details.append(
        make('dt', '', 'Origin'),
        make('dd', '', 'Explicitly configured extension path (read-only)'),
      );
  }
  if (item.kind === 'mcp')
    for (const key of [
      'enabled',
      'exposure',
      'timeout',
      'environmentVariableNames',
      'toolExposure',
      'effectiveSourceScope',
      'policyOverride',
      'overriddenGlobal',
      'legacySchema',
    ])
      if (item[key] !== undefined)
        details.append(make('dt', '', key), make('dd', '', fmt(item[key])));
  if (item.commandType) {
    details.append(make('dt', '', 'Command category'), make('dd', '', item.commandType));
  }
  box.append(details);
  if (item.source) {
    const action = sourceLink(item.source);
    if (action) box.append(action);
  }
  if (canEdit() && item.kind === 'setting' && item.source?.fileId) {
    const editable = new Set([
      'defaultModel',
      'defaultProvider',
      'defaultThinkingLevel',
      'modelThinkingLevels',
      'enabledModels',
      'defaultTools',
      'defaultProjectTrust',
      'enableSkillCommands',
      'steeringMode',
      'followUpMode',
      'tuiMode',
      'theme',
      'quietStartup',
    ]);
    if (editable.has(item.name))
      box.append(settingControl(item, [item.name], item.value, `Stage ${item.name}`));
    if (item.name === 'compaction' && item.value && typeof item.value === 'object')
      for (const field of ['enabled', 'reserveTokens', 'keepRecentTokens'])
        if (item.value[field] !== undefined)
          box.append(
            settingControl(
              item,
              ['compaction', field],
              item.value[field],
              `Stage compaction.${field}`,
            ),
          );
    if (item.name === 'retry' && item.value && typeof item.value === 'object')
      for (const field of ['enabled', 'maxRetries', 'baseDelayMs', 'maxAgentDelayMs'])
        if (item.value[field] !== undefined)
          box.append(
            settingControl(item, ['retry', field], item.value[field], `Stage retry.${field}`),
          );
    if (item.name === 'retry' && item.value?.provider && typeof item.value.provider === 'object')
      for (const field of ['timeoutMs', 'maxRetries', 'maxRetryDelayMs'])
        if (item.value.provider[field] !== undefined)
          box.append(
            settingControl(
              item,
              ['retry', 'provider', field],
              item.value.provider[field],
              `Stage retry.provider.${field}`,
            ),
          );
    if (item.name === 'subagents' && item.value && typeof item.value === 'object') {
      for (const field of ['defaultModel', 'defaultThinking', 'defaultProvider', 'agentScope'])
        if (item.value[field] !== undefined)
          box.append(
            settingControl(
              item,
              ['subagents', field],
              item.value[field],
              `Stage subagents.${field}`,
            ),
          );
      for (const [agent, fields] of Object.entries(item.value.agentOverrides || {}))
        if (/^[A-Za-z0-9_-]{1,80}$/.test(agent) && fields && typeof fields === 'object')
          for (const field of [
            'model',
            'defaultProvider',
            'thinking',
            'tools',
            'inheritProjectContext',
            'inheritGlobalContext',
            'inheritSkills',
            'systemPromptMode',
          ])
            if (fields[field] !== undefined)
              box.append(
                settingControl(
                  item,
                  ['subagents', 'agentOverrides', agent, field],
                  fields[field],
                  `Stage ${agent}.${field}`,
                ),
              );
    }
  }
  const sourceFile = item.source?.fileId
    ? state.files.find((file) => file.id === item.source.fileId)
    : null;
  if (
    item.kind === 'command' &&
    item.commandType === 'prompt-template' &&
    sourceFile?.kind === 'command' &&
    state.env?.piVersion === '1.4.0'
  ) {
    const playground = make('form', 'guided-editor');
    playground.append(make('h3', '', 'Prompt-template playground'));
    playground.append(
      make(
        'p',
        'muted',
        'Expand with Pi 1.4.0’s parser and template substitution. This is a local preview only: it does not execute, send, or queue a prompt.',
      ),
    );
    const argsLabel = make('label', 'field');
    argsLabel.append(make('span', '', 'Arguments (quote multi-word values as in Pi)'));
    const argsInput = make('input', 'input');
    argsInput.placeholder = '"two words" third';
    argsLabel.append(argsInput);
    const result = make('pre', 'code-preview', 'Enter arguments to preview substitution.');
    const expandButton = make('button', 'button', 'Preview expansion');
    expandButton.type = 'submit';
    playground.append(argsLabel, expandButton, result);
    playground.addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        const expansion = await mutate('/api/prompts/expand', {
          resourceId: item.id,
          expectedHash: item.source.versionHash,
          arguments: argsInput.value,
          confirmed: true,
        });
        result.textContent = expansion.output;
      } catch (error) {
        result.textContent = error.message;
        notify(error.message);
      }
    });
    box.append(playground);
  }
  if (canEdit() && item.kind === 'agent' && sourceFile?.editable) {
    const container = make('div', 'editor-container');
    const button = make('button', 'button secondary', 'Open guided agent editor');
    button.type = 'button';
    button.addEventListener('click', async () => {
      try {
        const editor = await api(`/api/agent-editor?id=${encodeURIComponent(sourceFile.id)}`);
        renderAgentEditor(container, item, editor);
      } catch (error) {
        notify(error.message);
      }
    });
    box.append(button, container);
  }
  if (canEdit() && item.kind === 'skill' && sourceFile?.editable) {
    const container = make('div', 'editor-container');
    const button = make('button', 'button secondary', 'Open multi-file skill editor');
    button.type = 'button';
    button.addEventListener('click', async () => {
      try {
        await renderSkillEditor(container, item, sourceFile);
      } catch (error) {
        notify(error.message);
      }
    });
    box.append(button, container);
  }
  if (item.kind === 'extension' && sourceFile?.kind === 'extension') {
    const extensionPanel = panel(
      'Local extension source',
      'This is executable JavaScript/TypeScript. Pinotator only reads and stages it; Apply can change what Pi executes later. Review every line, syntax, trust, permissions, and reload impact yourself. No syntax check runs project code.',
    );
    if (canEdit() && sourceFile.editable) {
      const container = make('div', 'editor-container');
      const button = make('button', 'button secondary', 'Open staged extension source editor');
      button.type = 'button';
      button.addEventListener('click', async () => {
        if (
          !window.confirm(
            'Open this executable extension source for staged editing? Pinotator will not run it; applying your changes can alter future Pi behavior.',
          )
        )
          return;
        try {
          const source = await api(`/api/source?id=${encodeURIComponent(sourceFile.id)}`);
          if (source.redacted || typeof source.content !== 'string')
            throw new Error('Secret-like or unsupported extension content is metadata-only.');
          const form = make('form', 'guided-editor');
          form.dataset.stageShortcut = 'true';
          const editor = make('textarea', 'editor');
          editor.rows = 24;
          editor.value = source.content;
          editor.setAttribute('aria-label', 'Extension source code');
          form.append(editor);
          const stage = make('button', 'button', 'Review staged extension code');
          stage.type = 'submit';
          form.append(stage);
          form.addEventListener('submit', async (event) => {
            event.preventDefault();
            if (editor.value === source.content)
              return notify('No extension source changes to stage.');
            await stageProposal({
              intent: 'update',
              fileId: sourceFile.id,
              expectedHash: sourceFile.versionHash,
              content: editor.value,
            });
          });
          container.replaceChildren(form);
        } catch (error) {
          notify(error.message);
        }
      });
      extensionPanel.append(button, container);
    } else {
      const readOnlyReason = sourceFile.editable
        ? 'Extension editing is disabled in read-only mode.'
        : sourceFile.owner === 'configured-extension-path'
          ? 'Configured extension paths are view-only; their source is never modified here.'
          : sourceFile.owner === 'pi-package'
            ? 'Package-provided extension code is read-only.'
            : 'Metadata-only: the file is binary, unsupported, or contains secret-like text.';
      extensionPanel.append(make('p', 'muted', readOnlyReason));
    }
    box.append(extensionPanel);
  }
  if (
    canEdit() &&
    state.env.mode !== 'global' &&
    sourceFile?.editable &&
    ['global', 'portable'].includes(item.source?.scope) &&
    ['skill', 'agent', 'command', 'instruction'].includes(item.kind)
  ) {
    const copy = make('button', 'button secondary', 'Copy to project');
    copy.type = 'button';
    copy.addEventListener('click', async () => {
      try {
        const source = await api(`/api/source?id=${encodeURIComponent(sourceFile.id)}`);
        if (!source.content) throw new Error('Source content is not available for safe copying.');
        const kind =
          sourceFile.kind === 'skill'
            ? 'skill'
            : sourceFile.kind === 'agent'
              ? 'agent'
              : sourceFile.kind === 'command'
                ? 'command'
                : sourceFile.kind === 'system-prompt'
                  ? 'system-prompt'
                  : sourceFile.kind === 'append-system'
                    ? 'append-system'
                    : 'instruction';
        const basename =
          kind === 'skill' || kind === 'agent' || kind === 'command'
            ? item.name.replace(/\.md$/i, '')
            : kind === 'system-prompt'
              ? 'SYSTEM.md'
              : kind === 'append-system'
                ? 'APPEND_SYSTEM.md'
                : item.name;
        if (
          kind === 'skill' &&
          !confirm('This copies SKILL.md only; related assets are not included. Continue?')
        )
          return;
        stageProposal({
          intent: 'create',
          createTarget: { scope: 'project', kind, basename },
          content: source.content,
        });
      } catch (error) {
        notify(error.message);
      }
    });
    box.append(
      copy,
      make(
        'p',
        'muted',
        'Copy stages a project-local file; no source is changed and Apply remains explicit.',
      ),
    );
  }
  if (canEdit() && item.kind === 'skill') {
    const exportButton = make('button', 'button secondary', 'Export skill as ZIP');
    exportButton.type = 'button';
    exportButton.addEventListener('click', async () => {
      try {
        let result;
        try {
          result = await mutate('/api/skills/export', { resourceId: item.id, confirmed: true });
        } catch (error) {
          if (
            error.code !== 'SCRIPT_REVIEW_REQUIRED' ||
            !error.details?.scripts ||
            !confirm(
              `This skill contains executable/script-like files: ${error.details.scripts.join(', ')}. Export the files?`,
            )
          )
            throw error;
          result = await mutate('/api/skills/export', {
            resourceId: item.id,
            confirmScripts: true,
            confirmed: true,
          });
        }
        const binary = atob(result.contentBase64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
        const anchor = make('a');
        anchor.href = url;
        anchor.download = result.filename;
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        notify(`Exported ${result.files.length} files. ${result.modePolicy}`);
      } catch (error) {
        notify(error.message);
      }
    });
    box.append(
      exportButton,
      make(
        'p',
        'muted',
        'Export stays in this browser; credential-like files and symlinks are blocked.',
      ),
    );
  }
  if (canEdit() && item.kind === 'provider') {
    const check = make('button', 'button secondary', 'Check Pi authorization (no refresh)');
    check.type = 'button';
    check.addEventListener('click', async () => {
      if (
        !confirm(
          `Ask installed Pi to check credentials for ${item.name}? No credential value is returned; OAuth refresh is disabled.`,
        )
      )
        return;
      try {
        const result = await mutate('/api/runtime/auth-check', {
          provider: item.name,
          confirmed: true,
        });
        box.append(
          make(
            'p',
            'notice',
            `Pi auth check: ${result.status}${result.reason ? ` · ${result.reason}` : ''}. ${result.detail}`,
          ),
        );
      } catch (error) {
        notify(error.message);
      }
    });
    box.append(check);
  }
  if (canEdit() && item.kind === 'provider' && sourceFile?.kind === 'models') {
    const remove = make('button', 'button secondary', 'Stage provider removal');
    remove.type = 'button';
    remove.addEventListener('click', () => {
      if (confirm(`Stage removal of provider ${item.name}?`))
        stageProposal({
          intent: 'set-provider',
          fileId: sourceFile.id,
          expectedHash: sourceFile.versionHash,
          change: { operation: 'remove', providerId: item.name },
        });
    });
    box.append(remove);
  }
  if (canEdit() && item.kind === 'mcp' && sourceFile?.kind === 'mcp') {
    const policy = make('div', 'edit-field');
    policy.append(make('h3', '', 'MCP policy override'));
    const enabled = selectField(
      policy,
      'Enabled',
      [
        ['true', 'Enabled'],
        ['false', 'Disabled'],
      ],
      item.enabled === false ? 'false' : 'true',
    );
    const exposure = selectField(
      policy,
      'Exposure',
      [
        ['codemode', 'codemode'],
        ['deferred', 'deferred'],
        ['direct', 'direct'],
        ['hidden', 'hidden'],
      ],
      ['codemode', 'deferred', 'direct', 'hidden'].includes(item.exposure)
        ? item.exposure
        : 'codemode',
    );
    const toolExposure = make('textarea', 'editor');
    toolExposure.value = JSON.stringify(item.toolExposure || {}, null, 2);
    policy.append(
      make('label', 'form-field', 'Per-tool exposure JSON (names and enum values only)'),
      toolExposure,
    );
    const applyPolicy = make('button', 'button', 'Stage policy change');
    applyPolicy.type = 'button';
    applyPolicy.addEventListener('click', () => {
      try {
        stageProposal({
          intent: 'set-mcp',
          fileId: sourceFile.id,
          expectedHash: sourceFile.versionHash,
          change: {
            operation: 'policy',
            serverName: item.name,
            enabled: enabled.value === 'true',
            exposure: exposure.value,
            toolExposure: JSON.parse(toolExposure.value),
          },
        });
      } catch {
        notify('Per-tool exposure must be a JSON object.');
      }
    });
    policy.append(applyPolicy, mcpRemovalButton(item));
    box.append(policy);
  }
  if (item.diagnostics?.length) {
    const diag = panel('Resource diagnostics');
    addDiagnostics(diag, item.diagnostics);
    box.append(diag);
  }
  if (item.explanation?.length) {
    const why = panel('Why this status?');
    const ul = make('ul');
    item.explanation.forEach((line) => ul.append(make('li', '', line)));
    box.append(why);
    why.append(ul);
  }
  return box;
}
function labeledInput(parent, label, value = '', type = 'text') {
  const wrapper = make('label', 'form-field', label);
  const input = make('input', 'search');
  input.type = type;
  input.value = value == null ? '' : String(value);
  wrapper.append(input);
  parent.append(wrapper);
  return input;
}
function selectField(parent: HTMLElement, label: string, values: string[][], selected?: string) {
  const wrapper = make('label', 'form-field', label);
  const select = make('select', 'search');
  for (const [value, title] of values) {
    const option = make('option', '', title);
    option.value = value;
    select.append(option);
  }
  select.value = selected || values[0]?.[0] || '';
  wrapper.append(select);
  parent.append(wrapper);
  return select;
}
function addConfigFileForm(parent, fileKind, targetKind, fileName) {
  const scopes = [['global', 'Global Pi']];
  if (state.env.mode !== 'global') scopes.push(['project', 'Project']);
  const scope = selectField(parent, `Create ${fileName} scope`, scopes, scopes[0][0]);
  const button = make('button', 'button secondary', `Create empty ${fileName}`);
  button.type = 'button';
  button.addEventListener('click', () =>
    stageProposal({
      intent: 'create',
      createTarget: { scope: scope.value, kind: targetKind, basename: fileName },
      content:
        fileKind === 'models'
          ? '{\n  "providers": {}\n}\n'
          : fileKind === 'mcp'
            ? '{\n  "mcpServers": {}\n}\n'
            : '{}\n',
    }),
  );
  parent.append(
    button,
    make(
      'p',
      'muted',
      'The empty configuration is staged first; add entries in the guided editor after applying it.',
    ),
  );
}
function renderProviderLoading() {
  const page = make('div', 'page');
  page.append(make('h1', '', currentPath().startsWith('/models') ? 'Models' : 'Providers'));
  const loading = make('section', 'panel provider-page-loading');
  loading.setAttribute('role', providerCatalogFailure ? 'alert' : 'status');
  loading.append(
    make(
      'p',
      'muted',
      providerCatalogFailure
        ? 'Could not load the local Pi provider catalog. No credentials were changed.'
        : 'Loading local providers and models…',
    ),
  );
  const fetchCatalog = () => {
    if (providerCatalogPending) return;
    providerCatalogPending = true;
    loadModelCatalog()
      .then((catalog) => {
        providerCatalog = catalog;
        providerCatalogFailure = false;
      })
      .catch(() => {
        providerCatalogFailure = true;
      })
      .finally(() => {
        providerCatalogPending = false;
        if (/^\/(models|providers)(\/|$)/.test(currentPath())) render();
      });
  };
  if (providerCatalogFailure) {
    const retry = make('button', 'button secondary', 'Retry loading catalog');
    retry.type = 'button';
    retry.addEventListener('click', () => {
      providerCatalogFailure = false;
      render();
    });
    loading.append(retry);
  } else fetchCatalog();
  page.append(loading);
  return page;
}
function renderProviderSetup() {
  const section = panel(
    'Connect a Pi provider',
    'Choose a built-in provider that supports API keys. OAuth sign-in is intentionally not offered. The provider list comes from your installed Pi catalog, without a network refresh.',
  );
  const slot = make('div', 'form-stack');
  slot.append(make('p', 'muted', 'Loading the local Pi provider catalog…'));
  section.append(slot);
  const renderCatalog = (catalog: Awaited<ReturnType<typeof loadModelCatalog>>) => {
    slot.replaceChildren();
    if (!catalog.available) {
      slot.append(make('p', 'warning', catalog.message));
      return;
    }
    if (catalog.credentialsMessage) slot.append(make('p', 'warning', catalog.credentialsMessage));
    const providers = catalog.providers.filter((provider) => provider.apiKeySupported);
    if (!canEdit())
      slot.append(
        make(
          'p',
          'notice',
          'Read-only workspace. You can browse API-key providers, but saving credentials requires a writable Pinotator instance.',
        ),
      );
    const form = make('form', 'form-stack provider-key-form');
    const provider = selectField(form, 'API-key provider', [
      ['', 'Choose an API-key provider'],
      ...providers.map((item) => [item.id, `${item.name} · ${item.id}`]),
    ]);
    provider.required = true;
    const providerInfo = make('div', 'provider-catalog-info');
    providerInfo.hidden = true;
    const configuration = make('div', 'form-stack');
    configuration.hidden = true;
    const configInputs = new Map<string, HTMLInputElement>();
    form.append(providerInfo, configuration);
    if (!canEdit()) {
      provider.addEventListener('change', () => {
        const models = catalog.models.filter((model) => model.provider === provider.value);
        providerInfo.hidden = false;
        providerInfo.textContent = `${models.length} bundled chat models. Model availability is not verified.`;
      });
      slot.append(form);
      return;
    }
    const key = labeledInput(form, 'API key', '', 'password');
    key.required = true;
    key.minLength = 8;
    key.maxLength = 8192;
    key.autocomplete = 'new-password';
    key.spellcheck = false;
    const privacy = make('aside', 'notice');
    privacy.append(
      make('strong', '', 'Local storage. No Pinotator cloud.'),
      make(
        'p',
        '',
        'This key is sent only to this authenticated loopback server and saved in Pi’s private local auth.json (0600). Pinotator does not save it in browser storage, previews, snapshots, or transaction backups. Pi sends it to the chosen provider when you use a model.',
      ),
      make(
        'p',
        '',
        'The file is not encrypted at rest. Other processes running as your OS user can read it; local does not mean risk-free. Saving does not verify the key or make a model request.',
      ),
    );
    form.append(privacy);
    const replaceLabel = make('label', 'checkbox-field');
    const replace = make('input');
    replace.type = 'checkbox';
    replaceLabel.append(
      replace,
      make(
        'span',
        '',
        'Replace this provider’s existing stored credential. This cannot be rolled back from Changes.',
      ),
    );
    replaceLabel.hidden = true;
    const consentLabel = make('label', 'checkbox-field');
    const consent = make('input');
    consent.type = 'checkbox';
    consent.required = true;
    consentLabel.append(
      consent,
      make(
        'span',
        '',
        'Save this API key directly to Pi’s local credential store. This action is separate from staged file changes.',
      ),
    );
    form.append(replaceLabel, consentLabel);
    const submit = make('button', 'button', 'Save API key locally');
    submit.type = 'submit';
    submit.disabled = true;
    form.append(submit);
    const update = () => {
      const selected = providers.find((item) => item.id === provider.value);
      key.value = '';
      replace.checked = false;
      replaceLabel.hidden = !selected?.storedCredential;
      replace.required = Boolean(selected?.storedCredential);
      submit.disabled = !selected;
      configuration.replaceChildren();
      configInputs.clear();
      providerInfo.replaceChildren();
      providerInfo.hidden = !selected;
      configuration.hidden = !selected?.setupFields?.length;
      if (!selected) return;
      const models = catalog.models.filter((model) => model.provider === selected.id);
      providerInfo.append(
        make(
          'p',
          'muted',
          `${models.length} bundled chat models${
            models.length
              ? ` · ${models
                  .slice(0, 3)
                  .map((model) => model.name)
                  .join(', ')}${models.length > 3 ? ', …' : ''}`
              : ''
          }. Use Pi’s /model or an agent’s model picker to select one.`,
        ),
      );
      if (selected.storedCredential)
        providerInfo.append(
          make(
            'p',
            'warning',
            'A stored credential already exists for this provider. Explicitly confirm replacement below; other providers and their credentials are preserved.',
          ),
        );
      for (const field of selected.setupFields || []) {
        const input = labeledInput(configuration, field.label);
        input.placeholder = field.placeholder || '';
        configInputs.set(field.name, input);
      }
      if (configInputs.size)
        configuration.append(
          make(
            'p',
            'muted',
            'Optional provider-scoped configuration. Blank fields preserve existing local values; some providers require these settings before inference can work.',
          ),
        );
    };
    provider.addEventListener('change', update);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      submit.disabled = true;
      submit.textContent = 'Saving locally…';
      submit.setAttribute('aria-busy', 'true');
      const providerId = provider.value;
      const apiKey = key.value;
      key.value = '';
      provider.disabled = true;
      key.disabled = true;
      consent.disabled = true;
      replace.disabled = true;
      configInputs.forEach((input) => {
        input.disabled = true;
      });
      try {
        await mutate('/api/providers/api-key', {
          provider: providerId,
          apiKey,
          confirmed: consent.checked,
          replaceExisting: replace.checked,
          configuration: Object.fromEntries(
            [...configInputs].map(([name, input]) => [name, input.value.trim()]),
          ),
        });
        const selected = providers.find((item) => item.id === providerId);
        if (selected) selected.storedCredential = 'api_key';
        delete form.dataset.dirty;
        loadModelCatalog(true).catch(() => {});
        consent.checked = false;
        update();
        notify(
          'API key saved in Pi’s local credential store. No provider request was made. Reload Pi to use it.',
        );
      } catch (error) {
        notify(error.message);
      } finally {
        key.value = '';
        provider.disabled = false;
        key.disabled = false;
        consent.disabled = false;
        replace.disabled = false;
        configInputs.forEach((input) => {
          input.disabled = false;
        });
        submit.textContent = 'Save API key locally';
        submit.removeAttribute('aria-busy');
        submit.disabled = !provider.value;
      }
    });
    slot.append(form);
  };
  renderCatalog(providerCatalog);
  return section;
}
function renderProviderEditor(file) {
  const section = panel(
    `Custom provider · ${file.scope}`,
    'No raw API key, header, OAuth secret, or command resolver can be entered here. Configure credentials through Pi auth or environment references.',
  );
  const providerId = labeledInput(
    section,
    'Provider ID (lowercase letters, numbers, underscore, hyphen)',
    '',
    'text',
  );
  const name = labeledInput(section, 'Display name');
  const baseUrl = labeledInput(section, 'HTTPS base URL (loopback HTTP is allowed)');
  const apiType = selectField(
    section,
    'Pi API type',
    [
      ['openai-completions', 'OpenAI Chat Completions'],
      ['openai-responses', 'OpenAI Responses'],
      ['anthropic-messages', 'Anthropic Messages'],
      ['google-generative-ai', 'Google Generative AI'],
    ],
    'openai-completions',
  );
  const modelId = labeledInput(section, 'Model ID');
  const modelName = labeledInput(section, 'Model display name');
  const reasoning = make('input');
  reasoning.type = 'checkbox';
  const reasoningLabel = make('label', 'form-field', 'Supports reasoning');
  reasoningLabel.append(reasoning);
  section.append(reasoningLabel);
  const inputKinds = selectField(section, 'Input modality', [
    ['text', 'Text'],
    ['text,image', 'Text and image'],
  ]);
  const contextWindow = labeledInput(section, 'Context window (optional)', '', 'number');
  const maxTokens = labeledInput(section, 'Maximum output tokens (optional)', '', 'number');
  const costInputs = Object.fromEntries(
    ['input', 'output', 'cacheRead', 'cacheWrite'].map((field) => [
      field,
      labeledInput(section, `Cost ${field} (USD per million tokens; optional)`, '', 'number'),
    ]),
  );
  const submit = make('button', 'button', 'Stage provider and model');
  submit.type = 'button';
  submit.addEventListener('click', () => {
    const model: ProviderModel = {
      id: modelId.value.trim(),
      name: modelName.value.trim(),
      reasoning: reasoning.checked,
      input: inputKinds.value.split(','),
    };
    if (contextWindow.value) model.contextWindow = Number(contextWindow.value);
    if (maxTokens.value) model.maxTokens = Number(maxTokens.value);
    const costs = Object.values(costInputs).map((input) => input.value);
    if (costs.some(Boolean)) {
      if (!costs.every(Boolean)) {
        notify('Enter all four cost fields or leave all blank.');
        return;
      }
      model.cost = Object.fromEntries(
        Object.entries(costInputs).map(([field, input]) => [field, Number(input.value)]),
      );
    }
    stageProposal({
      intent: 'set-provider',
      fileId: file.id,
      expectedHash: file.versionHash,
      change: {
        operation: 'upsert',
        providerId: providerId.value.trim(),
        name: name.value.trim(),
        baseUrl: baseUrl.value.trim(),
        api: apiType.value,
        model,
      },
    });
  });
  section.append(submit);
  return section;
}
function renderMcpEditor(file) {
  const section = panel(
    `MCP configuration · ${file.scope}`,
    'Stdio commands may run when Pi starts. Pinotator does not connect during inventory. Credentials must come from Pi auth or environment variable names.',
  );
  const serverName = labeledInput(section, 'Server name');
  const transport = selectField(section, 'Transport', [
    ['stdio', 'Local stdio process'],
    ['http', 'Streamable HTTP'],
  ]);
  const command = labeledInput(section, 'Executable (stdio; not a shell command)');
  const args = make('textarea', 'editor');
  args.placeholder = 'One argument per line';
  args.setAttribute('aria-label', 'MCP command arguments');
  section.append(make('label', 'form-field', 'Arguments (one per line)'), args);
  const envNames = labeledInput(section, 'Environment variable names only (comma-separated)');
  const url = labeledInput(section, 'HTTPS URL (loopback HTTP is allowed)');
  const description = labeledInput(section, 'Description');
  const timeout = labeledInput(section, 'Timeout seconds (optional)', '', 'number');
  const toolExposure = make('textarea', 'editor');
  toolExposure.placeholder = '{ "tool-name": "deferred" }';
  section.append(make('label', 'form-field', 'Per-tool exposure JSON (optional)'), toolExposure);
  const exposure = selectField(
    section,
    'Tool exposure',
    [
      ['codemode', 'codemode'],
      ['deferred', 'deferred'],
      ['direct', 'direct'],
      ['hidden', 'hidden'],
    ],
    'codemode',
  );
  const enabled = make('input');
  enabled.type = 'checkbox';
  enabled.checked = true;
  const enabledLabel = make('label', 'form-field', 'Enabled');
  enabledLabel.append(enabled);
  section.append(enabledLabel);
  const submit = make('button', 'button', 'Stage MCP server');
  submit.type = 'button';
  submit.addEventListener('click', () => {
    const useHttp = transport.value === 'http';
    const change: McpChange = {
      operation: 'upsert',
      serverName: serverName.value.trim(),
      transport: transport.value,
      enabled: enabled.checked,
      exposure: exposure.value,
      description: description.value,
    };
    if (timeout.value) change.timeout = Number(timeout.value);
    if (toolExposure.value.trim()) {
      try {
        change.toolExposure = JSON.parse(toolExposure.value);
      } catch {
        notify('Per-tool exposure must be a JSON object.');
        return;
      }
    }
    if (useHttp) change.url = url.value.trim();
    else {
      change.command = command.value.trim();
      change.args = args.value.split(/\r?\n/).filter(Boolean);
      change.envNames = envNames.value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
    }
    stageProposal({ intent: 'set-mcp', fileId: file.id, expectedHash: file.versionHash, change });
  });
  section.append(submit);
  return section;
}
function renderKeybindingEditor(file) {
  const section = panel(
    `Keybindings · ${file.scope}`,
    'Action names are accepted as strings; built-in and extension registrations are not fully enumerable. Pi key syntax is validated against the installed reference.',
  );
  const action = labeledInput(section, 'Pi action ID');
  const bindings = labeledInput(section, 'Key bindings (comma-separated; blank disables)');
  const submit = make('button', 'button', 'Stage keybinding');
  submit.type = 'button';
  submit.addEventListener('click', () =>
    stageProposal({
      intent: 'set-keybinding',
      fileId: file.id,
      expectedHash: file.versionHash,
      change: {
        action: action.value.trim(),
        bindings: bindings.value
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean),
      },
    }),
  );
  const reset = make('button', 'button secondary', 'Reset this action to Pi default');
  reset.type = 'button';
  reset.addEventListener('click', () =>
    stageProposal({
      intent: 'set-keybinding',
      fileId: file.id,
      expectedHash: file.versionHash,
      change: { action: action.value.trim(), reset: true },
    }),
  );
  section.append(submit, reset);
  return section;
}
function renderResourceList(root, kind, id) {
  const resources = state.resources.filter((item) => item.kind === kind);
  const selected = id ? resources.find((item) => item.id === id) : null;
  const page = make('div', 'page');
  page.append(make('h1', '', sections.find(([path]) => path === root)?.[1] || root.slice(1)));
  if (canEdit() && ['agent', 'skill', 'command'].includes(kind)) {
    const creating = new URLSearchParams(location.search).get('create') === kind;
    const actions = make('div', 'page-actions');
    actions.append(
      link(
        creating ? root : `${root}?create=${kind}`,
        creating ? 'Cancel creation' : `Create ${kind}`,
        creating ? 'button secondary' : 'button',
      ),
    );
    page.append(actions);
    if (creating) page.append(renderCreateForm(kind));
  }
  if (kind === 'model' || kind === 'provider') page.append(renderProviderSetup());
  const bar = make('div', 'toolbar');
  const search = make('input', 'search');
  search.type = 'search';
  search.placeholder = 'Filter by name, source, or status';
  search.setAttribute('aria-label', `Filter ${kind} resources`);
  const scopeFilter = make('select', 'search');
  scopeFilter.setAttribute('aria-label', `Filter ${kind} by scope`);
  for (const [value, label] of [
    ['', 'All scopes'],
    ...[...new Set(resources.map((item) => item.scope || 'unknown'))]
      .sort()
      .map((scope) => [scope, scope]),
  ]) {
    const option = make('option', '', label);
    option.value = value;
    scopeFilter.append(option);
  }
  search.value = listFilters.get(root)?.query || '';
  scopeFilter.value = listFilters.get(root)?.scope || '';
  const count = make('span', 'muted', `${resources.length} found`);
  count.setAttribute('role', 'status');
  bar.append(search, scopeFilter, count);
  page.append(bar);
  const layout = make('div', 'content-grid');
  const listPanel = panel(
    `${resources.length} ${kind} resources`,
    'Every row shows its source and status; Unknown means runtime activation was not verified.',
  );
  const table = renderTable(resources, root);
  listPanel.append(table);
  layout.append(listPanel);
  if (selected) {
    const inspector = make('section', 'panel inspector-panel');
    inspector.append(
      link(root, '← Back to list', 'text-link inspector-back'),
      renderResourceDetail(selected),
    );
    layout.append(inspector);
  }
  page.append(layout);
  if (kind === 'model') {
    const runtimePanel = panel(
      state.effectiveRuntime
        ? `Installed Pi core catalog · ${state.effectiveRuntime.models.length}`
        : 'Installed Pi model catalog',
      'This catalog is loaded only by explicit version-gated inspection. No catalog refresh occurs. Per-model inference tests are separate, explicitly confirmed actions on Effective Pi State.',
    );
    if (state.effectiveRuntime) {
      const catalog = state.effectiveRuntime.models.slice(0, 100);
      const filters = make('div', 'toolbar');
      const catalogSearch = make('input', 'search');
      catalogSearch.type = 'search';
      catalogSearch.placeholder = 'Search provider, model, endpoint';
      catalogSearch.setAttribute('aria-label', 'Search installed Pi models');
      const credentialFilter = selectField(filters, 'Credentials', [
        ['all', 'All states'],
        ['configured', 'Configured'],
        ['missing', 'Not configured'],
      ]);
      const reasoningLabel = make('label', 'form-field', 'Reasoning only');
      const reasoningFilter = make('input');
      reasoningFilter.type = 'checkbox';
      reasoningLabel.append(reasoningFilter);
      filters.prepend(catalogSearch, reasoningLabel);
      runtimePanel.append(filters);
      const catalogList = make('div', 'analysis-groups');
      const renderCatalog = () => {
        catalogList.replaceChildren();
        const query = catalogSearch.value.trim().toLowerCase();
        const visible = catalog.filter((model) => {
          const text =
            `${model.ref} ${model.name} ${model.endpointOrigin || ''} ${model.credentials.source}`.toLowerCase();
          if (query && !text.includes(query)) return false;
          if (credentialFilter.value === 'configured' && !model.credentials.configured)
            return false;
          if (credentialFilter.value === 'missing' && model.credentials.configured) return false;
          return !reasoningFilter.checked || model.reasoning === true;
        });
        const groups = new Map();
        for (const model of visible) {
          const provider = model.ref.split('/')[0];
          if (!groups.has(provider)) groups.set(provider, []);
          groups.get(provider).push(model);
        }
        for (const [provider, models] of groups) {
          const group = make('section', 'analysis-group');
          group.append(make('h3', '', `${provider} · ${models.length} models`));
          for (const model of models) {
            const row = make('article', 'instruction-source');
            row.append(make('strong', '', `${model.ref} · ${model.name}`));
            row.append(
              make(
                'span',
                'muted',
                `credentials ${model.credentials.configured ? 'configured' : 'not configured'} (${model.credentials.source}) · reasoning ${model.reasoning} · input ${model.input.join(', ') || 'unknown'}`,
              ),
            );
            row.append(
              make(
                'span',
                'muted',
                `endpoint ${model.endpointOrigin || 'provider-managed / unknown'} · context ${model.contextWindow ?? 'unknown'} · max output ${model.maxTokens ?? 'unknown'}`,
              ),
            );
            if (model.cost)
              row.append(
                make(
                  'span',
                  'muted',
                  `USD/1M input ${model.cost.input ?? 'unknown'} · output ${model.cost.output ?? 'unknown'}`,
                ),
              );
            group.append(row);
          }
          catalogList.append(group);
        }
        if (!visible.length)
          catalogList.append(make('p', 'muted', 'No installed Pi models match these filters.'));
      };
      catalogSearch.addEventListener('input', renderCatalog);
      credentialFilter.addEventListener('change', renderCatalog);
      reasoningFilter.addEventListener('change', renderCatalog);
      renderCatalog();
      runtimePanel.append(catalogList);
      if (state.effectiveRuntime.models.length > 100)
        runtimePanel.append(
          make(
            'p',
            'muted',
            `Showing the first 100 of ${state.effectiveRuntime.models.length} catalog entries.`,
          ),
        );
    } else {
      runtimePanel.append(
        make(
          'p',
          'muted',
          'Runtime-added providers and models remain unknown until you inspect the supported Pi core catalog.',
        ),
      );
    }
    const inspectLink = link('/effective', 'Open Effective Pi State');
    inspectLink.className = 'button secondary';
    runtimePanel.append(inspectLink);
    page.append(runtimePanel);
  }
  if (canEdit() && kind === 'skill') {
    const transfer = panel(
      'Import a skill ZIP',
      'Imports are inspected locally, symlinks/special files and credential-like content are rejected, executable bits are cleared, and every file is staged for review.',
    );
    const upload = make('input');
    upload.type = 'file';
    upload.accept = '.zip,application/zip';
    upload.setAttribute('aria-label', 'Choose skill ZIP archive');
    transfer.append(upload);
    const scopes = [
      ['global', 'Global Pi skills'],
      ['project', 'Project .pi/skills'],
      ['portable', 'Portable user skills'],
      ['portable-project', 'Portable project skills'],
    ];
    const scope = selectField(
      transfer,
      'Import destination',
      state.env.mode === 'global'
        ? scopes.filter(([value]) => ['global', 'portable'].includes(value))
        : scopes,
      state.env.mode === 'global' ? 'global' : 'project',
    );
    const review = make('div', '');
    transfer.append(review);
    upload.addEventListener('change', async () => {
      review.replaceChildren();
      const file = upload.files?.[0];
      if (!file) return;
      if (file.size > 5 * 1024 * 1024) {
        notify('ZIP must be 5 MiB or smaller.');
        return;
      }
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        let binary = '';
        for (let i = 0; i < bytes.length; i += 0x8000)
          binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        const inspected = await mutate('/api/skills/import/inspect', {
          archiveBase64: btoa(binary),
          filename: file.name,
          confirmed: true,
        });
        review.append(
          make('h3', '', `Skill: ${inspected.name}`),
          make(
            'p',
            'muted',
            `${inspected.files.length} files · expires in ${inspected.expiresInSeconds} seconds. ${inspected.modePolicy}`,
          ),
        );
        const fileList = make('ul', 'diagnostic-list');
        for (const entry of inspected.files)
          fileList.append(
            make(
              'li',
              '',
              `${entry.path} · ${entry.size} bytes${entry.scriptLike ? ' · script-like' : ''}`,
            ),
          );
        review.append(fileList);
        const confirmScripts = make('input');
        confirmScripts.type = 'checkbox';
        const consent = make(
          'label',
          'form-field',
          'I reviewed script-like files; they will be imported non-executable and never run by Pinotator.',
        );
        consent.append(confirmScripts);
        review.append(consent);
        const stage = make('button', 'button', 'Stage imported skill files');
        stage.type = 'button';
        stage.addEventListener('click', async () => {
          try {
            const result = await mutate('/api/skills/import/propose', {
              importId: inspected.importId,
              scope: scope.value,
              confirmScripts: confirmScripts.checked,
              confirmed: true,
            });
            await staged(`Staged ${result.fileCount} files. Apply them from Changes.`);
          } catch (error) {
            notify(error.message);
          }
        });
        review.append(stage);
      } catch (error) {
        notify(error.message);
      }
    });
    page.append(transfer);
  }
  if (canEdit() && kind === 'setting') {
    if (state.env.mode !== 'global') {
      const copyPanel = panel(
        'Clone Global → Project',
        'Select user-owned resources to copy into this project. Skills include all inventoried text companions; new copies are non-executable. Settings can be copied separately through a sanitized profile.',
      );
      const targetScope = selectField(
        copyPanel,
        'Project destination',
        [
          ['project', 'Pi project (.pi)'],
          ['portable-project', 'Portable Agent Skills (.agents/skills)'],
        ],
        'project',
      );
      const copyList = make('div', 'profile-list');
      const candidates = state.resources.filter((resource) => {
        const file =
          resource.source?.fileId &&
          state.files.find((candidate) => candidate.id === resource.source.fileId);
        return (
          ['global', 'portable'].includes(resource.source?.scope) &&
          file?.editable &&
          !file.packageName &&
          (resource.kind === 'skill' ||
            resource.kind === 'agent' ||
            (resource.kind === 'command' && resource.commandType === 'prompt-template') ||
            resource.kind === 'instruction')
        );
      });
      const selectors = [];
      for (const resource of candidates) {
        const row = make('label', 'profile-row');
        const checkbox = make('input');
        checkbox.type = 'checkbox';
        row.append(
          checkbox,
          make(
            'span',
            '',
            `${resource.name} · ${resource.kind} · ${resource.source.scope} · ${resource.source.displayPath}`,
          ),
        );
        copyList.append(row);
        selectors.push({ resource, checkbox });
      }
      if (!candidates.length)
        copyList.append(make('p', 'muted', 'No safe global user resources are available to copy.'));
      const cloneButton = make('button', 'button', 'Review selected copies');
      cloneButton.type = 'button';
      cloneButton.disabled = candidates.length === 0;
      cloneButton.addEventListener('click', async () => {
        const selected = selectors
          .filter(({ checkbox }) => checkbox.checked)
          .map(({ resource }) => resource.id);
        if (!selected.length) return notify('Select at least one resource to copy.');
        try {
          const proposal = await mutate('/api/workspaces/clone-global', {
            resourceIds: selected,
            targetScope: targetScope.value,
            confirmed: true,
          });
          await staged(`Staged ${proposal.edits.length} file copies. Review before Apply.`);
        } catch (error) {
          notify(error.message);
        }
      });
      copyPanel.append(copyList, cloneButton);
      page.append(copyPanel);
    }
    const settingsFiles = state.files.filter(
      (file) => file.kind === 'settings' && ['global', 'project'].includes(file.scope),
    );
    if (settingsFiles.length) {
      const presets = panel(
        'Settings presets',
        'Presets contain only supported non-secret settings. Import stages one targeted JSONC changeset against the selected file; it never applies automatically.',
      );
      const choices = settingsFiles.map((file) => [file.id, `${file.scope} · ${file.displayPath}`]);
      const target = selectField(presets, 'Target settings file', choices, choices[0][0]);
      const presetName = labeledInput(presets, 'Preset name', 'Pi settings preset');
      const exportButton = make('button', 'button secondary', 'Export supported settings preset');
      exportButton.type = 'button';
      exportButton.addEventListener('click', async () => {
        try {
          const preset = await mutate('/api/presets/export', {
            fileId: target.value,
            name: presetName.value.trim(),
            confirmed: true,
          });
          const url = URL.createObjectURL(
            new Blob([JSON.stringify(preset, null, 2)], { type: 'application/json' }),
          );
          const anchor = make('a');
          anchor.href = url;
          anchor.download = 'pinotator-settings-preset.json';
          anchor.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        } catch (error) {
          notify(error.message);
        }
      });
      const upload = make('input');
      upload.type = 'file';
      upload.accept = '.json,application/json';
      upload.setAttribute('aria-label', 'Choose settings preset JSON');
      const stageButton = make('button', 'button', 'Inspect and stage preset');
      stageButton.type = 'button';
      stageButton.addEventListener('click', async () => {
        const file = upload.files?.[0];
        if (!file) return notify('Choose a preset JSON file first.');
        if (file.size > 1024 * 1024) return notify('Preset exceeds 1 MiB.');
        try {
          const bytes = new Uint8Array(await file.arrayBuffer());
          let binary = '';
          for (let i = 0; i < bytes.length; i += 0x8000)
            binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
          const source = settingsFiles.find((item) => item.id === target.value);
          const proposal = await mutate('/api/presets/stage', {
            fileId: source.id,
            expectedHash: source.versionHash,
            filename: file.name,
            presetBase64: btoa(binary),
            confirmed: true,
          });
          await staged(
            `Preset staged with ${proposal.edits.length} targeted change. Review in Changes.`,
          );
        } catch (error) {
          notify(error.message);
        }
      });
      presets.append(exportButton, upload, stageButton);
      const profilePanel = panel(
        'Private local profiles',
        'Profiles save only the supported, non-secret settings from the selected file in Pinotator’s private user-state directory. No paths, credentials, or project resources are stored.',
      );
      const saveProfile = make('button', 'button secondary', 'Save selected settings as profile');
      saveProfile.type = 'button';
      saveProfile.addEventListener('click', async () => {
        const source = settingsFiles.find((file) => file.id === target.value);
        if (
          !source ||
          !confirm('Save supported settings from this file to private local profile storage?')
        )
          return;
        try {
          await mutate('/api/profiles/save', {
            fileId: source.id,
            name: presetName.value.trim(),
            confirmed: true,
          });
          notify('Profile saved locally.');
          await renderProfiles();
        } catch (error) {
          notify(error.message);
        }
      });
      const profileList = make('div', 'profile-list');
      const renderProfiles = async () => {
        try {
          const saved = await api('/api/profiles');
          profileList.replaceChildren();
          if (!saved.length) profileList.append(make('p', 'muted', 'No local profiles saved yet.'));
          for (const profile of saved) {
            const row = make('div', 'profile-row');
            row.append(make('span', '', `${profile.name} · ${profile.settingCount} settings`));
            const applyProfile = make('button', 'button compact', 'Stage in selected scope');
            applyProfile.type = 'button';
            applyProfile.addEventListener('click', async () => {
              try {
                const source = settingsFiles.find((file) => file.id === target.value);
                const proposal = await mutate('/api/profiles/stage', {
                  profileId: profile.id,
                  fileId: source.id,
                  expectedHash: source.versionHash,
                  confirmed: true,
                });
                await staged(`Profile staged with ${proposal.edits.length} targeted changes.`);
              } catch (error) {
                notify(error.message);
              }
            });
            const removeProfile = make('button', 'button compact secondary', 'Delete');
            removeProfile.type = 'button';
            removeProfile.addEventListener('click', async () => {
              if (!confirm(`Delete local profile “${profile.name}”?`)) return;
              try {
                await mutate('/api/profiles/delete', { profileId: profile.id, confirmed: true });
                await renderProfiles();
              } catch (error) {
                notify(error.message);
              }
            });
            row.append(applyProfile, removeProfile);
            profileList.append(row);
          }
        } catch (error) {
          profileList.replaceChildren(make('p', 'warning', error.message));
        }
      };
      profilePanel.append(saveProfile, profileList);
      page.append(profilePanel);
      renderProfiles();
      page.append(presets);
    }
  }
  if (canEdit() && kind === 'provider') {
    const files = state.files.filter(
      (file) => file.kind === 'models' && ['global', 'project'].includes(file.scope),
    );
    for (const file of files) page.append(renderProviderEditor(file));
    if (!files.length) {
      const create = panel(
        'Create models.json',
        'A custom provider requires a models.json source.',
      );
      addConfigFileForm(create, 'models', 'models-config', 'models.json');
      page.append(create);
    }
  }
  if (canEdit() && kind === 'mcp') {
    const files = state.files.filter(
      (file) => file.kind === 'mcp' && ['global', 'project'].includes(file.scope),
    );
    for (const file of files) page.append(renderMcpEditor(file));
    if (!files.length) {
      const create = panel('Create mcp.json', 'Passive inspection never starts MCP servers.');
      addConfigFileForm(create, 'mcp', 'mcp-config', 'mcp.json');
      page.append(create);
    }
    const check = make('button', 'button secondary', 'Run Pi MCP status check (may start servers)');
    check.type = 'button';
    check.addEventListener('click', async () => {
      if (!confirm('Pi will connect to or start every enabled MCP server. Continue?')) return;
      try {
        const result = await mutate('/api/runtime/mcp-check', { confirmed: true });
        const details = panel('Explicit MCP check result', result.detail);
        for (const server of result.servers || [])
          details.append(
            make(
              'p',
              'muted',
              `${server.name}: ${server.state} · ${server.tools.length} tools${server.error ? ` · ${server.error}` : ''}`,
            ),
          );
        if (!result.servers)
          details.append(
            make('p', 'muted', `${result.status} (exit ${result.exitCode ?? 'unknown'})`),
          );
        page.append(details);
      } catch (error) {
        notify(error.message);
      }
    });
    page.append(
      check,
      make(
        'p',
        'muted',
        'Runtime health is opt-in and may launch untrusted server programs; it is never part of Refresh.',
      ),
    );
  }
  const empty = make('p', 'empty-state', `No ${kind} candidates match the current filters.`);
  listPanel.append(empty);
  const filterRows = () => {
    listFilters.set(root, { query: search.value, scope: scopeFilter.value });
    const q = search.value.trim().toLowerCase();
    let visible = 0;
    for (const row of table.querySelectorAll<HTMLTableRowElement>('tbody tr')) {
      const matches =
        (!q || row.textContent.toLowerCase().includes(q)) &&
        (!scopeFilter.value || row.cells[2]?.textContent.trim() === scopeFilter.value);
      row.hidden = !matches;
      if (matches) visible++;
    }
    count.textContent = `${visible} found`;
    empty.hidden = visible > 0;
    table.hidden = visible === 0;
    const wrapper = table.closest<HTMLElement>('.table-scroll');
    if (wrapper) wrapper.hidden = table.hidden;
  };
  search.addEventListener('input', filterRows);
  scopeFilter.addEventListener('change', filterRows);
  filterRows();
  return page;
}
function renderInstructions() {
  const page = make('div', 'page');
  page.append(
    make('h1', '', 'Instructions'),
    make(
      'p',
      'lead',
      'Context files, replacement system prompts, and appended instructions are separate configuration concepts.',
    ),
  );
  if (canEdit()) {
    const create = make('button', 'button secondary', 'Create instruction source');
    create.type = 'button';
    create.addEventListener('click', () => {
      const form = renderCreateForm('instruction');
      page.insertBefore(form, page.children[3] || null);
    });
    page.append(create);
  }
  const warning = make('aside', 'warning');
  warning.append(
    make('strong', '', state.instructions.label),
    make(
      'p',
      '',
      'This view does not claim byte-for-byte parity with a running Pi session. Project prompt files may be trust-gated, and extension contributions are not loaded.',
    ),
  );
  page.append(warning);
  const contextPanel = panel(
    'Context instructions',
    'Applicable source candidates are ordered by directory. Ambiguous same-directory candidates are not guessed.',
  );
  for (const group of state.instructions.contextGroups) {
    const row = make('div', 'instruction-row');
    row.append(make('strong', '', group.directory));
    for (const candidate of group.candidates) {
      const item = state.files.find((f) => f.id === candidate.fileId);
      const cell = make('div', 'instruction-source');
      cell.append(
        make('span', '', candidate.name),
        badge(
          group.selectedFileIds.includes(candidate.fileId)
            ? 'Selected in approximation'
            : group.ambiguity
              ? 'Ambiguous'
              : 'Candidate',
        ),
      );
      const open = sourceLink({ fileId: candidate.fileId });
      if (open) cell.append(open);
      row.append(cell);
    }
    contextPanel.append(row);
  }
  const preview = make('pre', 'code-preview');
  preview.textContent =
    state.instructions.contextPreview || 'No context instruction sources found.';
  contextPanel.append(preview);
  page.append(contextPanel);
  for (const [label, candidates] of [
    ['System prompt replacement (SYSTEM.md)', state.instructions.systemPromptCandidates],
    ['Appended instructions (APPEND_SYSTEM.md)', state.instructions.appendedPromptCandidates],
  ] as const) {
    const section = panel(
      label,
      'Project source precedence depends on trust and Pi version; candidates remain explicit.',
    );
    if (!candidates.length) section.append(make('p', 'muted', 'No source found.'));
    for (const candidate of candidates) {
      const row = make('div', 'instruction-source');
      row.append(
        make('span', '', candidate.displayPath),
        badge(`Trust ${candidate.conditionalTrust}`),
      );
      const open = sourceLink(candidate);
      if (open) row.append(open);
      section.append(row);
    }
    page.append(section);
  }
  return page;
}
function renderSnapshots() {
  const page = make('div', 'page');
  page.append(
    make('h1', '', 'Snapshots & Compare'),
    make(
      'p',
      'lead',
      'Store sanitized configuration inventories locally, compare across branches/workspaces, and export/import shareable metadata bundles. No configuration is applied from a snapshot.',
    ),
  );
  const global = new Map(),
    project = new Map();
  for (const resource of state.resources) {
    const scope = resource.source?.scope || resource.scope;
    if (!['global', 'project'].includes(scope)) continue;
    (scope === 'global' ? global : project).set(`${resource.kind}\0${resource.name}`, resource);
  }
  const scopePanel = panel(
    'Global vs project',
    'Static source comparison. Effective runtime precedence remains unknown where Pi trust or extension behavior applies.',
  );
  const keys = new Set([...global.keys(), ...project.keys()]);
  for (const key of [...keys].sort()) {
    const left = global.get(key),
      right = project.get(key);
    if (!left && !right) continue;
    const row = make('div', 'instruction-source');
    const item = left || right;
    row.append(
      make('strong', '', `${item.kind}: ${item.name}`),
      badge(left ? `global ${left.state}` : 'global —'),
      badge(right ? `project ${right.state}` : 'project —'),
    );
    const lvalue = left?.details?.value,
      rvalue = right?.details?.value;
    if (left && right)
      row.append(
        make(
          'span',
          'muted',
          JSON.stringify(lvalue) === JSON.stringify(rvalue)
            ? 'same visible value'
            : `different or partially unknown · global ${fmt(lvalue)} / project ${fmt(rvalue)}`,
        ),
      );
    else row.append(make('span', 'muted', 'present in one scope only'));
    scopePanel.append(row);
  }
  if (!keys.size)
    scopePanel.append(make('p', 'muted', 'No global/project resources are currently comparable.'));
  page.append(scopePanel);
  if (canEdit()) {
    const controls = panel(
      'Capture local snapshot',
      'Only sanitized resource metadata, settings values, provenance, and source hashes are stored. Raw files and credentials are excluded.',
    );
    const label = labeledInput(
      controls,
      'Snapshot label',
      state.env.projectRoot || state.env.workingDirectory,
    );
    const create = make('button', 'button', 'Save snapshot');
    create.type = 'button';
    create.addEventListener('click', async () => {
      try {
        const result = await mutate('/api/snapshots/create', {
          label: label.value.trim(),
          confirmed: true,
        });
        await load();
        notify(`Saved ${result.resourceCount} sanitized resources locally.`);
      } catch (error) {
        notify(error.message);
      }
    });
    controls.append(create);
    const upload = make('input');
    upload.type = 'file';
    upload.accept = '.json,application/json';
    upload.setAttribute('aria-label', 'Import sanitized snapshot JSON');
    const importButton = make('button', 'button secondary', 'Import sanitized snapshot bundle');
    importButton.type = 'button';
    importButton.addEventListener('click', async () => {
      const file = upload.files?.[0];
      if (!file) return notify('Choose a snapshot JSON file first.');
      if (file.size > 6 * 1024 * 1024) return notify('Snapshot bundle exceeds 6 MiB.');
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        let binary = '';
        for (let i = 0; i < bytes.length; i += 0x8000)
          binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        const result = await mutate('/api/snapshots/import', {
          filename: file.name,
          bundleBase64: btoa(binary),
          confirmed: true,
        });
        await load();
        notify(`Imported read-only snapshot ${result.label}.`);
      } catch (error) {
        notify(error.message);
      }
    });
    controls.append(upload, importButton);
    page.append(controls);
  }
  const list = panel(
    'Saved snapshots',
    'Snapshots are local private files; exported bundles contain no absolute local paths and cannot be applied.',
  );
  for (const snapshot of state.snapshots) {
    const row = make('div', 'instruction-source');
    row.append(
      make('strong', '', snapshot.label),
      badge(snapshot.branch || 'branch unknown'),
      make(
        'span',
        'muted',
        `${snapshot.createdAt} · ${snapshot.resourceCount} resources · ${snapshot.workingDirectory}`,
      ),
    );
    const compare = make('button', 'button secondary compact', 'Compare with current workspace');
    compare.type = 'button';
    compare.addEventListener('click', async () => {
      try {
        const result = await mutate('/api/snapshots/compare', {
          snapshotId: snapshot.id,
          confirmed: true,
        });
        const details = panel(
          `Comparison · ${result.changes.length} changes`,
          `${result.snapshot.branch || 'branch unknown'} → ${result.current.branch || 'branch unknown'}`,
        );
        for (const change of result.changes) {
          const item = change.resource || change.after || change.before;
          details.append(
            make(
              'p',
              'muted',
              `${change.kind}: ${item.kind} ${item.name} (${item.scope || item.source?.scope || 'unknown scope'})`,
            ),
          );
        }
        if (!result.changes.length) details.append(make('p', 'muted', 'No inventory differences.'));
        page.append(details);
        details.scrollIntoView({ block: 'nearest' });
      } catch (error) {
        notify(error.message);
      }
    });
    const exportButton = make('button', 'button secondary compact', 'Export sanitized bundle');
    exportButton.type = 'button';
    exportButton.addEventListener('click', async () => {
      try {
        const bundle = await api(`/api/snapshot/export?id=${encodeURIComponent(snapshot.id)}`);
        const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const anchor = make('a');
        anchor.href = url;
        anchor.download = `pinotator-${snapshot.id}.json`;
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch (error) {
        notify(error.message);
      }
    });
    row.append(compare, exportButton);
    list.append(row);
  }
  if (!state.snapshots.length) list.append(make('p', 'muted', 'No snapshots saved yet.'));
  page.append(list);
  return page;
}
function renderSources(id?: string) {
  const page = make('div', 'page');
  page.append(
    make('h1', '', 'Files & Sources'),
    make(
      'p',
      'lead',
      'Bounded inventory of known Pi configuration and resource files. No arbitrary path browsing.',
    ),
  );
  const selected = id ? state.files.find((file) => file.id === id) : null;
  if (selected) {
    const sourcePanel = panel(
      selected.displayPath,
      `${selected.scope} · ${selected.kind} · sha256 ${selected.versionHash}`,
    );
    sourcePanel.append(
      make('p', 'muted', 'Source content is displayed as text. Files are not executed.'),
    );
    api(`/api/source?id=${encodeURIComponent(selected.id)}`)
      .then((source) => {
        const code = make('pre', 'code-preview');
        code.textContent = source.content ?? source.reason ?? 'Source content is unavailable.';
        sourcePanel.append(code);
        if (source.truncated)
          sourcePanel.append(make('p', 'muted', 'Content truncated at the configured size limit.'));
        if (
          canEdit() &&
          source.editable &&
          typeof source.content === 'string' &&
          !source.truncated
        ) {
          if (source.redacted || source.content.includes('[REDACTED]')) {
            sourcePanel.append(
              make(
                'p',
                'warning',
                'This preview contains redacted content. Editing is disabled to avoid overwriting secrets with redaction markers.',
              ),
            );
            return;
          }
          const actions = make('div', 'toolbar source-actions');
          const edit = make(
            'button',
            'button secondary',
            selected.kind === 'skill'
              ? 'Edit skill'
              : selected.kind === 'skill-asset'
                ? 'Edit skill file'
                : 'Edit source',
          );
          edit.type = 'button';
          const editorHost = make('div', 'source-editor-host');
          edit.addEventListener('click', () => {
            const editor = make('form', 'form-stack source-editor');
            editor.dataset.stageShortcut = 'true';
            editor.append(
              make(
                'p',
                'muted',
                'Edit this draft, then review its diff. Nothing is written until Apply.',
              ),
            );
            const area = labeledTextarea(
              editor,
              selected.kind === 'skill' ? 'Skill source (Markdown)' : 'Source content',
              source.content,
              16,
            );
            area.classList.add('editor');
            const editorActions = make('div', 'toolbar');
            const save = make('button', 'button', 'Preview staged diff');
            save.type = 'submit';
            const cancel = make('button', 'button secondary', 'Cancel editing');
            cancel.type = 'button';
            cancel.addEventListener('click', () => {
              editorHost.replaceChildren();
              code.hidden = false;
              edit.hidden = false;
              edit.focus({ preventScroll: true });
            });
            editorActions.append(save, cancel);
            editor.append(editorActions);
            editor.addEventListener('submit', async (event) => {
              event.preventDefault();
              save.disabled = true;
              try {
                await mutate('/api/changes/propose', {
                  edits: [
                    {
                      intent: 'update',
                      fileId: source.id,
                      expectedHash: source.versionHash,
                      content: area.value,
                    },
                  ],
                });
                await staged();
              } catch (error) {
                notify(error.message);
              } finally {
                save.disabled = false;
              }
            });
            code.hidden = true;
            edit.hidden = true;
            editorHost.replaceChildren(editor);
            area.focus({ preventScroll: true });
          });
          const remove = make('button', 'button secondary', 'Stage deletion');
          remove.type = 'button';
          remove.addEventListener('click', () => {
            if (
              confirm(
                `Stage deletion of ${source.displayPath}? You will review and apply it separately.`,
              )
            )
              stageProposal({
                intent: 'delete',
                fileId: source.id,
                expectedHash: source.versionHash,
              });
          });
          actions.append(edit, remove);
          sourcePanel.append(actions, editorHost);
        }
      })
      .catch((error) => sourcePanel.append(make('p', 'error', error.message)));
    page.append(sourcePanel);
  }
  const table = make('table', 'resource-table');
  const head = make('thead');
  const row = make('tr');
  for (const title of ['Source', 'Kind', 'Scope', 'Size', 'Modified'])
    row.append(make('th', '', title));
  head.append(row);
  table.append(head);
  const body = make('tbody');
  for (const file of state.files) {
    const tr = make('tr');
    const td = make('td');
    td.append(link(`/sources/${encodeURIComponent(file.id)}`, file.displayPath, 'resource-name'));
    tr.append(
      td,
      make('td', '', file.kind),
      make('td', '', file.scope),
      make('td', '', `${file.size} bytes`),
      make('td', '', new Date(file.modifiedAt).toLocaleString()),
    );
    body.append(tr);
  }
  table.append(body);
  const panelNode = panel(
    `${state.files.length} indexed files`,
    'Opaque source IDs are used for reads; browser-supplied filesystem paths are never accepted.',
  );
  panelNode.append(table);
  page.append(panelNode);
  return page;
}
function renderAgentCreateForm() {
  const section = panel(
    'Create agent',
    'Configure a complete pi-subagents agent. Model selection is optional. All fields are staged for review; creating or editing agents requires the declared, installed pi-subagents 0.84.0 adapter.',
  );
  const container = make('div');
  renderAgentEditor(
    container,
    { name: 'new agent' },
    {
      editable: true,
      creating: true,
      frontmatter: { inheritProjectContext: true, inheritGlobalContext: true },
      body: '',
    },
  );
  section.append(container);
  return section;
}
function labeledTextarea(parent: HTMLElement, label: string, value = '', rows = 6) {
  const wrapper = make('label', 'form-field', label);
  const area = make('textarea', '');
  area.value = value;
  area.rows = rows;
  wrapper.append(area);
  parent.append(wrapper);
  return area;
}
function watchSkillDescription(area: HTMLTextAreaElement) {
  const hint = make('p', 'muted description-hint');
  hint.setAttribute('role', 'status');
  area.after(hint);
  const update = () => {
    const length = area.value.length;
    hint.className = length > 256 ? 'warning description-hint' : 'muted description-hint';
    hint.textContent =
      `${length.toLocaleString()} characters · approximately ${Math.ceil(length / 4).toLocaleString()} tokens. ` +
      (length > 1024
        ? 'Above the 1,024-character portability guideline. Long descriptions increase advertised context and some clients may reject them. You can still stage this skill.'
        : length > 256
          ? 'This description is verbose. Skill descriptions are advertised in model context; prefer a concise routing summary and put details in the instructions or references. You can still submit.'
          : 'Only the routing summary is advertised; full instructions and references load on demand.');
  };
  area.addEventListener('input', update);
  update();
}
function creationScopes(kind: string) {
  const scopes =
    kind === 'skill'
      ? [
          ['project', 'Project Pi'],
          ['global', 'Global Pi'],
          ['portable-project', 'Portable project'],
          ['portable', 'Portable global'],
        ]
      : [
          ['project', 'Project Pi'],
          ['global', 'Global Pi'],
        ];
  return scopes.filter(([value]) => state.env.mode !== 'global' || !value.includes('project'));
}
function bindCreationForm(form: HTMLFormElement, submit: HTMLButtonElement, prepare: () => any[]) {
  form.dataset.stageShortcut = 'true';
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    submit.disabled = true;
    try {
      const edits = prepare();
      await mutate('/api/changes/propose', { edits });
      await staged();
    } catch (error) {
      notify(error.message);
    } finally {
      submit.disabled = false;
    }
  });
}
function renderSkillCreateForm() {
  const section = panel(
    'Create skill',
    'Create the manifest, instructions, and supporting text files as one reviewed changeset. Files are not written or executed until Apply.',
  );
  const form = make('form', 'form-stack resource-create-form');
  const scope = selectField(form, 'Target scope', creationScopes('skill'));
  const name = labeledInput(form, 'Skill name');
  name.required = true;
  name.pattern = '[a-z0-9]+(-[a-z0-9]+)*';
  name.maxLength = 64;
  name.placeholder = 'review-pull-requests';
  const description = labeledTextarea(form, 'Description · when should Pi use this skill?', '', 3);
  description.required = true;
  watchSkillDescription(description);
  const body = labeledTextarea(form, 'Skill instructions (Markdown)', '# Instructions\n\n', 12);
  body.required = true;
  const advanced = make('details', 'advanced-fields');
  advanced.append(make('summary', '', 'Optional metadata and invocation settings'));
  const metadataFields = make('div', 'form-stack');
  const license = labeledInput(metadataFields, 'License (optional)');
  const compatibility = labeledInput(metadataFields, 'Compatibility requirements (optional)');
  const tools = labeledInput(metadataFields, 'Allowed tools (optional; space-separated)');
  const metadata = labeledTextarea(
    metadataFields,
    'Additional metadata (optional JSON object)',
    '',
    4,
  );
  const manualLabel = make('label', 'checkbox-field');
  const manual = make('input');
  manual.type = 'checkbox';
  manualLabel.append(
    manual,
    make('span', '', 'Manual invocation only · do not advertise to the model'),
  );
  metadataFields.append(manualLabel);
  advanced.append(metadataFields);
  form.append(advanced);
  const assets = make('section', 'form-stack skill-assets');
  assets.append(
    make('h3', '', 'References, scripts & text assets'),
    make(
      'p',
      'muted',
      'Add relative files such as references/checklist.md, scripts/check.sh, or assets/template.json. Link to them from your instructions. New files are non-executable; binary uploads are not supported.',
    ),
  );
  const files = make('div', 'form-stack');
  files.hidden = true;
  assets.append(files);
  const records: { row: HTMLElement; path: HTMLInputElement; content: HTMLTextAreaElement }[] = [];
  const add = make('button', 'button secondary', 'Add supporting file');
  add.type = 'button';
  add.addEventListener('click', () => {
    const row = make('section', 'skill-file-editor form-stack');
    const path = labeledInput(row, 'Relative file path');
    path.required = true;
    path.maxLength = 174;
    path.placeholder = 'references/checklist.md';
    path.pattern = '([a-zA-Z0-9][a-zA-Z0-9._-]{0,99}/)*[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}';
    const content = labeledTextarea(row, 'File content', '', 6);
    content.required = true;
    const remove = make('button', 'button secondary compact', 'Remove file');
    remove.type = 'button';
    const record = { row, path, content };
    records.push(record);
    remove.addEventListener('click', () => {
      records.splice(records.indexOf(record), 1);
      row.remove();
      files.hidden = !records.length;
      add.disabled = false;
    });
    row.append(remove);
    files.hidden = false;
    files.append(row);
    add.disabled = records.length >= 49;
    path.focus();
  });
  assets.append(add);
  form.append(assets);
  const submit = make('button', 'button', 'Review staged skill creation');
  submit.type = 'submit';
  form.append(submit);
  bindCreationForm(form, submit, () => {
    const skillName = name.value.trim();
    let extras = {};
    if (metadata.value.trim()) {
      extras = JSON.parse(metadata.value);
      if (!extras || typeof extras !== 'object' || Array.isArray(extras))
        throw new Error('Additional metadata must be a JSON object.');
    }
    const fields = {
      name: skillName,
      description: description.value.trim(),
      ...(license.value.trim() ? { license: license.value.trim() } : {}),
      ...(compatibility.value.trim() ? { compatibility: compatibility.value.trim() } : {}),
      ...(tools.value.trim() ? { 'allowed-tools': tools.value.trim() } : {}),
      ...(metadata.value.trim() ? { metadata: extras } : {}),
      ...(manual.checked ? { 'disable-model-invocation': true } : {}),
    };
    const yaml = Object.entries(fields)
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
      .join('\n');
    const seen = new Set<string>();
    const edits: any[] = [
      {
        intent: 'create',
        createTarget: { scope: scope.value, kind: 'skill', basename: skillName },
        content: `---\n${yaml}\n---\n\n${body.value}`,
      },
    ];
    for (const record of records) {
      const path = record.path.value.trim();
      if (path.toLowerCase() === 'skill.md' || seen.has(path))
        throw new Error('Supporting file paths must be unique and cannot replace SKILL.md.');
      seen.add(path);
      edits.push({
        intent: 'create',
        createTarget: {
          scope: scope.value,
          kind: 'skill-import-file',
          basename: `${skillName}/${path}`,
        },
        content: record.content.value,
      });
    }
    return edits;
  });
  section.append(form);
  return section;
}
function renderCreateForm(kind) {
  if (kind === 'agent') return renderAgentCreateForm();
  if (kind === 'skill') return renderSkillCreateForm();
  const section = panel(
    `Create ${kind}`,
    'Drafts are staged for review. Disk writes occur only after explicit Apply.',
  );
  const form = make('form', 'form-stack resource-create-form');
  const scope = selectField(form, 'Target scope', creationScopes(kind));
  let name: HTMLInputElement | HTMLSelectElement;
  if (kind === 'instruction')
    name = selectField(
      form,
      'Instruction filename',
      ['AGENTS.md', 'AGENTS.override.md', 'CLAUDE.md'].map((value) => [value, value]),
    );
  else if (!['system-prompt', 'append-system'].includes(kind)) {
    name = labeledInput(
      form,
      kind === 'command' ? 'Command name (without / or .md)' : 'Resource name',
    );
    name.required = true;
    name.pattern = '[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}';
    name.maxLength = 64;
    name.placeholder = kind === 'command' ? 'review' : `${kind}-name`;
  }
  const description =
    kind === 'command'
      ? labeledTextarea(form, 'Description (optional · shown in command completion)', '', 3)
      : null;
  const argumentHint =
    kind === 'command' ? labeledInput(form, 'Argument hint (optional)', '', 'text') : null;
  if (argumentHint) argumentHint.placeholder = '[focus] <required-argument>';
  const body = labeledTextarea(
    form,
    kind === 'command' ? 'Prompt template (Markdown)' : 'Content (Markdown)',
    kind === 'instruction' ? '# Project instructions\n\n' : '',
    12,
  );
  body.required = true;
  if (kind === 'command')
    form.append(
      make(
        'p',
        'notice',
        `Use $1, $2, $@, or \${1:-default} for arguments. This creates a file-backed prompt command, not an executable extension command. Templates are never executed by this preview.`,
      ),
    );
  const submit = make(
    'button',
    'button',
    kind === 'command' ? 'Review staged command creation' : 'Preview staged diff',
  );
  submit.type = 'submit';
  form.append(submit);
  bindCreationForm(form, submit, () => {
    const fields = {
      ...(description?.value.trim() ? { description: description.value.trim() } : {}),
      ...(argumentHint?.value.trim() ? { 'argument-hint': argumentHint.value.trim() } : {}),
    };
    const yaml = Object.entries(fields)
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
      .join('\n');
    return [
      {
        intent: 'create',
        createTarget: {
          scope: scope.value,
          kind,
          basename:
            kind === 'system-prompt'
              ? 'SYSTEM.md'
              : kind === 'append-system'
                ? 'APPEND_SYSTEM.md'
                : name.value.trim(),
        },
        content: yaml ? `---\n${yaml}\n---\n\n${body.value}` : body.value,
      },
    ];
  });
  section.append(form);
  return section;
}
function renderChanges() {
  const page = make('div', 'page');
  page.append(
    make('h1', '', 'Changes'),
    make(
      'p',
      'lead',
      'Edits are staged in memory. Apply rechecks hashes, saves private backups, journals writes, and reports reload requirements.',
    ),
  );
  if (state.recovery.length) {
    const warning = panel(
      'Interrupted transaction recovery required',
      'New changes are blocked until you explicitly restore the recorded before-state. External modifications are never overwritten.',
    );
    for (const item of state.recovery) {
      const row = make('div', 'change-item');
      row.append(make('strong', '', `${item.operation} · ${item.status}`));
      for (const file of item.files || []) row.append(make('p', 'muted', file));
      const button = make('button', 'button', 'Restore interrupted transaction');
      button.type = 'button';
      button.addEventListener('click', async () => {
        try {
          await mutate('/api/changes/recover', { journalId: item.id });
          await load();
          notify('Interrupted transaction recovered.');
        } catch (error) {
          notify(error.message);
        }
      });
      warning.append(row, button);
    }
    page.append(warning);
  }
  if (!state.changes.length)
    page.append(
      make(
        'p',
        'empty-state',
        'No staged changes. Edit a supported source or create a resource to begin.',
      ),
    );
  for (const change of state.changes) {
    const section = panel(
      `Changeset ${change.id}`,
      `${change.status === 'rolled_back' ? 'Rolled back' : change.status} · staged ${new Date(change.createdAt).toLocaleString()}${change.rolledBackAt ? ` · reverted ${new Date(change.rolledBackAt).toLocaleString()}` : ''}`,
    );
    for (const edit of change.edits) {
      const article = make('article', 'change-edit');
      article.append(
        make('h3', '', `${edit.intent} · ${edit.displayPath || edit.targetName}`),
        make(
          'p',
          'muted',
          `${edit.targetKind} · ${edit.reloadRequirement || 'reload requirement unknown'}`,
        ),
      );
      const diff = make('pre', 'diff-preview');
      for (const line of (edit.diff || '(No textual difference.)').split('\n')) {
        const kind = line.startsWith('@@')
          ? 'hunk'
          : line.startsWith('+') && !line.startsWith('+++')
            ? 'added'
            : line.startsWith('-') && !line.startsWith('---')
              ? 'removed'
              : 'context';
        diff.append(make('span', `diff-line diff-${kind}`, `${line}\n`));
      }
      article.append(diff);
      section.append(article);
    }
    if (change.validation?.length) {
      const issues = make('ul', 'diagnostic-list');
      for (const issue of change.validation)
        issues.append(make('li', 'severity-error', issue.message || issue.code));
      section.append(issues);
    }
    if (change.predictedEffects?.length) {
      section.append(make('h3', '', 'Predicted effects (runtime remains unknown)'));
      for (const effect of change.predictedEffects)
        section.append(
          make(
            'p',
            'muted',
            `${effect.name || effect.resourceId || 'resource'}: ${effect.before} → ${effect.after}`,
          ),
        );
    }
    const actions = make('div', 'toolbar');
    if (change.status === 'rolled_back') {
      const completed = make('button', 'button secondary', 'Rolled back');
      completed.type = 'button';
      completed.disabled = true;
      actions.append(completed);
    } else if (change.status === 'applied' && change.appliedId && canEdit()) {
      const rollback = make('button', 'button secondary', 'Rollback');
      rollback.type = 'button';
      rollback.addEventListener('click', async () => {
        if (
          !confirm(
            'Restore the backed-up before-state? Files changed after apply will be left untouched.',
          )
        )
          return;
        rollback.disabled = true;
        rollback.textContent = 'Rolling back…';
        rollback.setAttribute('aria-busy', 'true');
        let completed = false;
        try {
          await mutate('/api/changes/rollback', { appliedId: change.appliedId });
          completed = true;
          rollback.textContent = 'Rolled back';
          rollback.removeAttribute('aria-busy');
          await load();
          notify('Rollback completed.');
        } catch (error) {
          notify(error.message);
          if (!completed) {
            rollback.disabled = false;
            rollback.textContent = 'Rollback';
            rollback.removeAttribute('aria-busy');
          }
        }
      });
      actions.append(rollback);
    } else if (canEdit() && change.status !== 'applied') {
      const validate = make('button', 'button secondary', 'Revalidate');
      validate.type = 'button';
      validate.addEventListener('click', async () => {
        try {
          await mutate('/api/changes/validate', { changeSetId: change.id });
          await load();
        } catch (error) {
          notify(error.message);
        }
      });
      const apply = make('button', 'button', 'Apply reviewed changes');
      apply.type = 'button';
      apply.disabled = change.status !== 'validated';
      apply.addEventListener('click', async () => {
        if (!confirm('Apply the diff shown above? This writes to Pi configuration files.')) return;
        try {
          await mutate('/api/changes/apply', { changeSetId: change.id });
          await load();
          notify('Changes applied. Restart or reload Pi as indicated.');
        } catch (error) {
          notify(error.message);
          await load();
        }
      });
      const discard = make('button', 'button secondary', 'Discard draft');
      discard.type = 'button';
      discard.addEventListener('click', async () => {
        try {
          await mutate('/api/changes/discard', { changeSetId: change.id });
          await load();
        } catch (error) {
          notify(error.message);
        }
      });
      actions.append(validate, apply, discard);
    }
    section.append(actions);
    page.append(section);
  }
  if (canEdit()) {
    const createPanel = panel(
      'Create a resource',
      'Choose only a recognized Pi file type and scope.',
    );
    const createActions = make('div', 'toolbar create-actions');
    const createSlot = make('div', 'resource-create-slot');
    for (const kind of [
      'skill',
      'command',
      'agent',
      'instruction',
      'system-prompt',
      'append-system',
    ]) {
      const button = make('button', 'button secondary', `New ${kind}`);
      button.type = 'button';
      button.addEventListener('click', () => {
        createSlot.replaceChildren(renderCreateForm(kind));
      });
      createActions.append(button);
    }
    const requestedKind = new URLSearchParams(location.search).get('create');
    if (
      ['skill', 'command', 'agent', 'instruction', 'system-prompt', 'append-system'].includes(
        requestedKind,
      )
    )
      createSlot.append(renderCreateForm(requestedKind));
    createPanel.append(createActions, createSlot);
    page.append(createPanel);
  }
  return page;
}
function renderKeybindings() {
  const page = make('div', 'page');
  page.append(
    make('h1', '', 'Pi keybindings'),
    make(
      'p',
      'lead',
      'These mappings configure Pi’s terminal interface and are distinct from any Pinotator application shortcuts.',
    ),
  );
  const files = state.files.filter((file) => file.kind === 'keybindings');
  const panelNode = panel(
    `${files.length} keybinding sources`,
    'Read-only safe preview; mappings are not applied to Pinotator.',
  );
  if (!files.length)
    panelNode.append(make('p', 'muted', 'No keybindings.json was found in recognized roots.'));
  for (const file of files) {
    const row = make('div', 'instruction-source');
    row.append(make('span', '', file.displayPath), badge(file.scope));
    const open = sourceLink({ fileId: file.id });
    if (open) row.append(open);
    panelNode.append(row);
  }
  page.append(panelNode);
  if (canEdit()) {
    for (const file of files.filter((item) => ['global', 'project'].includes(item.scope)))
      page.append(renderKeybindingEditor(file));
    if (!files.some((file) => ['global', 'project'].includes(file.scope))) {
      const create = panel(
        'Create keybindings.json',
        'Pi keybinding actions depend on the installed version.',
      );
      addConfigFileForm(create, 'keybindings', 'keybindings-config', 'keybindings.json');
      page.append(create);
    }
  }
  page.append(
    make(
      'p',
      'muted',
      'Key syntax and collisions within configured mappings are checked. Confirm built-in and extension mappings in Pi with /hotkeys; automatic /reload is not sent.',
    ),
  );
  return page;
}
function renderDiagnostics() {
  const page = make('div', 'page');
  page.append(
    make('h1', '', 'Diagnostics'),
    make(
      'p',
      'lead',
      'No project code, credential command, package manager, or MCP server was executed.',
    ),
  );
  const skills = state.resources
    .filter((item) => item.kind === 'skill')
    .sort(
      (a, b) =>
        (b.contextFootprint?.descriptionCharacters || 0) -
        (a.contextFootprint?.descriptionCharacters || 0),
    );
  const context = panel(
    'Skill description context budget',
    'Pi advertises skill routing descriptions, not the full instructions or references. Long summaries can therefore bloat the agent’s starting context.',
  );
  const advertised = skills.filter(
    (skill) =>
      !skill.contextFootprint?.manualOnly &&
      !['invalid', 'excluded', 'shadowed'].includes(skill.state),
  );
  const total = advertised.reduce(
    (sum, skill) => sum + (skill.contextFootprint?.descriptionCharacters || 0),
    0,
  );
  const approximateUnits = advertised.reduce(
    (sum, skill) => sum + (skill.contextFootprint?.approximateUnits || 0),
    0,
  );
  context.append(
    make(
      'p',
      'muted',
      `${advertised.length} advertisement candidates · ${total.toLocaleString()} description characters · approximately ${approximateUnits.toLocaleString()} tokens. This is a rough characters ÷ 4 estimate, not tokenizer output; trust, duplicates, names, paths, formatting, and runtime selection can change the actual prompt. Manual-only skills are excluded from this sum.`,
    ),
  );
  if (skills.length) {
    const table = make('table', 'resource-table context-budget-table');
    table.append(make('caption', 'sr-only', 'Skill description context estimates, largest first'));
    const head = make('thead');
    const headings = make('tr');
    for (const title of [
      'Skill',
      'Description · expand to read',
      'Characters',
      '~ Tokens',
      'Invocation',
    ])
      headings.append(make('th', '', title));
    head.append(headings);
    table.append(head);
    const rows = make('tbody');
    for (const skill of skills) {
      const row = make('tr');
      const name = make('td');
      name.append(link(`/skills/${encodeURIComponent(skill.id)}`, skill.name, 'resource-name'));
      if ((skill.contextFootprint?.descriptionCharacters || 0) > 256)
        name.append(badge('Verbose', 'status-untrusted'));
      const description = make('td', 'description-cell');
      const details = make('details', 'skill-description-details');
      details.append(
        make('summary', '', skill.description || 'No description'),
        make(
          'p',
          'skill-description',
          skill.descriptionFull || skill.description || 'No description',
        ),
      );
      if (skill.contextFootprint?.descriptionTruncated)
        details.append(
          make(
            'p',
            'muted',
            'Description preview is bounded to 8,192 characters. Open the source for the remaining text.',
          ),
        );
      if (skill.source) details.append(sourceLink(skill.source));
      description.append(details);
      row.append(
        name,
        description,
        make('td', 'numeric-cell', skill.contextFootprint?.descriptionCharacters || 0),
        make('td', 'numeric-cell', skill.contextFootprint?.approximateUnits || 0),
        make(
          'td',
          '',
          skill.contextFootprint?.manualOnly
            ? 'Manual only'
            : ['invalid', 'excluded', 'shadowed'].includes(skill.state)
              ? 'Not advertised'
              : 'Advertisement candidate',
        ),
      );
      rows.append(row);
    }
    table.append(rows);
    context.append(table);
  } else
    context.append(make('p', 'muted', 'No skill manifests were found in the recognized roots.'));
  page.append(context);
  const panelNode = panel(
    `${state.diagnostics.length} findings`,
    'Severity and source evidence are shown where available.',
  );
  addDiagnostics(panelNode, state.diagnostics);
  page.append(panelNode);
  return page;
}
function renderTemplates() {
  const page = make('div', 'page');
  page.append(
    make('h1', '', 'Templates & project bootstrap'),
    make(
      'p',
      'lead',
      'Stage small, reviewable starter resources without running code or overwriting existing files. All files in a team template enter one changeset; nothing is written until Apply.',
    ),
  );
  const listPanel = panel(
    'Available templates',
    'Existing destinations are rejected. Templates contain no scripts or credentials.',
  );
  page.append(listPanel);
  api('/api/templates')
    .then((templates) => {
      listPanel.replaceChildren();
      listPanel.append(make('div', 'panel-header'));
      const header = listPanel.querySelector('.panel-header');
      header.append(
        make('h2', '', `${templates.length} templates`),
        make('p', 'muted', 'Stage into one scope; then inspect and Apply from Changes.'),
      );
      for (const item of templates) {
        const card = make('article', 'template-card');
        card.append(make('h3', '', item.name), make('p', 'muted', item.description));
        card.append(
          make(
            'p',
            'muted',
            `${item.fileCount} file${item.fileCount === 1 ? '' : 's'}${item.requiresAdapter ? ` · requires ${item.requiresAdapter}` : ''}`,
          ),
        );
        const controls = make('div', 'template-controls');
        const scopeLabel = make('label', 'field');
        scopeLabel.append(make('span', '', 'Target scope'));
        const scope = make('select', 'input');
        for (const [value, label] of [
          ['project', 'Project'],
          ['global', 'Global'],
        ]) {
          const option = document.createElement('option');
          option.value = value;
          option.textContent = label;
          if ((state.env.mode === 'global' ? 'global' : 'project') === value)
            option.selected = true;
          scope.append(option);
        }
        scopeLabel.append(scope);
        const stage = make('button', 'button', 'Stage template');
        stage.type = 'button';
        stage.disabled = Boolean(state.env.readOnly);
        stage.addEventListener('click', async () => {
          const destination = `${scope.value} scope`;
          if (
            !window.confirm(
              `Stage “${item.name}” in ${destination}? This will only create a changeset, not write files.`,
            )
          )
            return;
          try {
            const result = await mutate('/api/templates/stage', {
              templateId: item.id,
              scope: scope.value,
              confirmed: true,
            });
            await staged(`${item.name} staged as one changeset (${result.edits.length} files).`);
          } catch (error) {
            notify(error.message);
          }
        });
        controls.append(scopeLabel, stage);
        card.append(controls);
        listPanel.append(card);
      }
    })
    .catch((error) => listPanel.append(make('p', 'warning', error.message)));
  return page;
}
function renderCompanion() {
  const page = make('div', 'page');
  page.append(
    make('h1', '', 'Companion Pi sessions'),
    make(
      'p',
      'lead',
      'Pair individual Pi processes to inspect current model, registered tools/models, active tools, commands, and whether a run is active. Pairing is ephemeral and shares no transcript, prompt, credentials, or file contents.',
    ),
  );
  const setup = panel(
    'Pair this local Pinotator instance',
    'The code is one-use and expires in two minutes. The companion extension is executable code inside Pi; read and install it only if you trust it.',
  );
  const pairButton = make('button', 'button', 'Create one-time pairing code');
  pairButton.addEventListener('click', async () => {
    try {
      const result = await mutate('/api/companion/pair', {});
      setup.querySelector('.pairing-code')?.remove();
      const instructions = make('div', 'pairing-code');
      instructions.append(
        make('p', '', `Run /pinotator-pair in the Pi process you want to connect.`),
        make(
          'p',
          'code-preview',
          `URL: ${location.origin}\nOne-time code: ${result.code}\nExpires: ${result.expiresAt}`,
        ),
        make(
          'p',
          'muted',
          'Install the included integrations/pinotator-companion.mjs in a Pi extension directory and restart Pi first. Then enter the local URL and code when prompted. Tokens remain in memory and expire when the process stops sending heartbeats.',
        ),
      );
      setup.append(instructions);
    } catch (error) {
      notify(error.message);
    }
  });
  setup.append(pairButton);
  const sessions = panel(
    'Connected Pi processes',
    'Metadata is held only in this Pinotator process and removed after heartbeat expiry or /pinotator-unpair.',
  );
  sessions.append(make('p', 'muted', 'Loading companion sessions…'));
  const note = panel(
    'Control boundary',
    'Pinotator does not send prompts or inspect session transcripts. A reload request is only a short-lived signal: the Pi operator must run /pinotator-handle-reload and confirm locally. On-disk changes still require review and explicit Apply; Pinotator cannot verify that Pi reload succeeded.',
  );
  page.append(setup, sessions, note);
  const renderSessions = () =>
    api('/api/companion/sessions')
      .then((items) => {
        sessions.replaceChildren();
        sessions.append(make('div', 'panel-header', ''));
        const header = sessions.querySelector('.panel-header');
        header.append(
          make('h2', '', 'Connected Pi processes'),
          make(
            'p',
            'muted',
            'Metadata only; no prompts, transcript, credentials, or file contents.',
          ),
        );
        if (!items.length)
          sessions.append(make('p', 'muted', 'No companion Pi process is paired.'));
        for (const item of items) {
          const card = make('article', 'companion-card');
          const status = item.status;
          card.append(
            make(
              'h3',
              '',
              `${status.cwdLabel || 'workspace'} · ${status.model ? `${status.model.provider}/${status.model.id}` : 'model unknown'}`,
            ),
          );
          card.append(
            make(
              'p',
              'muted',
              `${status.busy ? 'Running' : 'Idle'} · heartbeat expires in ${item.expiresInSeconds}s · updated ${new Date(item.updatedAt).toLocaleTimeString()}`,
            ),
          );
          if (item.reloadRequest)
            card.append(
              make(
                'p',
                item.reloadRequest.status === 'pending' ? 'warning' : 'muted',
                `Reload request: ${item.reloadRequest.status}`,
              ),
            );
          const requestReload = make(
            'button',
            'button secondary',
            item.reloadRequest?.status === 'pending'
              ? 'Reload request pending'
              : 'Request Pi reload',
          );
          requestReload.type = 'button';
          requestReload.disabled = Boolean(
            state.env.readOnly || status.busy || item.reloadRequest?.status === 'pending',
          );
          requestReload.addEventListener('click', async () => {
            if (
              !window.confirm(
                'Queue a reload request for this paired Pi process? The Pi operator must separately run the companion command and confirm in Pi.',
              )
            )
              return;
            try {
              await mutate('/api/companion/reload-request', { sessionId: item.id });
              await renderSessions();
            } catch (error) {
              notify(error.message);
            }
          });
          card.append(requestReload);
          const lists = make('details', '');
          lists.append(make('summary', '', 'Registered and active tools, commands, models'));
          lists.append(
            make(
              'p',
              'muted',
              `Active tools: ${(status.activeTools || []).join(', ') || 'none reported'}`,
            ),
          );
          lists.append(
            make(
              'p',
              'muted',
              `Registered tools: ${(status.registeredTools || []).join(', ') || 'none reported'}`,
            ),
          );
          lists.append(
            make(
              'p',
              'muted',
              `Commands: ${(status.commands || []).join(', ') || 'none reported'}`,
            ),
          );
          lists.append(
            make(
              'p',
              'muted',
              `Registered models: ${(status.registeredModels || []).map((model) => `${model.provider}/${model.id}`).join(', ') || 'none reported'}`,
            ),
          );
          card.append(lists);
          sessions.append(card);
        }
      })
      .catch((error) => {
        sessions.replaceChildren(make('p', 'warning', error.message));
      });
  void renderSessions();
  const refreshTimer = setInterval(() => {
    if (currentPath() !== '/companion') clearInterval(refreshTimer);
    else void renderSessions();
  }, 5000);
  return page;
}
function renderMigration() {
  const page = make('div', 'page');
  page.append(
    make('h1', '', 'Pi and adapter migration'),
    make(
      'p',
      'lead',
      'Compare the installed Pi/adapter versions with private snapshots, then review resource changes. This is a read-only assistant, not an automatic schema migration.',
    ),
  );
  const reportPanel = panel('Compatibility report', 'Loading version evidence…');
  page.append(reportPanel);
  api('/api/migrations')
    .then((report) => {
      reportPanel.replaceChildren();
      const header = make('div', 'panel-header');
      header.append(
        make('h2', '', `Pi ${report.current.piVersion}`),
        make(
          'p',
          'muted',
          `${report.certainty} · runtime compatibility: ${report.current.compatibility} (tested ${report.current.testedPiVersion})`,
        ),
      );
      reportPanel.append(header);
      const adapterVersions = make(
        'p',
        'muted',
        `pi-subagents adapter target: ${report.current.testedPiSubagentsVersion}. Current agent versions: ${report.current.adapterVersions.map((entry) => `${entry.version} (${entry.count} agents, ${entry.compatibility})`).join(', ') || 'none detected'}`,
      );
      reportPanel.append(adapterVersions);
      const baselineButton = make('button', 'button secondary', 'Create a pre-migration snapshot');
      baselineButton.addEventListener('click', async () => {
        if (
          !window.confirm(
            'Create a private snapshot of current recognized resources? No contents are exported.',
          )
        )
          return;
        try {
          const result = await mutate('/api/snapshots/create', {
            label: `Migration baseline ${new Date().toISOString().slice(0, 10)}`,
            confirmed: true,
          });
          notify(`Snapshot created: ${result.label}`);
          await load();
        } catch (error) {
          notify(error.message);
        }
      });
      reportPanel.append(baselineButton);
      reportPanel.append(make('h3', '', 'Recorded baselines'));
      if (!report.baselines.length)
        reportPanel.append(make('p', 'muted', 'No local snapshot baseline exists yet.'));
      for (const baseline of report.baselines)
        reportPanel.append(
          make(
            'p',
            'muted',
            `${baseline.label} · Pi ${baseline.piVersion} · ${baseline.branch || 'branch unknown'} · ${new Date(baseline.createdAt).toLocaleString()}`,
          ),
        );
      reportPanel.append(make('h3', '', 'Version differences'));
      if (!report.changes.length)
        reportPanel.append(
          make(
            'p',
            'muted',
            'No Pi or agent-adapter version differences found against available snapshots.',
          ),
        );
      for (const change of report.changes)
        reportPanel.append(
          make(
            'p',
            change.severity === 'warning' ? 'warning' : 'muted',
            `${change.kind}: ${change.before} → ${change.after} · ${change.message}`,
          ),
        );
      reportPanel.append(make('h3', '', 'Review checklist'));
      for (const item of report.checklist) reportPanel.append(make('p', 'muted', `• ${item}`));
      reportPanel.append(make('h3', '', 'Limits'));
      for (const item of report.limitations) reportPanel.append(make('p', 'muted', item));
      const snapshotLink = link('/snapshots', 'Open snapshots and compare', 'button secondary');
      reportPanel.append(snapshotLink);
    })
    .catch((error) => reportPanel.append(make('p', 'warning', error.message)));
  return page;
}
function renderGraphDiagram(graph: AnalysisGraph) {
  const wrapper = make('div', 'analysis-graph-scroll');
  const svgNs = 'http://www.w3.org/2000/svg';
  const create = (tag, attributes = {}) => {
    const node = document.createElementNS(svgNs, tag);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
    return node;
  };
  const agents = graph.nodes.filter((node) => node.kind === 'agent').slice(0, 40);
  const known = new Map(graph.nodes.map((node) => [node.id, node]));
  const targets = [];
  for (const edge of graph.edges) {
    if (known.has(edge.to) && known.get(edge.to).kind === 'agent') continue;
    if (!targets.some((node) => node.id === edge.to))
      targets.push(
        known.get(edge.to) || {
          id: edge.to,
          kind: 'unknown',
          name: edge.to.replace(/^[^:]+:/, ''),
          state: 'unknown',
        },
      );
  }
  targets.splice(60);
  const height = Math.max(250, Math.max(agents.length, targets.length) * 70 + 80);
  const svg = create('svg', {
    viewBox: `0 0 1000 ${height}`,
    role: 'img',
    'aria-label': 'Static Pi agent dependency graph',
  });
  const title = create('title');
  title.textContent = 'Static configuration and policy dependency graph';
  svg.append(title);
  const defs = create('defs');
  const marker = create('marker', {
    id: 'analysis-arrow',
    markerWidth: 8,
    markerHeight: 8,
    refX: 7,
    refY: 4,
    orient: 'auto',
  });
  marker.append(create('path', { d: 'M0,0 L8,4 L0,8 z', fill: 'var(--muted-foreground)' }));
  defs.append(marker);
  svg.append(defs);
  const leftPositions = new Map(agents.map((node, index) => [node.id, 45 + index * 70]));
  const rightPositions = new Map(targets.map((node, index) => [node.id, 45 + index * 70]));
  const strokeFor = (status) =>
    ({
      resolved: 'var(--success)',
      'policy-included': 'var(--success)',
      unresolved: 'var(--destructive)',
      disabled: 'var(--muted-foreground)',
      conditional: 'var(--warning)',
      unknown: 'var(--warning)',
      declared: 'var(--muted-foreground)',
    })[status] || 'var(--muted-foreground)';
  const drawNode = (node, x, y, width) => {
    const group = create('g', { class: `graph-node graph-${node.kind}` });
    const rect = create('rect', { x, y: y - 22, width, height: 44, rx: 7 });
    const textNode = create('text', { x: x + 12, y: y + 5 });
    const label = `${node.name}${node.scope ? ` · ${node.scope}` : ''}`;
    const maxCharacters = Math.floor((width - 24) / 7);
    textNode.textContent =
      label.length > maxCharacters ? `${label.slice(0, maxCharacters - 1)}…` : label;
    const nodeTitle = create('title');
    nodeTitle.textContent = `${node.name}; ${node.kind}; ${node.state || 'unknown'}`;
    group.append(rect, textNode, nodeTitle);
    svg.append(group);
  };
  for (const edge of graph.edges.slice(0, 250)) {
    const start = leftPositions.get(edge.from);
    const targetIsAgent = leftPositions.has(edge.to);
    const end = targetIsAgent ? leftPositions.get(edge.to) : rightPositions.get(edge.to);
    if (start === undefined || end === undefined) continue;
    const sx = targetIsAgent ? 295 : 295;
    const ex = targetIsAgent ? 16 : 670;
    const path = create('path', {
      d: targetIsAgent
        ? `M ${sx} ${start} C 490 ${start}, -80 ${end}, ${ex} ${end}`
        : `M ${sx} ${start} C 430 ${start}, 520 ${end}, ${ex} ${end}`,
      stroke: strokeFor(edge.status),
      'stroke-dasharray': ['conditional', 'unknown', 'declared'].includes(edge.status)
        ? '6 5'
        : 'none',
      'marker-end': 'url(#analysis-arrow)',
      fill: 'none',
    });
    const edgeTitle = create('title');
    edgeTitle.textContent = `${edge.type}: ${edge.status}. ${edge.explanation}`;
    path.append(edgeTitle);
    svg.append(path);
  }
  agents.forEach((node, index) => drawNode(node, 16, 45 + index * 70, 280));
  targets.forEach((node, index) => drawNode(node, 670, 45 + index * 70, 310));
  wrapper.append(svg);
  if (graph.nodes.filter((node) => node.kind === 'agent').length > 40 || targets.length >= 60)
    wrapper.append(
      make(
        'p',
        'muted',
        'Diagram is bounded to 40 agents and 60 target nodes; detailed edge lists remain available below.',
      ),
    );
  return wrapper;
}
function renderAnalysis() {
  const page = make('div', 'page');
  page.append(
    make('h1', '', 'Dependencies & workflow'),
    make(
      'p',
      'lead',
      'Inspect adapter-declared model, skill, agent, and context-policy edges. This graph is static: no agent is run and no child-session prompt is claimed as exact.',
    ),
  );
  const overview = panel(
    'Analysis graph',
    'Unresolved and conditional references stay visible; they are not promoted to active runtime facts.',
  );
  const summary = make('p', 'muted', 'Loading graph…');
  overview.append(summary);
  const sections = make('div', 'analysis-sections');
  overview.append(sections);
  const diagnostics = panel(
    'Reference diagnostics',
    'Missing or uncertain references detected from supported static metadata.',
  );
  const cost = panel(
    'Illustrative workflow cost',
    'Enter per-call token assumptions and invocation counts. Estimates use only known USD rates; unknown agents prevent a complete total.',
  );
  const costInputs = make('div', 'cost-inputs');
  const inputTokens = labeledInput(costInputs, 'Input tokens per agent call', '10000', 'number');
  const outputTokens = labeledInput(costInputs, 'Output tokens per agent call', '2000', 'number');
  cost.append(costInputs);
  const costResult = make('div', 'cost-result');
  cost.append(costResult);
  page.append(overview, diagnostics, cost);
  api('/api/analysis/graph')
    .then((graph) => {
      summary.textContent = `${graph.nodes.length} nodes · ${graph.edges.length} edges · Pi ${graph.piVersion} · ${graph.certainty}`;
      if (graph.nodes.some((node) => node.kind === 'agent'))
        overview.append(renderGraphDiagram(graph));
      const nameFor = (id) =>
        graph.nodes.find((node) => node.id === id)?.name || id.replace(/^[^:]+:/, '');
      const renderEdges = (title, types) => {
        const section = make('section', 'analysis-group');
        section.append(make('h2', '', title));
        const selected = graph.edges.filter((edge) => types.includes(edge.type));
        if (!selected.length) section.append(make('p', 'muted', 'No statically declared edges.'));
        else {
          const listNode = make('ul', 'analysis-edge-list');
          for (const edge of selected) {
            const item = make('li', '');
            item.append(
              make('strong', '', nameFor(edge.from)),
              make('span', '', ` → ${nameFor(edge.to)} · ${edge.type} · ${edge.status}`),
              make('p', 'muted', edge.explanation),
            );
            listNode.append(item);
          }
          section.append(listNode);
        }
        sections.append(section);
      };
      renderEdges('Agent workflow references', ['agent-workflow']);
      renderEdges('Model selection', ['model-selection']);
      renderEdges('Skills and inheritance', ['skill-reference', 'skill-inheritance']);
      renderEdges('Tool policy declarations', ['tool-selection', 'tool-exclusion']);
      renderEdges('System prompt policy', ['system-prompt-policy']);
      renderEdges('Context assembly policy', ['context-policy']);
      const modelRates = panel(
        'Model capability & cost policies',
        'Rates are USD per 1M input/output tokens. Capability and rate metadata are declarations, not guarantees of availability or billing.',
      );
      if (!graph.models.length)
        modelRates.append(
          make(
            'p',
            'muted',
            'No model catalog is available. Explicitly inspect Effective Pi State to load the installed core catalog; this does not refresh models or access the network.',
          ),
        );
      for (const model of graph.models) {
        const capability = model.capabilities || {};
        modelRates.append(
          make(
            'p',
            'muted',
            `${model.ref} · reasoning ${fmt(capability.reasoning)} · input ${fmt(capability.input)} · context ${fmt(capability.contextTokens)} · max output ${fmt(capability.outputTokens)} · ${model.cost ? `input $${model.cost.input}, output $${model.cost.output}` : 'cost unknown'} · ${model.source}`,
          ),
        );
      }
      sections.append(modelRates);
      addDiagnostics(diagnostics, graph.diagnostics);
      const scenario = make('div', 'analysis-group');
      scenario.append(make('h2', '', 'Invocation assumptions'));
      const counts = new Map();
      for (const agent of graph.agents) {
        const wrapper = make('label', 'field');
        wrapper.append(make('span', '', `${agent.name} calls`));
        const control = make('input', 'input');
        control.type = 'number';
        control.min = '0';
        control.max = '1000';
        control.value = '1';
        wrapper.append(control);
        scenario.append(wrapper);
        counts.set(agent.id, control);
      }
      const estimateButton = make('button', 'button', 'Estimate this scenario');
      estimateButton.type = 'button';
      const estimateOutput = make('div', 'code-preview');
      estimateButton.addEventListener('click', async () => {
        try {
          const result = await mutate('/api/analysis/estimate', {
            inputTokensPerCall: Number(inputTokens.value),
            outputTokensPerCall: Number(outputTokens.value),
            invocations: [...counts].map(([agentId, control]) => ({
              agentId,
              count: Number(control.value),
            })),
          });
          estimateOutput.replaceChildren();
          estimateOutput.append(
            make(
              'p',
              '',
              result.complete
                ? `Estimated total: $${result.totalUsd.toFixed(6)}`
                : `Known-cost subtotal: $${result.knownSubtotalUsd.toFixed(6)} · total incomplete (${result.unknown.length} unknown)`,
            ),
          );
          for (const entry of result.estimates)
            estimateOutput.append(
              make(
                'p',
                'muted',
                `${entry.name} · ${entry.invocationCount} calls · $${entry.totalUsd.toFixed(6)} (based on explicit per-call token assumptions)`,
              ),
            );
          for (const entry of result.unknown)
            estimateOutput.append(
              make('p', 'warning', `${entry.name} · no estimate: ${entry.reason}`),
            );
          estimateOutput.append(make('p', 'muted', result.caveat));
        } catch (error) {
          notify(error.message);
        }
      });
      scenario.append(estimateButton, estimateOutput);
      cost.append(scenario);
      for (const limitation of graph.limitations) cost.append(make('p', 'muted', limitation));
    })
    .catch((error) => {
      summary.textContent = error.message;
    });
  return page;
}
function renderEffectiveRuntime() {
  const page = make('div', 'page');
  page.append(
    make('h1', '', 'Effective Pi state'),
    make(
      'p',
      'lead',
      'Ask the verified Pi 1.4.0 resource loader and model runtime which core resources and settings it resolves for this workspace.',
    ),
  );
  const consent = panel(
    'Safety boundary',
    'This inspection imports only the installed Pi SDK, disables extension loading, and does not connect MCP servers or use model-network APIs. The project trust decision is honored; project extensions remain unloaded.',
  );
  consent.append(
    make(
      'p',
      'muted',
      `Pi version: ${state.env.piVersion || 'unknown'} · trust: ${state.env.trust} · capability: ${state.env.capabilities.runtimeInspection || 'unknown'}`,
    ),
  );
  if (canEdit() && state.env.capabilities.runtimeInspection === 'available-on-consent') {
    const inspect = make('button', 'button', 'Inspect effective state with installed Pi');
    inspect.type = 'button';
    inspect.addEventListener('click', async () => {
      if (
        !confirm(
          'Run the installed Pi 1.4.0 core resolver in safe mode? Extensions and MCP servers will not be loaded, and no model network request will be made.',
        )
      )
        return;
      inspect.disabled = true;
      try {
        state.effectiveRuntime = await mutate('/api/runtime/effective-inspect', {
          confirmed: true,
        });
        render();
      } catch (error) {
        notify(error.message);
      } finally {
        inspect.disabled = false;
      }
    });
    consent.append(inspect);
  } else if (!canEdit()) {
    consent.append(make('p', 'muted', 'Runtime inspection is disabled in read-only mode.'));
  } else {
    consent.append(
      make('p', 'muted', 'This Pi version is unsupported; effective state remains unknown.'),
    );
  }
  page.append(consent);
  const runtime = state.effectiveRuntime;
  if (!runtime) {
    page.append(
      make('p', 'empty-state', 'No effective-state inspection has been run in this session.'),
    );
    return page;
  }
  page.append(
    make(
      'p',
      'badge status-active',
      `Pi ${runtime.piVersion} · ${runtime.inspectionMode} · no project extensions/MCP; model-catalog refresh disabled`,
    ),
  );
  const settings = panel(
    'Effective startup settings',
    'Values come from Pi’s version-matched SettingsManager, honoring saved project trust.',
  );
  for (const [name, value] of Object.entries(runtime.settings || {}))
    if (value !== undefined) settings.append(make('p', '', `${name}: ${fmt(value)}`));
  settings.append(
    make(
      'p',
      '',
      `Resolved default model: ${runtime.selectedModel || 'none'} (${runtime.modelSource})`,
    ),
  );
  page.append(settings);
  for (const [kind, title] of [
    ['skills', 'Pi-resolved skills'],
    ['prompts', 'Pi-resolved prompt templates'],
    ['contextFiles', 'Pi-resolved context files'],
  ]) {
    const items = runtime.resources?.[kind] || [];
    const section = panel(
      `${title} · ${items.length}`,
      'Resolved by the installed Pi core; source links are shown when they match an indexed file.',
    );
    for (const item of items) {
      const row = make('article', 'instruction-source');
      row.append(
        make('strong', '', `${item.name || item.kind}: ${item.description || 'No description'}`),
      );
      if (item.sourcePath) row.append(make('span', 'muted', item.sourcePath));
      if (item.argumentHint) row.append(make('span', 'muted', `Arguments: ${item.argumentHint}`));
      if (item.sourceId) row.append(sourceLink({ fileId: item.sourceId }));
      section.append(row);
    }
    if (!items.length)
      section.append(make('p', 'muted', 'No resources resolved in this category.'));
    page.append(section);
  }
  const prompt = panel(
    'System prompts',
    'Only source metadata and content hashes are returned; prompt text stays out of this response.',
  );
  prompt.append(
    make(
      'p',
      '',
      `SYSTEM.md source: ${runtime.systemPrompt.sourcePath || 'Pi built-in default'} · ${runtime.systemPrompt.characters} characters · ${runtime.systemPrompt.contentHash || 'no file content'}`,
    ),
  );
  for (const entry of runtime.appendedSystemPrompts)
    prompt.append(
      make(
        'p',
        '',
        `APPEND_SYSTEM: ${entry.sourcePath || 'unknown source'} · ${entry.characters} characters · ${entry.contentHash}`,
      ),
    );
  page.append(prompt);
  const modelPanel = panel(
    `Pi model catalog · ${runtime.models.length}`,
    'Provider/model identities and credential status are from the installed Pi runtime. No credential values are returned. The separate per-model test sends one fixed minimal request and may incur a charge; command-based credential resolvers are blocked.',
  );
  for (const model of runtime.models.slice(0, 100)) {
    const row = make('article', 'instruction-source');
    row.append(make('strong', '', `${model.ref} · ${model.name}`));
    row.append(
      make(
        'span',
        'muted',
        `request origin ${model.endpointOrigin || 'provider-managed / unknown'}`,
      ),
    );
    row.append(
      make(
        'span',
        'muted',
        `credentials ${model.credentials.configured ? 'configured' : 'not configured'} (${model.credentials.source}) · reasoning ${model.reasoning} · input ${model.input.join(', ') || 'unknown'}`,
      ),
    );
    if (model.cost)
      row.append(
        make(
          'span',
          'muted',
          `USD/1M input ${model.cost.input ?? 'unknown'} · output ${model.cost.output ?? 'unknown'}`,
        ),
      );
    const testOutput = make('span', 'muted', '');
    const testButton = make('button', 'button secondary compact', 'Send minimal test request');
    testButton.type = 'button';
    testButton.disabled =
      !canEdit() ||
      !model.credentials.configured ||
      model.credentials.source === 'models_json_command';
    testButton.title =
      model.credentials.source === 'models_json_command'
        ? 'Blocked: test requests never execute models.json credential commands.'
        : !model.credentials.configured
          ? 'Pi reports no configured credentials.'
          : '';
    testButton.addEventListener('click', async () => {
      const destination =
        model.endpointOrigin || 'the configured provider endpoint (origin unknown)';
      if (
        !window.confirm(
          `Send one real request to ${model.ref} at ${destination}? It may incur a charge. Only a fixed minimal prompt is sent, with no workspace context/tools and a 48-token output cap. The response text is discarded.`,
        )
      )
        return;
      testButton.disabled = true;
      testOutput.textContent = 'Sending one explicitly consented provider request…';
      try {
        const result = await mutate('/api/runtime/model-test', {
          modelRef: model.ref,
          confirmed: true,
        });
        const usage = result.usage;
        testOutput.textContent =
          result.status === 'completed'
            ? ` · completed (${usage?.totalTokens ?? 'unknown'} tokens${usage?.reportedCostUsd == null ? '' : `; Pi-reported $${usage.reportedCostUsd}`}).`
            : result.status === 'deferred'
              ? ' · provider deferred the request; Pinotator will not fetch the response.'
              : ' · provider returned an error; details withheld.';
      } catch (error) {
        testOutput.textContent = ` · ${error.message}`;
      } finally {
        testButton.disabled =
          !canEdit() ||
          !model.credentials.configured ||
          model.credentials.source === 'models_json_command';
      }
    });
    row.append(testButton, testOutput);
    modelPanel.append(row);
  }
  if (runtime.models.length > 100)
    modelPanel.append(
      make('p', 'muted', `Showing 100 of ${runtime.models.length} catalog entries.`),
    );
  page.append(modelPanel);
  if (runtime.diagnostics?.length) {
    const diagnosticPanel = panel(`Pi resolver diagnostics · ${runtime.diagnostics.length}`);
    addDiagnostics(diagnosticPanel, runtime.diagnostics);
    page.append(diagnosticPanel);
  }
  return page;
}
function extensionOrigin(item) {
  if (item.installationOrigin === 'pi-default') return 'Pi default';
  if (item.installationOrigin === 'user') {
    if (item.kind === 'package' && !item.installed && !item.installationVerified)
      return 'User-configured';
    return item.owner === 'configured-extension-path' ? 'User-configured path' : 'User-installed';
  }
  return 'Unattributed manifest';
}
function extensionActions(item, feedback) {
  const actions = make('div', 'table-actions');
  const verifiedCli = state.env.piVersion === '1.4.0';
  if (item.packageSource) {
    const floating =
      /^npm:(?:@[^/]+\/)?[^@]+$/.test(item.packageSource) ||
      (/^(?:git:|https:\/\/|ssh:\/\/|git@)/.test(item.packageSource) &&
        !item.packageSource.split('/').at(-1).includes('@'));
    const runAction = async (operation, button) => {
      const scope = item.configScope || item.scope;
      if (
        !confirm(
          `${operation === 'remove' ? 'Remove' : 'Update'} package ${item.packageSource} in ${scope} scope using Pi? This runs immediately, outside staged changes, and may run third-party package scripts. ${operation === 'remove' ? 'All extensions supplied by this package may be removed.' : 'A newer version is not known to be available.'} Reload Pi afterward; no project trust is granted.`,
        )
      )
        return;
      actions.querySelectorAll('button').forEach((control) => {
        control.disabled = true;
      });
      button.textContent = operation === 'remove' ? 'Removing…' : 'Updating…';
      try {
        const result = await mutate('/api/packages/action', {
          operation,
          source: item.packageSource,
          scope,
          confirmed: true,
        });
        if (result.exitCode !== 0) {
          feedback.hidden = false;
          feedback.textContent = `${result.command} exited with ${result.exitCode}.\n${result.stderr || result.stdout || 'Pi returned no further details.'}`;
          notify('Pi package command failed. Review the command output below the list.');
          return;
        }
        notify(
          `Package ${operation === 'remove' ? 'removed' : 'update command completed'}. Reload Pi to pick up changes.`,
        );
        await load();
      } catch (error) {
        feedback.hidden = false;
        feedback.textContent = error.message;
        notify(error.message);
      } finally {
        actions.querySelectorAll('button').forEach((control) => {
          control.disabled = false;
        });
        button.textContent = operation === 'remove' ? 'Remove package' : 'Update package';
      }
    };
    const remove = make('button', 'button secondary compact', 'Remove package');
    remove.type = 'button';
    remove.disabled = !canEdit() || !verifiedCli;
    remove.setAttribute(
      'aria-label',
      `Remove package ${item.packageSource} from ${item.configScope || item.scope}`,
    );
    remove.title = !canEdit()
      ? 'Read-only workspace'
      : !verifiedCli
        ? 'Requires verified Pi 1.4.0'
        : 'Runs Pi remove immediately after confirmation';
    remove.addEventListener('click', () => runAction('remove', remove));
    actions.append(remove);
    if (floating && (item.configScope || item.scope) === 'global') {
      const update = make('button', 'button secondary compact', 'Update package');
      update.type = 'button';
      update.disabled = !canEdit() || !verifiedCli;
      update.setAttribute('aria-label', `Run update for ${item.packageSource}`);
      update.title = 'Run Pi update; newer-version availability is unknown';
      update.addEventListener('click', () => runAction('update', update));
      actions.append(update);
    }
  } else if (item.kind === 'extension' && item.owner === 'local-extension' && item.codeFile) {
    const file = state.files.find((candidate) => candidate.id === item.source?.fileId);
    const remove = make('button', 'button secondary compact', 'Delete file');
    remove.type = 'button';
    remove.disabled = !canEdit() || !file?.editable;
    remove.title = !canEdit()
      ? 'Read-only workspace'
      : 'Stage this local extension file for deletion';
    remove.setAttribute('aria-label', `Stage deletion of extension ${item.name}`);
    remove.addEventListener('click', async () => {
      if (
        !confirm(
          `Stage deletion of ${file.displayPath}? Other files are not removed. Review dependencies before Apply; running Pi sessions are unchanged.`,
        )
      )
        return;
      remove.disabled = true;
      remove.textContent = 'Staging…';
      const success = await stageProposal({
        intent: 'delete',
        fileId: file.id,
        expectedHash: file.versionHash,
      });
      remove.textContent = success ? 'Deletion staged' : 'Delete file';
      remove.disabled = success;
    });
    actions.append(remove);
  } else
    actions.append(
      make(
        'span',
        'muted',
        item.installationOrigin === 'pi-default'
          ? 'Managed with Pi'
          : item.owner === 'configured-extension-path'
            ? 'Configured path · inspect only'
            : 'Not independently managed',
      ),
    );
  return actions;
}
function renderExtensionTable(list, feedback) {
  const table = make('table', 'resource-table extension-table');
  table.append(make('caption', 'sr-only', 'Extensions and packages with installation provenance'));
  const head = make('thead');
  const headers = make('tr');
  for (const title of ['Name', 'Installation', 'Scope', 'Version', 'Updates', 'Source', 'Actions'])
    headers.append(make('th', '', title));
  head.append(headers);
  table.append(head);
  const body = make('tbody');
  for (const item of list) {
    const row = make('tr');
    row.dataset.origin = item.installationOrigin || 'unattributed';
    const name = make('td');
    name.append(
      link(`/extensions/${encodeURIComponent(item.id)}`, item.name, 'resource-name'),
      make('p', 'muted', item.kind === 'package' ? 'Package' : 'Extension'),
    );
    const source = make('td', 'origin-cell');
    const sourcePath = make(
      'span',
      'resource-origin',
      item.source?.displayPath || `Bundled with Pi ${item.version || ''}`,
    );
    sourcePath.title = sourcePath.textContent;
    source.append(sourcePath);
    const updates =
      item.installationOrigin === 'pi-default'
        ? 'With Pi'
        : !item.packageSource
          ? 'Not package-managed'
          : (item.configScope || item.scope) === 'project'
            ? 'Use Pi directly (project scope)'
            : /^npm:(?:@[^/]+\/)?[^@]+@/.test(item.packageSource)
              ? 'Pinned source'
              : 'Availability unknown';
    const actionCell = make('td', 'row-actions');
    actionCell.append(extensionActions(item, feedback));
    row.append(
      name,
      make('td', '', extensionOrigin(item)),
      make('td', '', item.scope || 'unknown'),
      make('td', 'version-cell', item.version || '—'),
      make('td', 'muted', updates),
      source,
      actionCell,
    );
    body.append(row);
  }
  table.append(body);
  return table;
}
function renderExtensions(id) {
  const candidates = state.resources.filter((item) => ['extension', 'package'].includes(item.kind));
  const list = candidates.filter(
    (item) =>
      !(
        item.kind === 'package' &&
        item.installed &&
        item.packageSource &&
        candidates.some(
          (other) =>
            other.kind === 'package' &&
            !other.installed &&
            other.packageSource === item.packageSource &&
            other.scope === item.scope,
        )
      ),
  );
  const selected = id ? list.find((item) => item.id === id) : null;
  const page = make('div', 'page');
  page.append(
    make('h1', '', 'Extensions & packages'),
    make(
      'p',
      'lead',
      'Package declarations and recognized extension entry files. Code is never loaded to inspect it.',
    ),
  );
  const toolbar = make('div', 'toolbar');
  const search = make('input', 'search');
  search.type = 'search';
  search.placeholder = 'Filter extension and package candidates';
  search.setAttribute('aria-label', 'Filter extension and package candidates');
  const scope = make('select', 'search');
  scope.setAttribute('aria-label', 'Filter extensions and packages by scope');
  for (const [value, label] of [
    ['', 'All scopes'],
    ...[...new Set(list.map((item) => item.scope || 'unknown'))]
      .sort()
      .map((entry) => [entry, entry]),
  ]) {
    const option = make('option', '', label);
    option.value = value;
    scope.append(option);
  }
  search.value = listFilters.get('/extensions')?.query || '';
  scope.value = listFilters.get('/extensions')?.scope || '';
  const count = make('span', 'muted', `${list.length} found`);
  count.setAttribute('role', 'status');
  const origin = make('select', 'search');
  origin.setAttribute('aria-label', 'Filter by installation origin');
  for (const [value, label] of [
    ['', 'All installation origins'],
    ['user', 'User-installed / configured'],
    ['pi-default', 'Pi defaults'],
    ['unattributed', 'Unattributed manifests'],
  ]) {
    const option = make('option', '', label);
    option.value = value;
    origin.append(option);
  }
  origin.value = listFilters.get('/extensions')?.origin || '';
  toolbar.append(search, scope, origin, count);
  page.append(toolbar);
  const layout = make('div', 'content-grid');
  const panelNode = panel(
    `${list.length} candidates`,
    'User provenance comes from settings declarations and matching installed npm manifests or local extension files. Other scanned manifests may be dependencies, not separately installed extensions. Pi defaults are version-verified for Pi 1.4.0; runtime activation is unverified.',
  );
  const feedback = make('pre', 'code-preview package-feedback');
  feedback.setAttribute('aria-label', 'Pi package command result');
  feedback.setAttribute('role', 'status');
  feedback.hidden = true;
  const table = renderExtensionTable(list, feedback);
  panelNode.append(table);
  const empty = make(
    'p',
    'empty-state',
    'No extension or package candidates match the current filters.',
  );
  panelNode.append(empty, feedback);
  panelNode.append(
    make(
      'p',
      'muted package-update-note',
      'Pi has no check-only update command. Update runs immediately after confirmation and may execute package scripts; no newer version is promised. Pinned sources keep their configured version. Project-scoped updates are not exposed by Pi 1.4.0.',
    ),
  );
  const filterRows = () => {
    listFilters.set('/extensions', {
      query: search.value,
      scope: scope.value,
      origin: origin.value,
    });
    const query = search.value.trim().toLowerCase();
    let visible = 0;
    for (const row of table.querySelectorAll<HTMLTableRowElement>('tbody tr')) {
      const matches =
        (!query || row.textContent.toLowerCase().includes(query)) &&
        (!scope.value || row.cells[2]?.textContent.trim() === scope.value) &&
        (!origin.value || row.dataset.origin === origin.value);
      row.hidden = !matches;
      if (matches) visible++;
    }
    count.textContent = `${visible} found`;
    empty.hidden = visible > 0;
    table.hidden = visible === 0;
    const wrapper = table.closest<HTMLElement>('.table-scroll');
    if (wrapper) wrapper.hidden = table.hidden;
  };
  search.addEventListener('input', filterRows);
  scope.addEventListener('change', filterRows);
  origin.addEventListener('change', filterRows);
  filterRows();
  layout.append(panelNode);
  if (selected) {
    const inspector = make('section', 'panel inspector-panel');
    inspector.append(
      link('/extensions', '← Back to list', 'text-link inspector-back'),
      renderResourceDetail(selected),
    );
    const detailFeedback = make('pre', 'code-preview package-feedback');
    detailFeedback.setAttribute('role', 'status');
    detailFeedback.hidden = true;
    inspector.append(extensionActions(selected, detailFeedback), detailFeedback);
    layout.append(inspector);
  }
  page.append(layout);
  if (canEdit()) {
    const actions = panel(
      'Pi package manager',
      'Install/update can download third-party code and run package lifecycle scripts. This action is outside the file changeset transaction and never auto-approves project trust.',
    );
    const operation = selectField(actions, 'Operation', [
      ['list', 'List configured packages'],
      ['install', 'Install source'],
      ['update', 'Update source'],
      ['remove', 'Remove source'],
    ]);
    const scope = selectField(
      actions,
      'Scope',
      [
        ['global', 'Global'],
        ['project', 'Project'],
      ],
      state.env.mode === 'global' ? 'global' : 'project',
    );
    const projectOption = [...scope.options].find((option) => option.value === 'project');
    operation.addEventListener('change', () => {
      if (operation.value === 'update') {
        scope.value = 'global';
        projectOption.disabled = true;
      } else projectOption.disabled = false;
    });
    const source = labeledInput(
      actions,
      'Package source (npm:, git:, HTTPS/SSH, or project-local path)',
    );
    operation.addEventListener('change', () => {
      source.disabled = operation.value === 'list';
    });
    source.disabled = operation.value === 'list';
    const run = make('button', 'button', 'Review and run Pi package command');
    run.type = 'button';
    run.addEventListener('click', async () => {
      if (run.disabled) return;
      if (
        operation.value !== 'list' &&
        !confirm(
          `${operation.value} ${source.value} can run third-party package code. Continue without granting project trust?`,
        )
      )
        return;
      run.disabled = true;
      run.textContent = 'Running Pi package command…';
      try {
        const result = await mutate('/api/packages/action', {
          operation: operation.value,
          source: operation.value === 'list' ? undefined : source.value.trim() || undefined,
          scope: scope.value,
          confirmed: true,
        });
        const output = panel(
          `${result.command} · exit ${result.exitCode}`,
          result.warning || 'Installed Pi command output is redacted.',
        );
        if (result.stdout) output.append(make('pre', 'code-preview', result.stdout));
        if (result.stderr) output.append(make('pre', 'code-preview', result.stderr));
        actions.append(output);
        if (result.exitCode === 0 && operation.value !== 'list') await load();
      } catch (error) {
        notify(error.message);
      } finally {
        run.disabled = false;
        run.textContent = 'Review and run Pi package command';
      }
    });
    actions.append(run);
    page.append(actions);
  }
  return page;
}
function render({
  scroll = window.scrollY,
  focus = false,
}: { scroll?: number; focus?: boolean } = {}) {
  const path = currentPath();
  const section = sections.find(([href]) => href === '/' + path.split('/')[1]);
  document.getElementById('section-label').textContent = section?.[1] || 'Workspace';
  document.title = `${section?.[1] || 'Workspace'} · Pinotator`;
  updateStagedCount(
    state.changes.filter((change) => !['applied', 'rolled_back'].includes(change.status)).length,
  );
  document.querySelectorAll('.nav-link').forEach((a) => {
    const active =
      a.getAttribute('href') ===
      (path === '/extensions' ? '/extensions' : '/' + path.split('/')[1]);
    a.classList.toggle('active', active);
    if (active) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  // Reveal the active item by scrolling only the sidebar, never its ancestors.
  const sidebarScroll = document.querySelector<HTMLElement>('.sidebar-scroll');
  const activeLink = sidebarScroll?.querySelector<HTMLElement>('.nav-link.active');
  if (sidebarScroll && activeLink) {
    const container = sidebarScroll.getBoundingClientRect();
    const item = activeLink.getBoundingClientRect();
    if (item.top < container.top) sidebarScroll.scrollTop += item.top - container.top - 8;
    else if (item.bottom > container.bottom)
      sidebarScroll.scrollTop += item.bottom - container.bottom + 8;
  }
  const route = routeContext(path);
  let node: HTMLElement;
  if (route.page === 'list' && ['/models', '/providers'].includes(route.root) && !providerCatalog)
    node = renderProviderLoading();
  else if (route.page === 'dashboard') node = renderDashboard();
  else if (route.page === 'instructions') node = renderInstructions();
  else if (route.page === 'sources') node = renderSources();
  else if (route.page === 'source') node = renderSources(route.id);
  else if (route.page === 'diagnostics') node = renderDiagnostics();
  else if (route.page === 'keybindings') node = renderKeybindings();
  else if (route.page === 'changes') node = renderChanges();
  else if (route.page === 'snapshots') node = renderSnapshots();
  else if (route.page === 'effective') node = renderEffectiveRuntime();
  else if (route.page === 'analysis') node = renderAnalysis();
  else if (route.page === 'companion') node = renderCompanion();
  else if (route.page === 'migration') node = renderMigration();
  else if (route.page === 'templates') node = renderTemplates();
  else if (route.page === 'extensions') node = renderExtensions(route.id);
  else if (route.page === 'list') {
    if (route.root === '/extensions') node = renderExtensions(route.id);
    else if (route.root === '/settings') {
      node = renderResourceList(route.root, 'setting', route.id);
    } else node = renderResourceList(route.root, kindForPath[route.root], route.id);
  } else {
    node = make('div', 'page');
    node.append(make('h1', '', route.title), make('p', '', route.message));
  }
  // Normalize page introductions so all headings share exactly the same rhythm.
  const intro = make('header', 'page-header');
  while (node.firstElementChild?.matches('h1, .lead')) intro.append(node.firstElementChild);
  const pageActions = node.querySelector(':scope > .page-actions');
  if (pageActions) intro.append(pageActions);
  if (intro.childElementCount) node.prepend(intro);
  for (const table of node.querySelectorAll<HTMLTableElement>('table.resource-table')) {
    const wrapper = make('div', 'table-scroll');
    wrapper.tabIndex = 0;
    wrapper.hidden = table.hidden;
    wrapper.setAttribute('role', 'region');
    wrapper.setAttribute(
      'aria-label',
      table.querySelector('caption')?.textContent || 'Resource table',
    );
    table.replaceWith(wrapper);
    wrapper.append(table);
    for (const header of table.querySelectorAll('thead th')) header.setAttribute('scope', 'col');
    for (const anchor of table.querySelectorAll<HTMLAnchorElement>('a.resource-name')) {
      if (new URL(anchor.href).pathname === location.pathname) {
        anchor.setAttribute('aria-current', 'true');
        anchor.closest('tr')?.classList.add('is-selected');
      }
    }
  }
  main.replaceChildren(node);
  if (focus) main.focus({ preventScroll: true });
  window.scrollTo({ top: scroll, left: 0, behavior: 'instant' });
}

document.addEventListener('click', (event) => {
  if (!(event.target instanceof Element)) return;
  const anchor = event.target.closest('a');
  if (
    !anchor ||
    anchor.hasAttribute('download') ||
    (anchor.target && anchor.target !== '_self') ||
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  )
    return;
  const target = new URL(anchor.href, location.href);
  if (target.origin !== location.origin || !target.pathname.startsWith('/') || target.hash) return;
  event.preventDefault();
  navigate(`${target.pathname}${target.search}`);
});
window.addEventListener('popstate', () => {
  render({ scroll: history.state?.scrollY ?? 0, focus: true });
  refreshPendingExternalChanges();
});
document.getElementById('refresh').addEventListener('click', async () => {
  const button = document.getElementById('refresh') as HTMLButtonElement;
  if (button.disabled) return;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  try {
    const response = await fetch('/api/refresh', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'x-pinotator-csrf': '1' },
    });
    if (!response.ok) throw new Error(`Refresh failed (${response.status})`);
    externalRefreshPending = false;
    state.effectiveRuntime = null;
    await load();
    notify('Local inventory refreshed. No code was executed.');
  } catch (error) {
    notify(error.message);
  } finally {
    button.disabled = false;
    button.removeAttribute('aria-busy');
  }
});
const events = new EventSource('/api/events');
events.addEventListener('source_changed', () => {
  const active = document.activeElement;
  if (
    (active instanceof Element &&
      active !== main &&
      (main.contains(active) ||
        active.closest(
          '[data-slot="select-content"], .model-picker-popover, [data-slot="dialog-content"]',
        ))) ||
    main.querySelector('form[data-dirty="true"]')
  ) {
    externalRefreshPending = true;
    state.effectiveRuntime = null;
    notify(
      'External changes detected. Current controls are preserved; navigate away or use Refresh to reload.',
    );
    return;
  }
  state.effectiveRuntime = null;
  load().catch(showError);
});
events.addEventListener('refresh_failed', () => {
  notify('Inventory refresh failed. Use Refresh to retry.');
});
function showError(error) {
  if (state.env) {
    notify(
      `Inventory update failed. Displayed configuration may be out of date. Use Refresh to retry. ${error.message}`,
    );
    return;
  }
  const section = make('section', 'panel');
  section.setAttribute('role', 'alert');
  section.append(
    make('h1', '', 'Configuration could not be loaded'),
    make('p', 'muted', `The local request failed: ${error.message}. No files were changed.`),
  );
  const retry = make('button', 'button', 'Retry loading configuration');
  retry.type = 'button';
  retry.addEventListener('click', async () => {
    retry.disabled = true;
    retry.textContent = 'Retrying…';
    try {
      await load();
      main.focus({ preventScroll: true });
    } catch (nextError) {
      showError(nextError);
      main.querySelector<HTMLButtonElement>('button')?.focus();
    }
  });
  section.append(retry);
  main.replaceChildren(section);
}
const initialScroll = history.state?.scrollY ?? 0;
load()
  .then(() => window.scrollTo({ top: initialScroll, behavior: 'instant' }))
  .catch(showError);
