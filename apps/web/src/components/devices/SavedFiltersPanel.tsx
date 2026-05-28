// SavedFiltersPanel — compact "Saved" + "Save" buttons that fit in the
// FilterChipBar's top-right slot, alongside the keyboard-help icon.
//
// Earlier this lived as a tall left-rail column and pushed the device list
// off-screen as soon as the user accumulated more than a few filters. The
// popover form keeps the same testid hooks (saved-filter-apply-<id>,
// saved-filter-delete-<id>) and adds saved-filters-toggle for open/close.
//
// Edit-conditions UX (per Billy 2026-05-28):
//   - Pencil on a row applies that filter AND enters "edit mode" — the next
//     Save button click does PATCH instead of POST + prompt, so the user can
//     modify chips and update the existing filter in place.
//   - Delete is immediate, no confirm dialog (intentional click is enough).
//   - Save button label flips to "Update <name>" while in edit mode.
//   - Applying a different filter clears edit mode.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BookmarkIcon, Save, ChevronDown, Pencil, Trash2 } from 'lucide-react';
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

// Same sizing as the Chip/Advanced segment buttons in FilterChipBar so the
// trio lines up.
const TRIGGER_BTN = 'inline-flex items-center gap-1 rounded border bg-card px-2 py-0.5 text-xs hover:bg-muted disabled:opacity-40';

export function SavedFiltersPanel({ currentFilter, onApply, saveTrigger }: SavedFiltersPanelProps) {
  const [filters, setFilters] = useState<SavedFilter[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

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

  // Close popover on outside click or Escape.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const sortedFilters = useMemo(
    () =>
      [...filters].sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })
      ),
    [filters]
  );

  const editingFilter = useMemo(
    () => filters.find(f => f.id === editingId) ?? null,
    [filters, editingId]
  );

  const handleApply = useCallback((f: SavedFilter) => {
    onApply(f.conditions as FilterConditionGroup);
    setEditingId(null); // applying clears any in-progress edit
    setOpen(false);
  }, [onApply]);

  const handleEdit = useCallback((f: SavedFilter) => {
    onApply(f.conditions as FilterConditionGroup);
    setEditingId(f.id); // next Save will PATCH this filter
    setOpen(false);
  }, [onApply]);

  const handleDelete = useCallback(async (filter: SavedFilter) => {
    setError(null);
    try {
      const res = await fetchWithAuth(`/filters/${filter.id}`, { method: 'DELETE' });
      if (res.ok) {
        if (editingId === filter.id) setEditingId(null);
        await refresh();
      } else {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? `Delete failed (${res.status})`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed');
    }
  }, [refresh, editingId]);

  const handleSave = useCallback(async () => {
    if (!currentFilter || countChips(currentFilter) === 0) return;
    setSaving(true);
    setError(null);
    try {
      if (editingFilter) {
        // Update existing filter — no name prompt, keep current name.
        const res = await fetchWithAuth(`/filters/${editingFilter.id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ conditions: currentFilter })
        });
        if (res.ok) {
          setEditingId(null);
          await refresh();
        } else {
          const body = await res.json().catch(() => ({}));
          setError(body.error ?? `Update failed (${res.status})`);
        }
      } else {
        // Create new filter — prompt for name.
        const name = window.prompt('Name this filter:');
        if (!name) return;
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
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }, [currentFilter, refresh, editingFilter]);

  // React to parent's Ctrl+S trigger. Skip the initial mount value (0).
  useEffect(() => {
    if (!saveTrigger) return;
    void handleSave();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saveTrigger]);

  const filterCount = filters.length;
  const canSave = countChips(currentFilter) > 0 && !saving;
  const saveLabel = editingFilter ? `Update ${editingFilter.name}` : 'Save';

  return (
    <div ref={wrapperRef} data-testid="saved-filters-panel" className="relative inline-flex items-center gap-1">
      <button
        type="button"
        data-testid="saved-filters-toggle"
        onClick={() => setOpen(o => !o)}
        className={TRIGGER_BTN}
        aria-expanded={open}
        aria-haspopup="listbox"
      >
        <BookmarkIcon className="h-3 w-3" />
        <span>Saved</span>
        {filterCount > 0 && (
          <span className="rounded-full bg-muted px-1 py-0 text-[10px] text-muted-foreground">
            {filterCount}
          </span>
        )}
        <ChevronDown className={`h-3 w-3 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      <button
        type="button"
        data-testid="saved-filter-save-button"
        onClick={handleSave}
        disabled={!canSave}
        className={TRIGGER_BTN}
        title={editingFilter ? `Update existing filter "${editingFilter.name}"` : 'Save current chips as a new filter'}
      >
        <Save className="h-3 w-3" />
        <span className="max-w-[12rem] truncate">{saveLabel}</span>
      </button>

      {open && (
        <div
          className="absolute right-0 top-full z-50 mt-1 w-72 rounded-md border bg-card p-2 shadow-lg"
          role="listbox"
        >
          {error && (
            <div className="mb-2 rounded bg-destructive/10 px-2 py-1 text-xs text-destructive">
              {error}
            </div>
          )}
          {loading && (
            <div className="px-2 py-1 text-xs text-muted-foreground">Loading…</div>
          )}
          {!loading && filters.length === 0 && (
            <div className="px-2 py-1 text-xs text-muted-foreground">
              No saved filters yet.
            </div>
          )}
          {!loading && filters.length > 0 && (
            <ul className="flex max-h-[60vh] flex-col gap-0.5 overflow-y-auto">
              {sortedFilters.map(f => {
                const chipCount = countChips(f.conditions as FilterConditionGroup);
                const isEditing = f.id === editingId;
                return (
                  <li
                    key={f.id}
                    className={`group flex items-center gap-1 rounded hover:bg-muted ${isEditing ? 'ring-1 ring-primary/40' : ''}`}
                  >
                    <button
                      type="button"
                      data-testid={`saved-filter-apply-${f.id}`}
                      onClick={() => handleApply(f)}
                      className="flex min-w-0 flex-1 items-center justify-between gap-2 px-2 py-1 text-left text-sm"
                    >
                      <span className="truncate">{f.name}</span>
                      <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground group-hover:bg-background">
                        {chipCount}
                      </span>
                    </button>
                    <button
                      type="button"
                      data-testid={`saved-filter-edit-${f.id}`}
                      onClick={(e) => { e.stopPropagation(); handleEdit(f); }}
                      className="shrink-0 rounded p-1 opacity-0 transition hover:bg-background group-hover:opacity-100 focus:opacity-100"
                      title="Edit conditions"
                      aria-label={`Edit ${f.name}`}
                    >
                      <Pencil className="h-3 w-3" />
                    </button>
                    <button
                      type="button"
                      data-testid={`saved-filter-delete-${f.id}`}
                      onClick={(e) => { e.stopPropagation(); void handleDelete(f); }}
                      className="shrink-0 rounded p-1 opacity-0 transition hover:bg-background hover:text-destructive group-hover:opacity-100 focus:opacity-100"
                      title="Delete"
                      aria-label={`Delete ${f.name}`}
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
