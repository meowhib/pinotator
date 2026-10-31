import { useLayoutEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select.js';
import { ModelPicker } from '../components/model-picker.js';
import { textareaStyles } from '../components/ui/textarea.js';

const encode = (value: string) => `option:${value}`;
function SelectControl({
  select,
  label,
  triggerId,
}: {
  select: HTMLSelectElement;
  label: string;
  triggerId: string;
}) {
  const read = () => ({
    value: select.value,
    disabled: select.disabled,
    options: [...select.options].map((option) => ({
      value: option.value,
      label: option.label,
      disabled:
        option.disabled ||
        (option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled),
      group: option.parentElement instanceof HTMLOptGroupElement ? option.parentElement.label : '',
    })),
  });
  const [snapshot, setSnapshot] = useState(read);
  useLayoutEffect(() => {
    const sync = () => setSnapshot(read());
    const observer = new MutationObserver(sync);
    observer.observe(select, {
      attributes: true,
      childList: true,
      subtree: true,
      characterData: true,
    });
    select.addEventListener('change', sync);
    // Existing controllers set .value/.selectedIndex directly (without a DOM
    // mutation or a change event). Keep the shadcn presentation synchronized.
    for (const property of ['value', 'selectedIndex']) {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, property);
      Object.defineProperty(select, property, {
        configurable: true,
        get() {
          return descriptor.get.call(this);
        },
        set(value) {
          descriptor.set.call(this, value);
          sync();
        },
      });
    }
    const invalid = (event: Event) => {
      event.preventDefault();
      document.getElementById(triggerId)?.focus();
    };
    select.addEventListener('invalid', invalid);
    return () => {
      observer.disconnect();
      select.removeEventListener('change', sync);
      select.removeEventListener('invalid', invalid);
      delete select['value'];
      delete select['selectedIndex'];
    };
  }, [select]);
  const groups = [...new Set(snapshot.options.map((option) => option.group))];
  return (
    <Select
      value={encode(snapshot.value)}
      disabled={snapshot.disabled}
      onValueChange={(encoded) => {
        select.value = encoded.slice('option:'.length);
        if (select.form) select.form.dataset.dirty = 'true';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }}
    >
      <SelectTrigger
        id={triggerId}
        aria-label={label}
        aria-required={select.required || undefined}
        className="select-trigger"
      >
        <SelectValue placeholder="Choose an option" />
      </SelectTrigger>
      <SelectContent position="popper" className="select-menu">
        {groups.map((group) => (
          <SelectGroup key={group}>
            {group && <SelectLabel>{group}</SelectLabel>}
            {snapshot.options
              .filter((option) => option.group === group)
              .map((option) => (
                <SelectItem
                  key={option.value}
                  value={encode(option.value)}
                  disabled={option.disabled}
                >
                  {option.label || 'None'}
                </SelectItem>
              ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}

// React owns only these dedicated hosts. Controllers retain the original
// controls as their value/validation interface; no application-wide prototype
// patching, native dropdown UI, or stale roots after navigation.
export function installFormControls(container: HTMLElement) {
  const mounted = new Map<HTMLElement, { host: HTMLElement; root: Root }>();
  let nextId = 0;
  const scan = () => {
    for (const [control, record] of mounted)
      if (!container.contains(control)) {
        record.root.unmount();
        mounted.delete(control);
      }
    for (const textarea of container.querySelectorAll('textarea')) {
      textarea.dataset.slot = 'textarea';
      textarea.classList.add(...textareaStyles.split(' '));
    }
    for (const control of container.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
      'select, input[data-model-picker]',
    )) {
      if (
        mounted.has(control) ||
        control.closest('[data-shadcn-control]') ||
        control.getAttribute('aria-hidden') === 'true'
      )
        continue;
      const host = document.createElement('div');
      host.dataset.shadcnControl = '';
      host.className =
        control instanceof HTMLSelectElement
          ? `select-control ${control.className}`
          : 'model-control';
      const triggerId = control.id || `pinotator-control-${++nextId}`;
      const label =
        control.getAttribute('aria-label') ||
        [...(control.labels?.[0]?.childNodes || [])]
          .filter((node) => node.nodeType === Node.TEXT_NODE || node instanceof HTMLSpanElement)
          .map((node) => node.textContent)
          .join(' ')
          .trim() ||
        'Choose an option';
      if (control.id) control.id += '-native';
      if (control.labels?.[0]) control.labels[0].htmlFor = triggerId;
      else if (control.parentElement instanceof HTMLLabelElement)
        control.parentElement.htmlFor = triggerId;
      control.before(host);
      control.hidden = true;
      control.tabIndex = -1;
      control.setAttribute('aria-hidden', 'true');
      const root = createRoot(host);
      mounted.set(control, { host, root });
      flushSync(() =>
        root.render(
          control instanceof HTMLSelectElement ? (
            <SelectControl select={control} label={label} triggerId={triggerId} />
          ) : (
            <ModelPicker
              id={triggerId}
              value={control.value}
              onChange={(value) => {
                control.value = value;
                if (control.form) control.form.dataset.dirty = 'true';
                control.dispatchEvent(new Event('input', { bubbles: true }));
              }}
            />
          ),
        ),
      );
    }
  };
  const markDirty = (event: Event) => {
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      target.getAttribute('aria-hidden') !== 'true' &&
      target.closest('form')
    )
      target.closest('form').dataset.dirty = 'true';
  };
  container.addEventListener('input', markDirty);
  container.addEventListener('change', markDirty);
  const observer = new MutationObserver(scan);
  observer.observe(container, { childList: true, subtree: true });
  scan();
  return () => {
    observer.disconnect();
    container.removeEventListener('input', markDirty);
    container.removeEventListener('change', markDirty);
    mounted.forEach((record) => record.root.unmount());
    mounted.clear();
  };
}
