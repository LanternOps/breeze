// FilterChipBar - top-bar of filter chips, NinjaOne style.
//
// Each chip = one FilterCondition inside the top-level AND group.
// Click chip → popover with operator + value editor. X → remove chip.
// "+ Add filter" at end opens the FilterAddDropdown field picker.
//
// State shape passed up: FilterConditionGroup with operator='AND' and
// conditions=FilterCondition[]. Nested groups / OR top-level groups force
// the UI into Advanced mode (sentence builder) per spec 4.3.
import { useCallback, useEffect, useRef, useState } from 'react';
import { X, ListTree, Boxes, Keyboard } from 'lucide-react';
import type {
  FilterCondition,
  FilterConditionGroup,
  FilterFieldDefinition
} from '@breeze/shared';
import { getFieldDef, V2_FILTER_FIELDS } from './filterFields';
import { FilterAddDropdown } from './FilterAddDropdown';
import { FilterValueEditor, summarizeCondition, type NamedRef } from './FilterValueEditor';
import { FilterPreviewFooter } from './FilterPreviewFooter';
import { FilterSentenceBuilder, isChipRenderable } from './FilterSentenceBuilder';
import { FilterHelpPopover } from './FilterHelpPopover';

export interface FilterChipBarProps {
  value: FilterConditionGroup | null;
  onChange: (next: FilterConditionGroup | null) => void;
  // Spec 4.1 — passed through to FilterValueEditor for name lookups.
  orgs?: NamedRef[];
  sites?: NamedRef[];
  // Spec 4.2 — passed through for software multi-select. Optional; if
  // undefined the editor falls back to comma-separated text input.
  softwareOptions?: string[];
  softwareOptionCounts?: Record<string, number>;
  // Spec 4.12 — `Ctrl+S` invokes save. Parent owns saved-filter state, so
  // this callback is fired with the current group (parent prompts for name).
  onSaveRequested?: (group: FilterConditionGroup) => void;
}

const EMPTY_GROUP: FilterConditionGroup = { operator: 'AND', conditions: [] };

function defaultConditionForField(field: FilterFieldDefinition): FilterCondition {
  const op = field.operators[0];
  let value: FilterCondition['value'] = '';
  if (op === 'in' || op === 'notIn' || op === 'hasAny' || op === 'hasAll') value = [];
  else if (op === 'withinLast' || op === 'notWithinLast') value = { amount: 7, unit: 'days' };
  else if (field.type === 'number') value = 0;
  else if (field.type === 'enum' && field.enumValues?.length) value = field.enumValues[0];
  return { field: field.key, operator: op, value };
}

