// FilterSentenceBuilder — spec 4.3. Renders a FilterConditionGroup as a
// nested tree of [field ▾] [operator ▾] [value] rows with per-group AND/OR
// pill and +Condition / +Group buttons inside each group.
//
// State is the same FilterConditionGroup as chip mode. Switching modes is
// lossless when every condition is top-level + chip-renderable; the parent
// FilterChipBar decides which mode to render based on `isChipRenderable`.
//
// onChange propagates to the parent on every edit (immediate-apply, matching
// chip mode's UX). The footer Apply/Reset/Save buttons exist for
// discoverability — Apply is a no-op confirmation, Reset clears the builder,
// Save calls onSaveRequested with the current group.
import { Plus, Trash2 } from 'lucide-react';
import type {
  FilterCondition,
  FilterConditionGroup,
  FilterFieldDefinition,
  FilterOperator,
  FilterValue
} from '@breeze/shared';
import { V2_FILTER_FIELDS, getFieldDef, operatorLabel } from './filterFields';
import { FilterValueEditor, type NamedRef } from './FilterValueEditor';
import { FilterPreviewFooter } from './FilterPreviewFooter';

export interface FilterSentenceBuilderProps {
  value: FilterConditionGroup;
  onChange: (next: FilterConditionGroup) => void;
  orgs?: NamedRef[];
  sites?: NamedRef[];
  softwareOptions?: string[];
  softwareOptionCounts?: Record<string, number>;
  // When set, Save button is rendered. Parent owns the save dialog flow.
  onSaveRequested?: (group: FilterConditionGroup) => void;
}

function defaultConditionForField(field: FilterFieldDefinition): FilterCondition {
  const op = field.operators[0];
  let value: FilterValue = '';
  if (op === 'in' || op === 'notIn' || op === 'hasAny' || op === 'hasAll') value = [];
  else if (op === 'withinLast' || op === 'notWithinLast') value = { amount: 7, unit: 'days' };
  else if (field.type === 'number') value = 0;
  else if (field.type === 'enum' && field.enumValues?.length) value = field.enumValues[0];
  return { field: field.key, operator: op, value };
}

// A condition is chip-renderable iff it lives at the top AND-level — anything
// nested OR / nested group is advanced-only. Used by FilterChipBar to decide
// whether the chip → advanced toggle is reversible.
export function isChipRenderable(group: FilterConditionGroup | null): boolean {
  if (!group) return true;
  if (group.operator !== 'AND') return false;
  for (const c of group.conditions) {
    if ('conditions' in c) return false; // nested group
  }
  return true;
}

const EMPTY_GROUP: FilterConditionGroup = { operator: 'AND', conditions: [] };

