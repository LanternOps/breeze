// QuickAddChips — spec 4.4. Horizontal scroll row of one-click chips that
// each toggle a single canonical FilterCondition in the active filter. When
// the condition is present the chip is marked active (check icon,
// aria-pressed) and clicking again removes it.
import type { FilterCondition, FilterConditionGroup } from '@breeze/shared';
import { Check, Plus } from 'lucide-react';

export interface QuickAddChip {
  id: string;
  label: string;
  condition: FilterCondition;
}

// POC LOCAL chip set per Billy's 2026-05-27 feedback. Toggle behavior:
// click once to add, click again to remove.
export const QUICK_ADD_CHIPS: QuickAddChip[] = [
  { id: 'online', label: 'Online', condition: { field: 'status', operator: 'equals', value: 'online' } },
  { id: 'offline', label: 'Offline', condition: { field: 'status', operator: 'equals', value: 'offline' } },
  { id: 'servers', label: 'Servers', condition: { field: 'deviceRole', operator: 'equals', value: 'server' } },
  { id: 'needsPatches', label: 'Needs patches', condition: { field: 'patches.pending', operator: 'equals', value: 'yes' } },
  { id: 'critical', label: 'Critical', condition: { field: 'alerts.critical', operator: 'equals', value: 'yes' } },
  { id: 'rebootNeeded', label: 'Reboot needed', condition: { field: 'system.rebootRequired', operator: 'equals', value: 'yes' } },
  { id: 'notSeen7d', label: 'Not seen 7d', condition: { field: 'daysSinceLastSeen', operator: 'greaterThan', value: 7 } },
  { id: 'lowDisk', label: 'Low disk', condition: { field: 'metrics.diskPercent', operator: 'greaterThan', value: 90 } },
  { id: 'untagged', label: 'Untagged', condition: { field: 'tags', operator: 'isEmpty', value: '' } }
];

function chipMatches(c: FilterCondition, target: FilterCondition): boolean {
  return c.field === target.field
    && c.operator === target.operator
    && JSON.stringify(c.value) === JSON.stringify(target.value);
}

function isAdded(group: FilterConditionGroup | null, target: FilterCondition): boolean {
  if (!group) return false;
  for (const c of group.conditions) {
    if ('conditions' in c) continue;
    if (chipMatches(c, target)) return true;
  }
  return false;
}

export interface QuickAddChipsProps {
  value: FilterConditionGroup | null;
  onChange: (next: FilterConditionGroup) => void;
}

export function QuickAddChips({ value, onChange }: QuickAddChipsProps) {
  const handleToggle = (chip: QuickAddChip) => {
    const base = value ?? { operator: 'AND' as const, conditions: [] };
    if (isAdded(base, chip.condition)) {
      const next = base.conditions.filter(c =>
        'conditions' in c || !chipMatches(c, chip.condition)
      );
      onChange({ operator: 'AND', conditions: next });
    } else {
      onChange({ operator: 'AND', conditions: [...base.conditions, chip.condition] });
    }
  };
  return (
    <div
      data-testid="quick-add-chips"
      className="flex gap-2 overflow-x-auto pb-1"
      role="toolbar"
      aria-label="Quick-add filters"
    >
      {QUICK_ADD_CHIPS.map(chip => {
        const added = isAdded(value, chip.condition);
        return (
          <button
            type="button"
            key={chip.id}
            data-testid={`quick-add-${chip.id}`}
            aria-pressed={added}
            onClick={() => handleToggle(chip)}
            className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs ${
              added ? 'bg-primary text-primary-foreground hover:bg-primary/90' : 'hover:bg-muted'
            }`}
          >
            {added ? <Check className="h-3 w-3" /> : <Plus className="h-3 w-3" />}
            {chip.label}
          </button>
        );
      })}
    </div>
  );
}
