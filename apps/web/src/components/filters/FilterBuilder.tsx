import { useState, useEffect, useCallback } from 'react';
import { Plus, X, ChevronDown, ChevronRight, GripVertical, RefreshCw } from 'lucide-react';
import type {
  FilterCondition,
  FilterConditionGroup,
  FilterFieldDefinition,
  FilterOperator,
  FilterValue,
  FilterPreviewResult
} from '@breeze/shared';
import { ConditionRow } from './ConditionRow';
import { ConditionGroup } from './ConditionGroup';
import { FilterPreview } from './FilterPreview';
import { FILTER_FIELDS } from './filterFields';
import { fetchWithAuth } from '../../stores/auth';

// The canonical device filter catalog (mirrors the backend filterEngine —
// see ./filterFields). Re-exported as DEFAULT_FILTER_FIELDS for the components
// that import it from here, instead of hand-maintaining a second copy.
const DEFAULT_FILTER_FIELDS: FilterFieldDefinition[] = FILTER_FIELDS;

interface FilterBuilderProps {
  value: FilterConditionGroup;
  onChange: (value: FilterConditionGroup) => void;
  filterFields?: FilterFieldDefinition[];
  showPreview?: boolean;
  previewDebounceMs?: number;
  className?: string;
}

function isConditionGroup(item: FilterCondition | FilterConditionGroup): item is FilterConditionGroup {
  return 'operator' in item && ('conditions' in item);
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

export function FilterBuilder({
  value,
  onChange,
  filterFields = DEFAULT_FILTER_FIELDS,
  showPreview = true,
  previewDebounceMs = 500,
  className = ''
}: FilterBuilderProps) {
  const [preview, setPreview] = useState<FilterPreviewResult | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  // Debounced preview fetch
  const fetchPreview = useCallback(async (filter: FilterConditionGroup) => {
    if (!showPreview) return;

    // Don't preview if filter is empty or has empty conditions
    const hasValidConditions = filter.conditions.some(c => {
      if (isConditionGroup(c)) {
        return c.conditions.length > 0;
      }
      return c.value !== '' && c.value !== null && c.value !== undefined;
    });

    if (!hasValidConditions) {
      setPreview(null);
      return;
    }

    setPreviewLoading(true);
    setPreviewError(null);

    try {
      const response = await fetchWithAuth('/filters/preview', {
        method: 'POST',
        body: JSON.stringify({ conditions: filter })
      });

      if (!response.ok) {
        throw new Error('Failed to fetch preview');
      }

      const data = await response.json();
      setPreview(data);
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : 'Failed to fetch preview');
    } finally {
      setPreviewLoading(false);
    }
  }, [showPreview]);

  useEffect(() => {
    const timer = setTimeout(() => {
      fetchPreview(value);
    }, previewDebounceMs);

    return () => clearTimeout(timer);
  }, [value, fetchPreview, previewDebounceMs]);

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
    // Ensure at least one condition remains
    if (newConditions.length === 0) {
      newConditions.push(createEmptyCondition());
    }
    onChange({ ...value, conditions: newConditions });
  };

  return (
    <div className={`space-y-4 ${className}`}>
      <div className="rounded-lg border bg-card p-4">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">Match</span>
            <select
              value={value.operator}
              onChange={(e) => handleOperatorChange(e.target.value as 'AND' | 'OR')}
              className="rounded-md border bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="AND">All conditions (AND)</option>
              <option value="OR">Any condition (OR)</option>
            </select>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleAddCondition}
              className="inline-flex h-8 items-center gap-1 rounded-md border px-3 text-xs font-medium transition hover:bg-muted"
            >
              <Plus className="h-3 w-3" />
              Add Condition
            </button>
            <button
              type="button"
              onClick={handleAddGroup}
              className="inline-flex h-8 items-center gap-1 rounded-md border px-3 text-xs font-medium transition hover:bg-muted"
            >
              <Plus className="h-3 w-3" />
              Add Group
            </button>
          </div>
        </div>

        <div className="space-y-2">
          {value.conditions.map((condition, index) => (
            <div key={index} className="flex items-start gap-2">
              {index > 0 && (
                <div className="flex h-10 w-12 items-center justify-center text-xs font-medium text-muted-foreground">
                  {value.operator}
                </div>
              )}
              <div className={`flex-1 ${index === 0 ? 'ml-14' : ''}`}>
                {isConditionGroup(condition) ? (
                  <ConditionGroup
                    value={condition}
                    onChange={(newValue) => handleConditionChange(index, newValue)}
                    onRemove={() => handleRemoveCondition(index)}
                    filterFields={filterFields}
                    depth={1}
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
      </div>

      {showPreview && (
        <FilterPreview
          preview={preview}
          loading={previewLoading}
          error={previewError}
          onRefresh={() => fetchPreview(value)}
        />
      )}
    </div>
  );
}

export default FilterBuilder;
export { DEFAULT_FILTER_FIELDS };
export type { FilterBuilderProps };