export function FilterSentenceBuilder({
  value, onChange, orgs, sites, softwareOptions, softwareOptionCounts, onSaveRequested
}: FilterSentenceBuilderProps) {
  const hasConditions = value.conditions.length > 0;
  return (
    <div
      data-testid="filter-sentence-builder"
      className="rounded-md border bg-card p-3"
    >
      <GroupEditor
        group={value}
        onChange={onChange}
        orgs={orgs}
        sites={sites}
        softwareOptions={softwareOptions}
        softwareOptionCounts={softwareOptionCounts}
        depth={0}
      />
      <div className="mt-3 flex items-center justify-between gap-2 border-t pt-2">
        <FilterPreviewFooter group={value} />
        <div className="flex items-center gap-2">
          <button
            type="button"
            data-testid="sentence-reset"
            onClick={() => onChange(EMPTY_GROUP)}
            disabled={!hasConditions}
            className="rounded border px-3 py-1 text-xs hover:bg-muted disabled:opacity-40"
          >
            Reset
          </button>
          {onSaveRequested && (
            <button
              type="button"
              data-testid="sentence-save"
              onClick={() => onSaveRequested(value)}
              disabled={!hasConditions}
              className="rounded border px-3 py-1 text-xs hover:bg-muted disabled:opacity-40"
            >
              Save
            </button>
          )}
          <button
            type="button"
            data-testid="sentence-apply"
            onClick={() => onChange({ ...value })}
            className="rounded bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:opacity-90"
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}

interface GroupEditorProps {
  group: FilterConditionGroup;
  onChange: (next: FilterConditionGroup) => void;
  orgs?: NamedRef[];
  sites?: NamedRef[];
  softwareOptions?: string[];
  softwareOptionCounts?: Record<string, number>;
  depth: number;
}
function GroupEditor({ group, onChange, orgs, sites, softwareOptions, softwareOptionCounts, depth }: GroupEditorProps) {
  const toggleOp = () => onChange({ ...group, operator: group.operator === 'AND' ? 'OR' : 'AND' });
  const addCondition = () => {
    const def = V2_FILTER_FIELDS[0]; // pick a stable default; user changes it via dropdown
    onChange({ ...group, conditions: [...group.conditions, defaultConditionForField(def)] });
  };
  const addGroup = () => {
    onChange({
      ...group,
      conditions: [...group.conditions, { operator: 'AND', conditions: [] }]
    });
  };
  const updateAt = (i: number, next: FilterCondition | FilterConditionGroup) => {
    const list = group.conditions.slice();
    list[i] = next;
    onChange({ ...group, conditions: list });
  };
  const removeAt = (i: number) => {
    const list = group.conditions.slice();
    list.splice(i, 1);
    onChange({ ...group, conditions: list });
  };
  return (
    <div
      data-testid={`sentence-group-depth-${depth}`}
      className={`flex flex-col gap-2 ${depth > 0 ? 'rounded border-l-2 border-primary/40 pl-3' : ''}`}
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={toggleOp}
          data-testid={`sentence-group-op-${depth}`}
          className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-semibold hover:bg-primary/20"
        >
          {group.operator}
        </button>
        <span className="text-xs text-muted-foreground">match {group.operator === 'AND' ? 'all' : 'any'} of</span>
      </div>
      <div className="flex flex-col gap-2">
        {group.conditions.length === 0 && (
          <div className="text-xs text-muted-foreground">No conditions yet.</div>
        )}
        {group.conditions.map((item, i) => {
          if ('conditions' in item) {
            return (
              <div key={i} className="relative">
                <GroupEditor
                  group={item}
                  onChange={(g) => updateAt(i, g)}
                  orgs={orgs}
                  sites={sites}
                  softwareOptions={softwareOptions}
                  softwareOptionCounts={softwareOptionCounts}
                  depth={depth + 1}
                />
                <button
                  type="button"
                  onClick={() => removeAt(i)}
                  aria-label="Remove group"
                  data-testid={`sentence-remove-${depth}-${i}`}
                  className="absolute right-0 top-0 text-muted-foreground hover:text-destructive"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            );
          }
          return (
            <ConditionRow
              key={i}
              condition={item}
              onChange={(c) => updateAt(i, c)}
              onRemove={() => removeAt(i)}
              orgs={orgs}
              sites={sites}
              softwareOptions={softwareOptions}
              softwareOptionCounts={softwareOptionCounts}
              rowId={`${depth}-${i}`}
            />
          );
        })}
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={addCondition}
          data-testid={`sentence-add-condition-${depth}`}
          className="inline-flex items-center gap-1 rounded border px-2 py-0.5 text-xs hover:bg-muted"
        >
          <Plus className="h-3 w-3" /> Add condition
        </button>
        <button
          type="button"
          onClick={addGroup}
          data-testid={`sentence-add-group-${depth}`}
          className="inline-flex items-center gap-1 rounded border px-2 py-0.5 text-xs hover:bg-muted"
        >
          <Plus className="h-3 w-3" /> Add group
        </button>
      </div>
    </div>
  );
}

interface ConditionRowProps {
  condition: FilterCondition;
  onChange: (c: FilterCondition) => void;
  onRemove: () => void;
  orgs?: NamedRef[];
  sites?: NamedRef[];
  softwareOptions?: string[];
  softwareOptionCounts?: Record<string, number>;
  rowId: string;
}
function ConditionRow({ condition, onChange, onRemove, orgs, sites, softwareOptions, softwareOptionCounts, rowId }: ConditionRowProps) {
  const field = getFieldDef(condition.field) ?? V2_FILTER_FIELDS[0];
  const setField = (key: string) => {
    const def = getFieldDef(key);
    if (!def) return;
    onChange(defaultConditionForField(def));
  };
  return (
    <div
      data-testid={`sentence-row-${rowId}`}
      className="flex flex-wrap items-start gap-2 rounded border bg-background p-2"
    >
      <select
        data-testid={`sentence-field-${rowId}`}
        value={condition.field}
        onChange={e => setField(e.target.value)}
        className="rounded border bg-background px-1 py-0.5 text-xs"
      >
        {V2_FILTER_FIELDS.map(f => (
          <option key={f.key} value={f.key}>{f.label}</option>
        ))}
      </select>
      {/* operator label preview — actual operator picker lives inside the value editor */}
      <span className="text-xs text-muted-foreground">{operatorLabel(condition.operator as FilterOperator)}</span>
      <div className="min-w-[180px] flex-1">
        <FilterValueEditor
          field={field}
          condition={condition}
          onChange={onChange}
          orgs={orgs}
          sites={sites}
          softwareOptions={softwareOptions}
          softwareOptionCounts={softwareOptionCounts}
        />
      </div>
      <button
        type="button"
        onClick={onRemove}
        aria-label="Remove condition"
        data-testid={`sentence-remove-${rowId}`}
        className="text-muted-foreground hover:text-destructive"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
