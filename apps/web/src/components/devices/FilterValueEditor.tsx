// Renders the operator picker + value input(s) for one filter condition.
// Type/operator combinations supported:
//   - string + (equals/contains/...): text input
//   - number + (gt/lt/...): number input
//   - enum + (equals/notEquals): single select; enum + (in/notIn): multi-select
//   - datetime + (withinLast/notWithinLast): amount + unit; before/after: date picker
//   - array + hasAny/hasAll: comma-separated text → string[]
//   - any + isNull/isNotNull/isEmpty/isNotEmpty: no value input
//
// Spec section 4.1 — when the field is `orgId` / `siteId` and the parent
// provides orgs/sites name lookups, render a searchable multi-select of
// names instead of raw UUIDs.
// Spec section 4.2 — when the field is `software.installed` /
// `software.notInstalled` and softwareOptions are provided, render a
// multi-select chip list with All/Any combinator.
import { useEffect, useMemo, useState } from 'react';
import type {
  FilterCondition,
  FilterFieldDefinition,
  FilterOperator,
  FilterValue
} from '@breeze/shared';
import { operatorLabel } from './filterFields';
import { X, Search } from 'lucide-react';

const NO_VALUE_OPERATORS: FilterOperator[] = ['isNull', 'isNotNull', 'isEmpty', 'isNotEmpty'];

export interface NamedRef { id: string; name: string }

export interface FilterValueEditorProps {
  field: FilterFieldDefinition;
  condition: FilterCondition;
  onChange: (next: FilterCondition) => void;
  // Spec 4.1 — name lookups for hierarchy fields.
  orgs?: NamedRef[];
  sites?: NamedRef[];
  // Optional filter to limit shown sites to those under the orgIds the user
  // has already selected (parent provides this filtered list).
  // Spec 4.2 — distinct software-name list pulled from API.
  softwareOptions?: string[];
  // Optional per-name device counts to surface in the picker list.
  softwareOptionCounts?: Record<string, number>;
}

function defaultValueForOp(field: FilterFieldDefinition, op: FilterOperator): FilterValue {
  if (NO_VALUE_OPERATORS.includes(op)) return '';
  if (op === 'in' || op === 'notIn' || op === 'hasAny' || op === 'hasAll') return [];
  if (op === 'withinLast' || op === 'notWithinLast') return { amount: 7, unit: 'days' };
  if (field.type === 'number') return 0;
  if (field.type === 'enum' && field.enumValues?.length) return field.enumValues[0];
  return '';
}

function isSoftwareField(key: string): boolean {
  return key === 'software.installed' || key === 'software.notInstalled';
}

function isOrgField(key: string): boolean { return key === 'orgId'; }
function isSiteField(key: string): boolean { return key === 'siteId'; }

