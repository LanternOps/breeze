import { Plus, Trash2, ChevronDown, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import type { FilterCondition, FilterConditionGroup, FilterFieldDefinition } from '@breeze/shared';
import { ConditionRow } from './ConditionRow';

interface ConditionGroupProps {
  value: FilterConditionGroup;
  onChange: (value: FilterConditionGroup) => void;
  onRemove: () => void;
  filterFields: FilterFieldDefinition[];
  depth?: number;
}

function isConditionGroup(item: FilterCondition | FilterConditionGroup): item is FilterConditionGroup {
  return 'operator' in item && 'conditions' in item;
}

function createEmptyCondition(): FilterCondition {
  return {
    field: 'hostname',
    operator: 'contains',
    value: ''
  };
}

function createEmptyGroup(operator: 'AND' | 'OR' = 'AND'): FilterConditionGroup {
  return {
    operator,
    conditions: [createEmptyCondition()]
  };
}

export function ConditionGroup({
  value,
  onChange,
  onRemove,
  filterFields,
  depth = 0
}: ConditionGroupProps) {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const maxDepth = 3;
  const canNest = depth < maxDepth;

  const handleOperatorChange = (operator: 'AND' | 'OR') => {
    onChange({ ...value, operator });
  };

  const handleAddCondition = () => {
    onChange({
      ...value,
      conditions: [...value.conditions, createEmptyCondition()]
    });
  };

  const handleAddGroup = () => {
    if (!canNest) return;
    const newOperator = value.operator === 'AND' ? 'OR' : 'AND';
    onChange({
      ...value,
      conditions: [...value.conditions, createEmptyGroup(newOperator)]
    });
  };

  const handleConditionChange = (index: number, condition: FilterCondition | FilterConditionGroup) => {
    const newConditions = [...value.conditions];
    newConditions[index] = condition;
    onChange({ ...value, conditions: newConditions });
  };

  const handleRemoveCondition = (index: number) => {
    const newConditions = value.conditions.filter((_, i) => i !== index);
    if (newConditions.length === 0) {
      newConditions.push(createEmptyCondition());
    }
    onChange({ ...value, conditions: newConditions });
  };

  // Color coding for nested groups
  const borderColors = [
    'border-l-blue-500',
    'border-l-green-500',
    'border-l-amber-500',
    'border-l-purple-500'
  ];
  const borderColor = borderColors[depth % borderColors.length];

  return (
    <div className={`rounded-md border border-l-4 ${borderColor} bg-muted/20 p-3`}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setIsCollapsed(!isCollapsed)}
            className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted"
          >
            {isCollapsed ? (
              <ChevronRight className="h-4 w-4" />
            ) : (
              <ChevronDown className="h-4 w-4" />
            )}
          </button>
          <span className="text-xs font-medium text-muted-foreground">Group: Match</span>
          <select
            value={value.operator}
            onChange={(e) => handleOperatorChange(e.target.value as 'AND' | 'OR')}
            className="h-7 rounded border bg-background px-2 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="AND">All (AND)</option>
            <option value="OR">Any (OR)</option>
          </select>
          <span className="text-xs text-muted-foreground">
            {value.conditions.length} condition{value.conditions.length !== 1 ? 's' : ''}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={handleAddCondition}
            className="inline-flex h-7 items-center gap-1 rounded border px-2 text-xs font-medium transition hover:bg-muted"
          >
            <Plus className="h-3 w-3" />
            Condition
          </button>
          {canNest && (
            <button
              type="button"
              onClick={handleAddGroup}
              className="inline-flex h-7 items-center gap-1 rounded border px-2 text-xs font-medium transition hover:bg-muted"
            >
              <Plus className="h-3 w-3" />
              Group
            </button>
          )}
          <button
            type="button"
            onClick={onRemove}
            className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition hover:bg-muted hover:text-destructive"
            title="Remove group"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {!isCollapsed && (
        <div className="space-y-2 pl-6">
          {value.conditions.map((condition, index) => (
            <div key={index} className="flex items-start gap-2">
              {index > 0 && (
                <div className="flex h-9 w-10 items-center justify-center text-xs font-medium text-muted-foreground">
                  {value.operator}
                </div>
              )}
              <div className={`flex-1 ${index === 0 ? 'ml-12' : ''}`}>
                {isConditionGroup(condition) ? (
                  <ConditionGroup
                    value={condition}
                    onChange={(newValue) => handleConditionChange(index, newValue)}
                    onRemove={() => handleRemoveCondition(index)}
                    filterFields={filterFields}
                    depth={depth + 1}
                  />
                ) : (
                  <ConditionRow
                    value={condition}
                    onChange={(newValue) => handleConditionChange(index, newValue)}
                    onRemove={() => handleRemoveCondition(index)}
                    filterFields={filterFields}
                    canRemove={value.conditions.length > 1}
                  />
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default ConditionGroup;
