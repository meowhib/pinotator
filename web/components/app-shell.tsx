import { useEffect, useState } from 'react';
import {
  ChevronRight,
  Folder,
  Menu,
  Monitor,
  Moon,
  RefreshCw,
  Search,
  ShieldCheck,
  Sun,
} from 'lucide-react';
import { Brand, Navigation } from '../navigation.js';
import { applyTheme, getTheme, type Theme } from '../lib/theme.js';
import { Button } from './ui/button.js';
import { Badge } from './ui/badge.js';
import { Toaster } from './toaster.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu.js';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from './ui/sheet.js';

function ThemePicker() {
  const [theme, setTheme] = useState<Theme>(getTheme);
  useEffect(() => {
    applyTheme(theme);
    const media = matchMedia('(prefers-color-scheme: dark)');
    const update = () => applyTheme(theme);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [theme]);
  const Icon = theme === 'system' ? Monitor : theme === 'dark' ? Moon : Sun;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Choose color theme"
          title="Choose color theme"
        >
          <Icon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuLabel>Appearance</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup
          value={theme}
          onValueChange={(value) => {
            const next = value as Theme;
            applyTheme(next);
            setTheme(next);
            try {
              localStorage.setItem('pinotator.theme', next);
            } catch {
              /* Optional preference. */
            }
          }}
        >
          <DropdownMenuRadioItem value="light">
            <Sun />
            Light
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">
            <Moon />
            Dark
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system">
            <Monitor />
            System
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function MobileNavigation() {
  const [open, setOpen] = useState(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" className="mobile-menu" aria-label="Open navigation">
          <Menu />
        </Button>
      </SheetTrigger>
      <SheetContent side="left" className="mobile-navigation">
        <SheetHeader>
          <SheetTitle>Pinotator</SheetTitle>
          <SheetDescription>Your local Pi workspace</SheetDescription>
        </SheetHeader>
        <Navigation onNavigate={() => setOpen(false)} />
      </SheetContent>
    </Sheet>
  );
}

export function AppShell() {
  return (
    <>
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <aside className="sidebar" aria-label="Workspace navigation">
        <div className="sidebar-brand">
          <Brand />
          <Badge variant="outline" className="local-badge">
            LOCAL
          </Badge>
        </div>
        <div className="sidebar-scroll">
          <Navigation />
        </div>
        <div className="sidebar-foot">
          <div className="safety-label">
            <ShieldCheck size={16} aria-hidden="true" />
            <strong>Local & private</strong>
          </div>
          <span id="mode-label">Local workspace</span>
          <span id="safe-mode">Static inspection. No code execution.</span>
        </div>
      </aside>
      <div className="workspace-shell">
        <header className="topbar">
          <MobileNavigation />
          <div className="context">
            <Folder size={16} className="workspace-icon" aria-hidden="true" />
            <span className="workspace-label">Workspace</span>
            <ChevronRight size={14} className="workspace-chevron" aria-hidden="true" />
            <span id="cwd" title="Working directory">
              Loading workspace…
            </span>
          </div>
          <div className="topbar-actions">
            <Button
              id="palette-open"
              variant="outline"
              className="palette-trigger"
              aria-keyshortcuts="Control+K Meta+K"
              aria-label="Open command palette"
            >
              <Search />
              <span>Search anything…</span>
              <kbd>⌘ K</kbd>
            </Button>
            <Button
              id="refresh"
              variant="ghost"
              size="icon"
              aria-label="Refresh inventory"
              title="Refresh inventory"
            >
              <RefreshCw />
            </Button>
            <span className="topbar-divider" aria-hidden="true" />
            <ThemePicker />
          </div>
        </header>
        <div className="workspace-status" role="region" aria-label="Workspace context">
          <span className="workspace-status-label">
            <span className="status-dot" />
            Local configuration<span className="status-slash">/</span>
            <span id="section-label">Overview</span>
          </span>
          <div className="workspace-badges">
            <Badge id="pi-version" variant="outline">
              Pi …
            </Badge>
            <span id="trust" className="pill">
              Trust …
            </span>
          </div>
        </div>
        <main id="main" tabIndex={-1}>
          <div className="loading" role="status">
            <span className="loading-spinner" />
            Loading local Pi configuration…
          </div>
        </main>
        <footer className="workspace-footer">
          <span>Pinotator · Your files remain the source of truth.</span>
          <span>Local-first. Always.</span>
        </footer>
      </div>
      <Toaster />
    </>
  );
}
