import { useState, useEffect, useCallback } from 'react';
import { ChevronDown, ChevronUp, X, Filter, BookmarkIcon } from 'lucide-react';
import type { FilterConditionGroup, SavedFilter } from '@breeze/shared';
import { FilterBuilder, DEFAULT_FILTER_FIELDS } from './FilterBuilder';
import { FilterPreview } from './FilterPreview';
import { useFilterPreview } from '../../hooks/useFilterPreview';
import { fetchWithAuth } from '../../stores/auth';

interface DeviceFilterBarProps {
  value: FilterConditionGroup | null;
  onChange: (value: FilterConditionGroup | null) => void;
  showPreview?: boolean;
  showSavedFilters?: boolean;
  collapsible?: boolean;
  defaultExpanded?: boolean;
  className?: string;
}

const EMPTY_FILTER: FilterConditionGroup = {
  operator: 'AND',
  conditions: [{ field: 'hostname', operator: 'contains', value: '' }]
};

function countConditions(group: FilterConditionGroup): number {
  let count = 0;
  for (const c of group.conditions) {
    if ('conditions' in c) {
      count += countConditions(c);
    } else {
      if (c.value !== '' && c.value !== null && c.value !== undefined) {
        count++;
      }
    }
  }
  return count;
}

export function DeviceFilterBar({
  value,
  onChange,
  showPreview = true,
  showSavedFilters = true,
  collapsible = true,
  defaultExpanded = false,
  className = ''
}: DeviceFilterBarProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [savedFilters, setSavedFilters] = useState<SavedFilter[]>([]);
  const [savedFiltersLoading, setSavedFiltersLoading] = useState(false);
  const [selectedFilterId, setSelectedFilterId] = useState<string>('');

  const conditionCount = value ? countConditions(value) : 0;
  const { preview, loading: previewLoading, error: previewError, refresh } = useFilterPreview(
    value,
    { enabled: showPreview && expanded }
  );

  const fetchSavedFilters = useCallback(async () => {
    if (!showSavedFilters) return;
    setSavedFiltersLoading(true);
    try {
      const response = await fetchWithAuth('/filters');
      if (response.ok) {
        const data = await response.json();
        setSavedFilters(data.data ?? data.filters ?? []);
      }
    } catch {
      // Non-critical, saved filters are optional
    } finally {
      setSavedFiltersLoading(false);
    }
  }, [showSavedFilters]);

  useEffect(() => {
    if (showSavedFilters) {
      fetchSavedFilters();
    }
  }, [fetchSavedFilters, showSavedFilters]);

  const handleSavedFilterSelect = (filterId: string) => {
    setSelectedFilterId(filterId);
    if (!filterId) return;
    const filter = savedFilters.find(f => f.id === filterId);
    if (filter) {
      onChange(filter.conditions);
      if (collapsible) setExpanded(false);
    }
  };

  const handleClear = () => {
    onChange(null);
    setSelectedFilterId('');
  };

  const handleFilterChange = (newValue: FilterConditionGroup) => {
    setSelectedFilterId('');
    onChange(newValue);
  };

  return (
    <div className={`rounded-lg border bg-card ${className}`}>
      {/* Collapsed bar */}
      <div className="flex items-center gap-3 px-4 py-3">
        <Filter className="h-4 w-4 text-muted-foreground shrink-0" />

        {showSavedFilters && (
          <select
            value={selectedFilterId}
            onChange={(e) => handleSavedFilterSelect(e.target.value)}
            disabled={savedFiltersLoading}
            className="h-8 rounded-md border bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="">Saved Filters...</option>
            {savedFilters.map(f => (
              <option key={f.id} value={f.id}>{f.name}</option>
            ))}
          </select>
        )}

        {conditionCount > 0 && (
          <span className="inline-flex items-center rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary">
            {conditionCount} condition{conditionCount !== 1 ? 's' : ''} active
          </span>
        )}

        <div className="flex-1" />

        {value && (
          <button
            type="button"
            onClick={handleClear}
            className="inline-flex h-7 items-center gap-1 rounded border px-2 text-xs font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground"
          >
            <X className="h-3 w-3" />
            Clear
          </button>
        )}

        {collapsible && (
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="inline-flex h-7 items-center gap-1 rounded border px-2 text-xs font-medium transition hover:bg-muted"
          >
            {expanded ? (
              <>
                <ChevronUp className="h-3 w-3" />
                Collapse
              </>
            ) : (
              <>
                <ChevronDown className="h-3 w-3" />
                Advanced Filter
              </>
            )}
          </button>
        )}
      </div>

      {/* Expanded filter builder */}
      {expanded && (
        <div className="border-t px-4 py-4 space-y-4">
          <FilterBuilder
            value={value ?? EMPTY_FILTER}
            onChange={handleFilterChange}
            filterFields={DEFAULT_FILTER_FIELDS}
            showPreview={false}
          />

          {showPreview && (
            <FilterPreview
              preview={preview}
              loading={previewLoading}
              error={previewError}
              onRefresh={refresh}
            />
          )}
        </div>
      )}
    </div>
  );
}

export default DeviceFilterBar;
