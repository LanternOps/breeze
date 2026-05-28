// SavedFiltersPanel - left-rail list of saved filters with a "Save current"
// button. POC scope: lists all filters visible to the user (uses
// GET /api/v1/filters). Save creates a private filter (createdBy = current
// user, orgId resolved by the API from auth context).
import { useCallback, useEffect, useState } from 'react';
import { BookmarkIcon, Save } from 'lucide-react';
import type { FilterConditionGroup, SavedFilter } from '@breeze/shared';
import { fetchWithAuth } from '../../stores/auth';

export interface SavedFiltersPanelProps {
  currentFilter: FilterConditionGroup | null;
  onApply: (filter: FilterConditionGroup) => void;
  // Spec 4.12 — when the parent's `Ctrl+S` handler fires, it bumps this
  // counter to invoke handleSave without needing a ref or imperative API.
  saveTrigger?: number;
}

function countChips(group: FilterConditionGroup | null): number {
  if (!group) return 0;
  return group.conditions.filter(c => !('conditions' in c)).length;
}

export function SavedFiltersPanel({ currentFilter, onApply, saveTrigger }: SavedFiltersPanelProps) {
  const [filters, setFilters] = useState<SavedFilter[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchWithAuth('/filters');
      if (res.ok) {
        const data = await res.json();
        setFilters(data.data ?? []);
      } else {
        setError(`Failed to load (${res.status})`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleSave = useCallback(async () => {
    if (!currentFilter || countChips(currentFilter) === 0) return;
    const name = window.prompt('Name this filter:');
    if (!name) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetchWithAuth('/filters', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, conditions: currentFilter })
      });
      if (res.ok) {
        await refresh();
      } else {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? `Save failed (${res.status})`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }, [currentFilter, refresh]);

  // React to parent's Ctrl+S trigger. Skip the initial mount value (0).
  useEffect(() => {
    if (!saveTrigger) return;
    void handleSave();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saveTrigger]);

  return (
    <aside data-testid="saved-filters-panel" className="w-56 shrink-0 rounded-md border bg-card p-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-sm font-semibold">
          <BookmarkIcon className="h-4 w-4" />
          Saved
        </div>
        <button
          type="button"
          data-testid="saved-filter-save-button"
          onClick={handleSave}
          disabled={saving || countChips(currentFilter) === 0}
          className="inline-flex items-center gap-1 rounded border px-2 py-0.5 text-xs hover:bg-muted disabled:opacity-40"
          title="Save current filter"
        >
          <Save className="h-3 w-3" />
          Save
        </button>
      </div>

      {error && <div className="mb-2 rounded bg-destructive/10 px-2 py-1 text-xs text-destructive">{error}</div>}

      {loading && <div className="text-xs text-muted-foreground">Loading…</div>}

      {!loading && filters.length === 0 && (
        <div className="text-xs text-muted-foreground">No saved filters yet.</div>
      )}

      <ul className="flex flex-col gap-1 max-h-[60vh] overflow-y-auto">
        {filters.map(f => {
          const chipCount = countChips(f.conditions as FilterConditionGroup);
          return (
            <li key={f.id}>
              <button
                type="button"
                data-testid={`saved-filter-apply-${f.id}`}
                onClick={() => onApply(f.conditions as FilterConditionGroup)}
                className="flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left text-sm hover:bg-muted"
              >
                <span className="truncate">{f.name}</span>
                <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  {chipCount}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