export function FilterChipBar({
  value, onChange, orgs, sites, softwareOptions, softwareOptionCounts, onSaveRequested
}: FilterChipBarProps) {
  const group = value ?? EMPTY_GROUP;
  const chips: FilterCondition[] = group.conditions.filter(
    (c): c is FilterCondition => !('conditions' in c)
  );

  // Mode: 'chip' or 'advanced' (spec 4.3). Default to chip when state is
  // chip-renderable; force advanced when not. The toggle is hidden when the
  // current state can't be downgraded back to chip mode.
  const renderableNow = isChipRenderable(value);
  const [mode, setMode] = useState<'chip' | 'advanced'>(renderableNow ? 'chip' : 'advanced');
  useEffect(() => {
    if (!renderableNow && mode === 'chip') setMode('advanced');
  }, [renderableNow, mode]);

  // Focus + keyboard state (spec 4.12).
  const rootRef = useRef<HTMLDivElement>(null);
  const chipBtnRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [focusedChipIdx, setFocusedChipIdx] = useState(-1);
  const [helpOpen, setHelpOpen] = useState(false);

  // Global key handler. Only acts when no text field has focus (so `/` in an
  // input still types a slash). Esc and `?` work even if the bar has focus.
  useEffect(() => {
    const isEditable = (el: EventTarget | null): boolean => {
      if (!(el instanceof HTMLElement)) return false;
      const tag = el.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (helpOpen) { setHelpOpen(false); e.preventDefault(); }
        // Individual popovers close themselves via document mousedown; Esc
        // just blurs to give a similar effect.
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        return;
      }
      if (e.key === '?' && !isEditable(e.target)) {
        setHelpOpen(o => !o);
        e.preventDefault();
        return;
      }
      if (e.key === '/' && !isEditable(e.target)) {
        rootRef.current?.querySelector<HTMLElement>('[data-testid="filter-add-button"]')?.focus();
        e.preventDefault();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
        // Only intercept when the bar has focus (so global Ctrl+S elsewhere
        // still works as the browser's save).
        if (rootRef.current?.contains(document.activeElement) && onSaveRequested && value) {
          e.preventDefault();
          onSaveRequested(value);
        }
        return;
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [helpOpen, onSaveRequested, value]);

  // Arrow-key navigation between chips when one is focused.
  const onChipKeyDown = (e: React.KeyboardEvent, i: number) => {
    if (e.key === 'ArrowRight') {
      const next = Math.min(i + 1, chips.length - 1);
      chipBtnRefs.current[next]?.focus();
      setFocusedChipIdx(next);
      e.preventDefault();
    } else if (e.key === 'ArrowLeft') {
      const prev = Math.max(i - 1, 0);
      chipBtnRefs.current[prev]?.focus();
      setFocusedChipIdx(prev);
      e.preventDefault();
    }
  };

  const handleAdd = useCallback((field: FilterFieldDefinition) => {
    const next: FilterConditionGroup = {
      operator: 'AND',
      conditions: [...group.conditions, defaultConditionForField(field)]
    };
    onChange(next);
  }, [group, onChange]);

  const handleUpdate = (idx: number, c: FilterCondition) => {
    const nextConds = group.conditions.slice();
    let chipSeen = -1;
    for (let i = 0; i < nextConds.length; i++) {
      const item = nextConds[i];
      if (!('conditions' in item)) {
        chipSeen++;
        if (chipSeen === idx) {
          nextConds[i] = c;
          break;
        }
      }
    }
    onChange({ operator: 'AND', conditions: nextConds });
  };

  const handleRemove = (idx: number) => {
    const nextConds: typeof group.conditions = [];
    let chipSeen = -1;
    for (const item of group.conditions) {
      if (!('conditions' in item)) {
        chipSeen++;
        if (chipSeen === idx) continue;
      }
      nextConds.push(item);
    }
    onChange(nextConds.length === 0 ? null : { operator: 'AND', conditions: nextConds });
  };

  const handleClear = () => onChange(null);

  return (
    <div ref={rootRef} data-testid="filter-chip-bar-root" className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <div className="inline-flex overflow-hidden rounded border text-xs">
          <button
            type="button"
            data-testid="filter-mode-chip"
            onClick={() => setMode('chip')}
            disabled={!renderableNow}
            title={renderableNow ? 'Chip mode' : 'Disabled — current filter has nested groups'}
            className={`flex items-center gap-1 px-2 py-0.5 ${mode === 'chip' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'} disabled:opacity-40`}
          >
            <Boxes className="h-3 w-3" /> Chip
          </button>
          <button
            type="button"
            data-testid="filter-mode-advanced"
            onClick={() => setMode('advanced')}
            className={`flex items-center gap-1 px-2 py-0.5 ${mode === 'advanced' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}
          >
            <ListTree className="h-3 w-3" /> Advanced
          </button>
        </div>
        <button
          type="button"
          onClick={() => setHelpOpen(o => !o)}
          aria-label="Show filter shortcuts"
          data-testid="filter-help-toggle"
          className="rounded p-1 text-muted-foreground hover:text-foreground"
        >
          <Keyboard className="h-3.5 w-3.5" />
        </button>
      </div>

      {mode === 'chip' ? (
        <div data-testid="filter-chip-bar" className="flex flex-wrap items-center gap-2 rounded-md border bg-card p-2">
          {chips.map((c, i) => (
            <Chip
              key={i}
              condition={c}
              onChange={next => handleUpdate(i, next)}
              onRemove={() => handleRemove(i)}
              orgs={orgs}
              sites={sites}
              softwareOptions={softwareOptions}
              softwareOptionCounts={softwareOptionCounts}
              btnRef={el => { chipBtnRefs.current[i] = el; }}
              onKeyDown={(e) => onChipKeyDown(e, i)}
              focused={focusedChipIdx === i}
            />
          ))}
          <FilterAddDropdown onSelect={handleAdd} />
          {chips.length > 0 && (
            <button
              type="button"
              data-testid="filter-clear-all"
              onClick={handleClear}
              className="ml-auto text-xs text-muted-foreground hover:text-foreground"
            >
              Clear all
            </button>
          )}
        </div>
      ) : (
        <FilterSentenceBuilder
          value={value ?? EMPTY_GROUP}
          onChange={(g) => onChange(g.conditions.length === 0 ? null : g)}
          orgs={orgs}
          sites={sites}
          softwareOptions={softwareOptions}
          softwareOptionCounts={softwareOptionCounts}
          onSaveRequested={onSaveRequested}
        />
      )}

      <FilterHelpPopover open={helpOpen} onClose={() => setHelpOpen(false)} />
    </div>
  );
}

interface ChipProps {
  condition: FilterCondition;
  onChange: (c: FilterCondition) => void;
  onRemove: () => void;
  orgs?: NamedRef[];
  sites?: NamedRef[];
  softwareOptions?: string[];
  softwareOptionCounts?: Record<string, number>;
  btnRef?: (el: HTMLButtonElement | null) => void;
  onKeyDown?: (e: React.KeyboardEvent) => void;
  focused?: boolean;
}

function Chip({ condition, onChange, onRemove, orgs, sites, softwareOptions, softwareOptionCounts, btnRef, onKeyDown, focused }: ChipProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const field = getFieldDef(condition.field)
    ?? V2_FILTER_FIELDS.find(f => f.key === condition.field);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  // Esc closes the popover when chip focused.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  if (!field) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border bg-muted px-2 py-0.5 text-xs">
        unknown: {condition.field}
        <button type="button" onClick={onRemove} aria-label="Remove">
          <X className="h-3 w-3" />
        </button>
      </span>
    );
  }

  // Preview footer needs the chip wrapped as a single-condition AND-group.
  const previewGroup: FilterConditionGroup = { operator: 'AND', conditions: [condition] };

  return (
    <div ref={ref} className="relative">
      <span className={`inline-flex items-center gap-1 rounded-full border bg-primary/10 px-2 py-0.5 text-xs text-foreground ${focused ? 'ring-2 ring-primary' : ''}`}>
        <button
          type="button"
          ref={btnRef}
          onKeyDown={onKeyDown}
          data-testid={`filter-chip-${field.key}`}
          onClick={() => setOpen(o => !o)}
          className="hover:underline"
        >
          {summarizeCondition(field, condition, { orgs, sites })}
        </button>
        <button
          type="button"
          data-testid={`filter-chip-remove-${field.key}`}
          onClick={onRemove}
          aria-label={`Remove ${field.label}`}
          className="hover:text-destructive"
        >
          <X className="h-3 w-3" />
        </button>
      </span>

      {open && (
        <div className="absolute left-0 top-7 z-30 w-72 rounded-md border bg-popover p-3 shadow-lg" role="dialog">
          <div className="mb-2 text-sm font-semibold">{field.label}</div>
          <FilterValueEditor
            field={field}
            condition={condition}
            onChange={onChange}
            orgs={orgs}
            sites={sites}
            softwareOptions={softwareOptions}
            softwareOptionCounts={softwareOptionCounts}
          />
          <div className="mt-3 flex items-center justify-between gap-2">
            <FilterPreviewFooter group={previewGroup} />
            <button
              type="button"
              data-testid="filter-chip-apply"
              onClick={() => setOpen(false)}
              className="rounded bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:opacity-90"
            >
              Apply
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
