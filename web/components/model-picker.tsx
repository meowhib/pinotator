import { useEffect, useState } from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';
import type { ModelCatalog } from '../../src/model-catalog.js';
import { loadModelCatalog } from '../lib/model-catalog.js';
import { Button } from './ui/button.js';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover.js';
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from './ui/command.js';

export function ModelPicker({
  value: initialValue,
  onChange,
  id,
}: {
  value: string;
  onChange: (value: string) => void;
  id?: string;
}) {
  const [value, setValue] = useState(initialValue === 'inherit' ? '' : initialValue);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [catalog, setCatalog] = useState<ModelCatalog>();
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    loadModelCatalog()
      .then((data) => {
        if (active) setCatalog(data);
      })
      .catch(() => {
        if (active)
          setError('Catalog unavailable. You can still enter a provider/model reference.');
      });
    return () => {
      active = false;
    };
  }, []);
  const terms = query.toLowerCase().trim().split(/\s+/);
  const matches = (catalog?.models || [])
    .filter((model) =>
      terms.every((term) => `${model.name} ${model.ref}`.toLowerCase().includes(term)),
    )
    .sort((a, b) => Number(terms.includes(b.provider)) - Number(terms.includes(a.provider)));
  const selected = catalog?.models.find((model) => model.ref === value);
  const choose = (next: string) => {
    setValue(next);
    onChange(next);
    setOpen(false);
    setQuery('');
  };
  const custom = query.trim();
  return (
    <div className="model-picker">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            id={id}
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            aria-label="Model (optional)"
            className="model-picker-trigger"
            title={value || 'Inherit the parent model'}
          >
            <span>
              {selected
                ? `${selected.name} · ${selected.provider}`
                : value || 'Inherit the parent model'}
            </span>
            <ChevronsUpDown />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="model-picker-popover"
          aria-label="Choose agent model"
        >
          <Command shouldFilter={false}>
            <CommandInput
              placeholder="Search models or providers…"
              aria-label="Search models or enter provider/model"
              value={query}
              onValueChange={setQuery}
            />
            <CommandList>
              <CommandEmpty>
                {catalog
                  ? 'No matching models. Enter provider/model to use a custom reference.'
                  : error || 'Loading the local Pi catalog…'}
              </CommandEmpty>
              {(!query.trim() || 'inherit parent model'.includes(query.toLowerCase())) && (
                <CommandItem value="inherit" onSelect={() => choose('')}>
                  <Check className={value ? 'opacity-0' : ''} />
                  <span>
                    Inherit the parent model<small>No model override is written.</small>
                  </span>
                </CommandItem>
              )}
              {matches.slice(0, 80).map((model) => (
                <CommandItem key={model.ref} value={model.ref} onSelect={() => choose(model.ref)}>
                  <Check className={value === model.ref ? '' : 'opacity-0'} />
                  <span className="model-option-name">
                    {model.name}
                    <small>{model.id}</small>
                  </span>
                  <span className="model-option-provider">{model.provider}</span>
                </CommandItem>
              ))}
              {/^[^\s/]+\/\S+$/.test(custom) && !matches.some((model) => model.ref === custom) && (
                <CommandItem value={`custom-${custom}`} onSelect={() => choose(custom)}>
                  Use custom reference: {custom}
                </CommandItem>
              )}
            </CommandList>
            {matches.length > 80 && (
              <p className="model-picker-help">
                Showing 80 of {matches.length}. Refine your search.
              </p>
            )}
          </Command>
        </PopoverContent>
      </Popover>
      <p className="muted">
        Optional. Leave inherited or choose a model with its provider.{' '}
        {error ||
          (catalog && !catalog.available
            ? catalog.message
            : 'The local catalog is offline; model availability is not inferred.')}
      </p>
    </div>
  );
}
