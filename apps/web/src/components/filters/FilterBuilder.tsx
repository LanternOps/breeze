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
import { fetchWithAuth } from '../../stores/auth';

// Default filter fields - these will be fetched from the API in production
const DEFAULT_FILTER_FIELDS: FilterFieldDefinition[] = [
  // Core device fields
  { key: 'hostname', label: 'Hostname', category: 'core', type: 'string', operators: ['equals', 'notEquals', 'contains', 'notContains', 'startsWith', 'endsWith', 'matches'] },
  { key: 'displayName', label: 'Display Name', category: 'core', type: 'string', operators: ['equals', 'notEquals', 'contains', 'notContains', 'startsWith', 'endsWith', 'isNull', 'isNotNull'] },
  { key: 'status', label: 'Status', category: 'core', type: 'enum', operators: ['equals', 'notEquals', 'in', 'notIn'], enumValues: ['online', 'offline', 'maintenance', 'decommissioned'] },
  { key: 'agentVersion', label: 'Agent Version', category: 'core', type: 'string', operators: ['equals', 'notEquals', 'contains', 'startsWith', 'greaterThan', 'lessThan'] },
  { key: 'enrolledAt', label: 'Enrolled Date', category: 'core', type: 'datetime', operators: ['before', 'after', 'between', 'withinLast', 'notWithinLast'] },
  { key: 'lastSeenAt', label: 'Last Seen', category: 'core', type: 'datetime', operators: ['before', 'after', 'between', 'withinLast', 'notWithinLast', 'isNull', 'isNotNull'] },
  { key: 'tags', label: 'Tags', category: 'core', type: 'array', operators: ['hasAny', 'hasAll', 'isEmpty', 'isNotEmpty'] },

  // OS fields
  { key: 'osType', label: 'OS Type', category: 'os', type: 'enum', operators: ['equals', 'notEquals', 'in', 'notIn'], enumValues: ['windows', 'macos', 'linux'] },
  { key: 'osVersion', label: 'OS Version', category: 'os', type: 'string', operators: ['equals', 'notEquals', 'contains', 'startsWith', 'greaterThan', 'lessThan'] },
  { key: 'osBuild', label: 'OS Build', category: 'os', type: 'string', operators: ['equals', 'notEquals', 'contains', 'isNull', 'isNotNull'] },
  { key: 'architecture', label: 'Architecture', category: 'os', type: 'enum', operators: ['equals', 'notEquals'], enumValues: ['x64', 'x86', 'arm64', 'arm'] },

  // Hardware fields
  { key: 'hardware.manufacturer', label: 'Manufacturer', category: 'hardware', type: 'string', operators: ['equals', 'notEquals', 'contains', 'startsWith'] },
  { key: 'hardware.model', label: 'Model', category: 'hardware', type: 'string', operators: ['equals', 'notEquals', 'contains', 'startsWith'] },
  { key: 'hardware.serialNumber', label: 'Serial Number', category: 'hardware', type: 'string', operators: ['equals', 'notEquals', 'contains', 'isNull', 'isNotNull'] },
  { key: 'hardware.cpuModel', label: 'CPU Model', category: 'hardware', type: 'string', operators: ['equals', 'notEquals', 'contains'] },
  { key: 'hardware.cpuCores', label: 'CPU Cores', category: 'hardware', type: 'number', operators: ['equals', 'notEquals', 'greaterThan', 'greaterThanOrEquals', 'lessThan', 'lessThanOrEquals'] },
  { key: 'hardware.ramTotalMb', label: 'RAM (MB)', category: 'hardware', type: 'number', operators: ['equals', 'notEquals', 'greaterThan', 'greaterThanOrEquals', 'lessThan', 'lessThanOrEquals'] },
  { key: 'hardware.diskTotalGb', label: 'Disk (GB)', category: 'hardware', type: 'number', operators: ['equals', 'notEquals', 'greaterThan', 'greaterThanOrEquals', 'lessThan', 'lessThanOrEquals'] },
  { key: 'hardware.gpuModel', label: 'GPU Model', category: 'hardware', type: 'string', operators: ['equals', 'notEquals', 'contains', 'isNull', 'isNotNull'] },

  // Network fields
  { key: 'network.ipAddress', label: 'IP Address', category: 'network', type: 'string', operators: ['equals', 'notEquals', 'contains', 'startsWith'] },
  { key: 'network.publicIp', label: 'Public IP', category: 'network', type: 'string', operators: ['equals', 'notEquals', 'contains', 'startsWith', 'isNull', 'isNotNull'] },
  { key: 'network.macAddress', label: 'MAC Address', category: 'network', type: 'string', operators: ['equals', 'notEquals', 'contains'] },

  // Metrics fields
  { key: 'metrics.cpuPercent', label: 'CPU Usage (%)', category: 'metrics', type: 'number', operators: ['greaterThan', 'greaterThanOrEquals', 'lessThan', 'lessThanOrEquals'] },
  { key: 'metrics.ramPercent', label: 'RAM Usage (%)', category: 'metrics', type: 'number', operators: ['greaterThan', 'greaterThanOrEquals', 'lessThan', 'lessThanOrEquals'] },
  { key: 'metrics.diskPercent', label: 'Disk Usage (%)', category: 'metrics', type: 'number', operators: ['greaterThan', 'greaterThanOrEquals', 'lessThan', 'lessThanOrEquals'] },

  // Software fields
  { key: 'software.installed', label: 'Software Installed', category: 'software', type: 'string', operators: ['contains', 'notContains'], description: 'Check if specific software is installed' },
  { key: 'software.notInstalled', label: 'Software Not Installed', category: 'software', type: 'string', operators: ['contains'], description: 'Check if specific software is not installed' },

  // Hierarchy fields
  { key: 'org.id', label: 'Organization', category: 'hierarchy', type: 'string', operators: ['equals', 'notEquals', 'in', 'notIn'] },
  { key: 'site.id', label: 'Site', category: 'hierarchy', type: 'string', operators: ['equals', 'notEquals', 'in', 'notIn'] },
  { key: 'group.id', label: 'Device Group', category: 'hierarchy', type: 'string', operators: ['equals', 'notEquals', 'in', 'notIn'] },

  // Computed fields
  { key: 'daysSinceLastSeen', label: 'Days Since Last Seen', category: 'computed', type: 'number', operators: ['greaterThan', 'greaterThanOrEquals', 'lessThan', 'lessThanOrEquals'], computed: true },
  { key: 'patchCompliance', label: 'Patch Compliance (%)', category: 'computed', type: 'number', operators: ['greaterThan', 'greaterThanOrEquals', 'lessThan', 'lessThanOrEquals'], computed: true }
];

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
              className="h-8 rounded-md border bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
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
