import { useRef, useState } from 'react';
import { ArrowUpRight, CornerDownLeft, Keyboard, RefreshCw } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from './ui/dialog.js';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from './ui/command.js';

export interface PaletteAction {
  label: string;
  path?: string;
  refresh?: boolean;
  help?: boolean;
}

const shortcuts = [
  ['⌘ / Ctrl K', 'Open command palette'],
  ['⌘ / Ctrl S', 'Stage the focused editor (never apply)'],
  ['/', 'Focus the current list search'],
  ['G then D / A / S / M', 'Go to Overview / Agents / Skills / Models'],
  ['⌘ / Ctrl ⇧ Enter', 'Review staged changes'],
  ['J / K', 'Next / previous resource in a focused list'],
  ['?', 'Show keyboard shortcuts'],
  ['Esc', 'Close the current dialog'],
];

export function CommandPalette({
  initialMode,
  actions,
  enabled,
  onEnabledChange,
  onAction,
  returnFocus,
}: {
  initialMode: string;
  actions: PaletteAction[];
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  onAction: (action: PaletteAction) => void;
  returnFocus: HTMLElement | null;
}) {
  const [open, setOpen] = useState(true);
  const [mode, setMode] = useState(initialMode);
  const [query, setQuery] = useState('');
  const [shortcutsOn, setShortcutsOn] = useState(enabled);
  const selectedAction = useRef(false);
  const help = mode === 'shortcuts';
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        className="palette-dialog"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const target = selectedAction.current ? document.getElementById('main') : returnFocus;
          (target?.isConnected ? target : document.getElementById('palette-open'))?.focus({
            preventScroll: true,
          });
        }}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>{help ? 'Keyboard shortcuts' : 'Command palette'}</DialogTitle>
          <DialogDescription>
            Search pages and actions. Use the arrow keys to navigate and Enter to select.
          </DialogDescription>
        </DialogHeader>
        <Command>
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder={help ? 'Find a shortcut…' : 'Where would you like to go?'}
            aria-label={help ? 'Filter keyboard shortcuts' : 'Search commands and pages'}
          />
          {help && (
            <label className="shortcut-setting palette-shortcut-toggle">
              Enable keyboard shortcuts
              <input
                type="checkbox"
                checked={shortcutsOn}
                onChange={(event) => {
                  setShortcutsOn(event.target.checked);
                  onEnabledChange(event.target.checked);
                }}
              />
            </label>
          )}
          <CommandList>
            <CommandEmpty>
              No matching {help ? 'shortcuts' : 'commands'}. Try another search.
            </CommandEmpty>
            {help ? (
              <CommandGroup heading="Keyboard shortcuts">
                {shortcuts.map(([key, label]) => (
                  <CommandItem key={key} value={`${key} ${label}`} className="palette-shortcut">
                    <span>{label}</span>
                    <kbd>{key}</kbd>
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : (
              <>
                <CommandGroup heading="Navigate">
                  {actions
                    .filter((action) => action.label.startsWith('Go to '))
                    .map((action) => (
                      <CommandItem
                        key={action.label}
                        onSelect={() => {
                          selectedAction.current = true;
                          setOpen(false);
                          onAction(action);
                        }}
                      >
                        <ArrowUpRight />
                        <span>{action.label.replace('Go to ', '')}</span>
                      </CommandItem>
                    ))}
                </CommandGroup>
                <CommandGroup heading="Actions">
                  {actions
                    .filter((action) => !action.label.startsWith('Go to '))
                    .map((action) => (
                      <CommandItem
                        key={action.label}
                        onSelect={() => {
                          if (action.help) {
                            setMode('shortcuts');
                            setQuery('');
                            return;
                          }
                          selectedAction.current = true;
                          setOpen(false);
                          onAction(action);
                        }}
                      >
                        {action.refresh ? (
                          <RefreshCw />
                        ) : action.help ? (
                          <Keyboard />
                        ) : (
                          <ArrowUpRight />
                        )}
                        <span>{action.label}</span>
                      </CommandItem>
                    ))}
                </CommandGroup>
              </>
            )}
          </CommandList>
          <div className="palette-footer">
            <span>
              <kbd>↑</kbd>
              <kbd>↓</kbd> to navigate
            </span>
            <span>
              <CornerDownLeft size={12} /> to select
            </span>
            <span>
              <kbd>esc</kbd> to close
            </span>
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