export function FilterValueEditor({
  field, condition, onChange, orgs, sites, softwareOptions, softwareOptionCounts
}: FilterValueEditorProps) {
  const op = condition.operator;

  // If the chosen field doesn't support the current operator (e.g. when
  // switching field types), snap to the first valid operator.
  useEffect(() => {
    if (!field.operators.includes(op)) {
      const nextOp = field.operators[0];
      onChange({ ...condition, operator: nextOp, value: defaultValueForOp(field, nextOp) });
    }
    // Intentionally keyed on field.key only: snap the operator when the field
    // changes, not on every onChange/condition identity change.
  }, [field.key]);

  const setOp = (nextOp: FilterOperator) => {
    onChange({ ...condition, operator: nextOp, value: defaultValueForOp(field, nextOp) });
  };

  const setValue = (v: FilterValue) => {
    onChange({ ...condition, value: v });
  };

  // Org/Site name pickers replace operator dropdown UX — multi-select only.
  if (isOrgField(field.key) && orgs) {
    return (
      <NamedMultiSelect
        label="Organizations"
        options={orgs}
        condition={condition}
        onChange={onChange}
        testId="filter-org-picker"
      />
    );
  }
  if (isSiteField(field.key) && sites) {
    return (
      <NamedMultiSelect
        label="Sites"
        options={sites}
        condition={condition}
        onChange={onChange}
        testId="filter-site-picker"
      />
    );
  }

  // Software fields render multi-select chip + All/Any combinator.
  if (isSoftwareField(field.key)) {
    return (
      <SoftwareMultiSelect
        field={field}
        condition={condition}
        onChange={onChange}
        options={softwareOptions}
        optionCounts={softwareOptionCounts}
      />
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <label className="text-xs font-medium text-muted-foreground">Operator</label>
      <select
        data-testid="filter-operator-select"
        value={op}
        onChange={e => setOp(e.target.value as FilterOperator)}
        className="rounded border bg-background px-2 py-1 text-sm"
      >
        {field.operators.map(o => (
          <option key={o} value={o}>{operatorLabel(o)}</option>
        ))}
      </select>

      {!NO_VALUE_OPERATORS.includes(op) && (
        <>
          <label className="text-xs font-medium text-muted-foreground">Value</label>
          {renderValueInput(field, op, condition.value, setValue)}
        </>
      )}
    </div>
  );
}

function renderValueInput(
  field: FilterFieldDefinition,
  op: FilterOperator,
  value: FilterValue,
  onChange: (v: FilterValue) => void
) {
  // Multi-value operators
  if (op === 'in' || op === 'notIn' || op === 'hasAny' || op === 'hasAll') {
    if (field.type === 'enum' && field.enumValues) {
      const selected = Array.isArray(value) ? (value as string[]) : [];
      return (
        <div data-testid="filter-multi-enum" className="flex flex-col gap-1 max-h-40 overflow-y-auto rounded border p-2">
          {field.enumValues.map(v => (
            <label key={v} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={selected.includes(v)}
                onChange={e => {
                  if (e.target.checked) onChange([...selected, v]);
                  else onChange(selected.filter(x => x !== v));
                }}
              />
              {v}
            </label>
          ))}
        </div>
      );
    }
    // string array via comma-separated input
    const asText = Array.isArray(value) ? (value as string[]).join(', ') : '';
    return (
      <input
        type="text"
        data-testid="filter-csv-input"
        value={asText}
        onChange={e => onChange(e.target.value.split(',').map(s => s.trim()).filter(Boolean))}
        placeholder="value1, value2, ..."
        className="rounded border bg-background px-2 py-1 text-sm"
      />
    );
  }

  // Relative-date amount+unit
  if (op === 'withinLast' || op === 'notWithinLast') {
    const v = (typeof value === 'object' && value && 'amount' in value)
      ? value as { amount: number; unit: 'minutes' | 'hours' | 'days' | 'weeks' | 'months' }
      : { amount: 7, unit: 'days' as const };
    return (
      <div className="flex gap-2" data-testid="filter-relative-date">
        <input
          type="number"
          value={v.amount}
          min={1}
          onChange={e => onChange({ amount: Number(e.target.value), unit: v.unit })}
          className="w-20 rounded border bg-background px-2 py-1 text-sm"
        />
        <select
          value={v.unit}
          onChange={e => onChange({ amount: v.amount, unit: e.target.value as typeof v.unit })}
          className="rounded border bg-background px-2 py-1 text-sm"
        >
          <option value="minutes">minutes</option>
          <option value="hours">hours</option>
          <option value="days">days</option>
          <option value="weeks">weeks</option>
          <option value="months">months</option>
        </select>
      </div>
    );
  }

  // Number
  if (field.type === 'number') {
    return (
      <input
        type="number"
        data-testid="filter-number-input"
        value={typeof value === 'number' ? value : 0}
        onChange={e => onChange(Number(e.target.value))}
        className="rounded border bg-background px-2 py-1 text-sm"
      />
    );
  }

  // Single enum
  if (field.type === 'enum' && field.enumValues) {
    return (
      <select
        data-testid="filter-enum-select"
        value={typeof value === 'string' ? value : (field.enumValues[0] ?? '')}
        onChange={e => onChange(e.target.value)}
        className="rounded border bg-background px-2 py-1 text-sm"
      >
        {field.enumValues.map(v => (
          <option key={v} value={v}>{v}</option>
        ))}
      </select>
    );
  }

  // Date (before/after) - simple date input
  if (field.type === 'datetime' && (op === 'before' || op === 'after')) {
    const asString = typeof value === 'string' ? value : '';
    return (
      <input
        type="date"
        data-testid="filter-date-input"
        value={asString}
        onChange={e => onChange(e.target.value)}
        className="rounded border bg-background px-2 py-1 text-sm"
      />
    );
  }

  // Default: text input
  return (
    <input
      type="text"
      data-testid="filter-text-input"
      value={typeof value === 'string' ? value : ''}
      onChange={e => onChange(e.target.value)}
      className="rounded border bg-background px-2 py-1 text-sm"
      placeholder="value"
    />
  );
}

// Searchable multi-select that renders names + stores UUIDs as condition.value.
// Always uses operator `in` (multi). Single-value selection (operator
// `equals`) is collapsed to in([one]) for UI consistency.
interface NamedMultiSelectProps {
  label: string;
  options: NamedRef[];
  condition: FilterCondition;
  onChange: (c: FilterCondition) => void;
  testId: string;
}
function NamedMultiSelect({ label, options, condition, onChange, testId }: NamedMultiSelectProps) {
  const [q, setQ] = useState('');
  const selected: string[] = Array.isArray(condition.value)
    ? (condition.value as string[])
    : typeof condition.value === 'string' && condition.value
      ? [condition.value]
      : [];
  const filtered = useMemo(() => {
    const lc = q.toLowerCase().trim();
    return lc ? options.filter(o => o.name.toLowerCase().includes(lc)) : options;
  }, [q, options]);
  const toggle = (id: string) => {
    const next = selected.includes(id) ? selected.filter(x => x !== id) : [...selected, id];
    onChange({ ...condition, operator: 'in', value: next });
  };
  const byId = useMemo(() => new Map(options.map(o => [o.id, o.name])), [options]);
  return (
    <div className="flex flex-col gap-2" data-testid={testId}>
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      <div className="flex items-center gap-1 rounded border bg-background px-2 py-1">
        <Search className="h-3 w-3 text-muted-foreground" />
        <input
          type="text"
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder={`Search ${label.toLowerCase()}…`}
          className="flex-1 bg-transparent text-xs outline-none"
          data-testid={`${testId}-search`}
        />
      </div>
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1" data-testid={`${testId}-selected`}>
          {selected.map(id => (
            <span key={id} className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[11px]">
              {byId.get(id) ?? id.slice(0, 8)}
              <button
                type="button"
                onClick={() => toggle(id)}
                aria-label={`Remove ${byId.get(id) ?? id}`}
                data-testid={`${testId}-remove-${id}`}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      <ul className="max-h-44 overflow-y-auto rounded border">
        {filtered.length === 0 && (
          <li className="px-2 py-1 text-xs text-muted-foreground">No matches</li>
        )}
        {filtered.map(o => (
          <li key={o.id}>
            <button
              type="button"
              data-testid={`${testId}-option-${o.id}`}
              onClick={() => toggle(o.id)}
              className={`flex w-full items-center gap-2 px-2 py-1 text-left text-xs hover:bg-muted ${selected.includes(o.id) ? 'bg-muted/50' : ''}`}
            >
              <input type="checkbox" readOnly checked={selected.includes(o.id)} className="pointer-events-none" />
              {o.name}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Software multi-select per spec 4.2.
// Value shape stored on the condition: an array of software names (string[])
// when the user picks from the multi-select. The All/Any toggle maps to the
// FilterOperator: All → `hasAll`, Any → `hasAny` (parallel to enum semantics).
// For backwards compatibility the software fields' default operator is
// `contains` (single string). When the user enters multi-mode the operator
// flips to hasAll/hasAny.
interface SoftwareMultiSelectProps {
  field: FilterFieldDefinition;
  condition: FilterCondition;
  onChange: (c: FilterCondition) => void;
  options?: string[];
  optionCounts?: Record<string, number>;
}
function SoftwareMultiSelect({ field, condition, onChange, options, optionCounts }: SoftwareMultiSelectProps) {
  const [q, setQ] = useState('');
  const selected: string[] = Array.isArray(condition.value)
    ? (condition.value as string[])
    : typeof condition.value === 'string' && condition.value
      ? [condition.value]
      : [];
  const combinator: 'all' | 'any' = condition.operator === 'hasAll' ? 'all' : 'any';
  const setCombinator = (next: 'all' | 'any') => {
    onChange({ ...condition, operator: next === 'all' ? 'hasAll' : 'hasAny', value: selected });
  };
  const toggle = (name: string) => {
    const nextSel = selected.includes(name) ? selected.filter(x => x !== name) : [...selected, name];
    const op: FilterOperator = condition.operator === 'hasAll' ? 'hasAll' : 'hasAny';
    onChange({ ...condition, operator: op, value: nextSel });
  };
  const filtered = useMemo(() => {
    const lc = q.toLowerCase().trim();
    if (!options) return [] as string[];
    return lc ? options.filter(o => o.toLowerCase().includes(lc)).slice(0, 50) : options.slice(0, 50);
  }, [q, options]);
  const noBackend = !options;
  return (
    <div className="flex flex-col gap-2" data-testid="filter-software-picker">
      <div className="flex items-center gap-2">
        <label className="text-xs font-medium text-muted-foreground">{field.label}</label>
        <div className="ml-auto inline-flex overflow-hidden rounded border text-[10px]">
          <button
            type="button"
            data-testid="filter-software-all"
            onClick={() => setCombinator('all')}
            className={`px-2 py-0.5 ${combinator === 'all' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}
          >All</button>
          <button
            type="button"
            data-testid="filter-software-any"
            onClick={() => setCombinator('any')}
            className={`px-2 py-0.5 ${combinator === 'any' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}
          >Any</button>
        </div>
      </div>
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1" data-testid="filter-software-selected">
          {selected.map(n => (
            <span key={n} className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[11px]">
              {n}
              <button
                type="button"
                onClick={() => toggle(n)}
                aria-label={`Remove ${n}`}
                data-testid={`filter-software-remove-${n}`}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      {noBackend ? (
        // TODO: replace with /software-inventory dropdown once parent wires it.
        <input
          type="text"
          data-testid="filter-software-csv"
          value={selected.join(', ')}
          onChange={e => {
            const parts = e.target.value.split(',').map(s => s.trim()).filter(Boolean);
            const op: FilterOperator = condition.operator === 'hasAll' ? 'hasAll' : 'hasAny';
            onChange({ ...condition, operator: op, value: parts });
          }}
          placeholder="comma-separated app names"
          className="rounded border bg-background px-2 py-1 text-sm"
        />
      ) : (
        <>
          <div className="flex items-center gap-1 rounded border bg-background px-2 py-1">
            <Search className="h-3 w-3 text-muted-foreground" />
            <input
              type="text"
              value={q}
              onChange={e => setQ(e.target.value)}
              placeholder="Search software…"
              data-testid="filter-software-search"
              className="flex-1 bg-transparent text-xs outline-none"
            />
          </div>
          <ul className="max-h-40 overflow-y-auto rounded border">
            {filtered.length === 0 && (
              <li className="px-2 py-1 text-xs text-muted-foreground">No matches</li>
            )}
            {filtered.map(name => {
              const count = optionCounts?.[name];
              return (
                <li key={name}>
                  <button
                    type="button"
                    data-testid={`filter-software-option-${name}`}
                    onClick={() => toggle(name)}
                    className={`flex w-full items-center gap-2 px-2 py-1 text-left text-xs hover:bg-muted ${selected.includes(name) ? 'bg-muted/50' : ''}`}
                  >
                    <input type="checkbox" readOnly checked={selected.includes(name)} className="pointer-events-none" />
                    <span className="flex-1 truncate">{name}</span>
                    {typeof count === 'number' && (
                      <span className="ml-2 text-[10px] text-muted-foreground">({count})</span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}

export function summarizeCondition(field: FilterFieldDefinition, c: FilterCondition, lookups?: {
  orgs?: NamedRef[]; sites?: NamedRef[];
}): string {
  const op = operatorLabel(c.operator);
  if (NO_VALUE_OPERATORS.includes(c.operator)) return `${field.label} ${op}`;
  let v: string;
  if (Array.isArray(c.value)) {
    // Resolve names for org/site chips.
    let display = c.value as string[];
    if (lookups) {
      const table = field.key === 'orgId' ? lookups.orgs
        : field.key === 'siteId' ? lookups.sites : undefined;
      if (table) {
        const byId = new Map(table.map(o => [o.id, o.name]));
        display = display.map(id => byId.get(id) ?? id.slice(0, 8));
      }
    }
    v = display.length <= 2 ? display.join(', ') : `${display.length} values`;
  } else if (typeof c.value === 'object' && c.value && 'amount' in c.value) {
    const rd = c.value as { amount: number; unit: string };
    v = `${rd.amount} ${rd.unit}`;
  } else {
    v = String(c.value ?? '');
  }
  return `${field.label} ${op} ${v}`;
}
