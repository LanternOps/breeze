// SavedViewsMenu — the "Views" control for the Devices filter toolbar. Lets a
// user save the current filter group as a named, reusable view and re-apply it
// later in one click. Views are RECALL (pick from a list), kept in their own
// ghost menu so they don't crowd the chip row (which is for BUILDING a filter).
//
// Persistence reuses the existing saved-filters backend (GET/POST/DELETE
// /filters); the conditions column stores the FilterConditionGroup verbatim. The
// device quick-search is deliberately NOT part of a view — it's a transient
// lookup, not a reusable saved query.
//
// "Default view" has no backend column, so it's a per-browser preference in
// localStorage (like density / page-size). When set and no filter is active on
// load, the default view auto-applies once.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bookmark, Plus, Star, Trash2, Loader2, Check, ExternalLink } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { FilterConditionGroup, SavedFilter } from '@breeze/shared';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';
import { useClickOutside } from '../../hooks/useClickOutside';
import { showToast } from '../shared/Toast';

const DEFAULT_VIEW_KEY = 'breeze.devices.defaultView';

function readDefaultViewId(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(DEFAULT_VIEW_KEY);
  } catch {
    return null;
  }
}

function writeDefaultViewId(id: string | null) {
  try {
    if (id) window.localStorage.setItem(DEFAULT_VIEW_KEY, id);
    else window.localStorage.removeItem(DEFAULT_VIEW_KEY);
  } catch {
    // localStorage can throw in private mode / quota; the default view is a
    // nicety, never block on it.
  }
}

// Canonical JSON with recursively-sorted object keys. Saved conditions round-
// trip through a Postgres `jsonb` column, which does NOT preserve object key
// order, so a naive JSON.stringify compare against the live (in-memory) group
// spuriously mismatches. Sorting keys makes the compare order-independent.
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.keys(v as Record<string, unknown>)
        .sort()
        .map(k => [k, canonical((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}

// Stable structural compare so we can tell when the live filter exactly matches
// a saved view (→ show its name as the active view). Conditions are small.
function sameGroup(a: FilterConditionGroup | null, b: FilterConditionGroup | null): boolean {
  return JSON.stringify(canonical(a ?? null)) === JSON.stringify(canonical(b ?? null));
}

export interface SavedViewsMenuProps {
  // The current filter group (what a "Save current as view" would persist).
  value: FilterConditionGroup | null;
  // Apply a saved view's conditions (or null to clear).
  onApply: (group: FilterConditionGroup | null) => void;
}

export function SavedViewsMenu({ value, onApply }: SavedViewsMenuProps) {
  const { t } = useTranslation('devices');
  const currentOrgId = useOrgStore(s => s.currentOrgId);
  const [open, setOpen] = useState(false);
  const [views, setViews] = useState<SavedFilter[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [defaultId, setDefaultId] = useState<string | null>(() => readDefaultViewId());
  const rootRef = useRef<HTMLDivElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  // One-shot guard so the default view auto-applies at most once per mount.
  const autoAppliedRef = useRef(false);

  useClickOutside(open, rootRef, () => {
    setOpen(false);
    setNaming(false);
  });

  const fetchViews = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchWithAuth('/filters');
      if (res.ok) {
        const data = await res.json();
        setViews(data.data ?? data.filters ?? []);
      }
    } catch {
      // Saved views are optional; a fetch failure shouldn't break filtering.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchViews();
  }, [fetchViews]);

  // Auto-apply the default view once, only when nothing is filtered yet (no URL
  // hash seeded a group). Runs after the first fetch resolves.
  useEffect(() => {
    if (autoAppliedRef.current || loading) return;
    if (value !== null) {
      // A filter is already active (e.g. shared URL hash) — never override it.
      autoAppliedRef.current = true;
      return;
    }
    const def = defaultId ? views.find(v => v.id === defaultId) : null;
    if (def) {
      autoAppliedRef.current = true;
      onApply(def.conditions);
    }
  }, [loading, views, defaultId, value, onApply]);

  useEffect(() => {
    if (naming) nameInputRef.current?.focus();
  }, [naming]);

  const activeView = useMemo(
    () => views.find(v => sameGroup(v.conditions, value)) ?? null,
    [views, value],
  );

  const hasFilter = value !== null && value.conditions.length > 0;

  const apply = (view: SavedFilter) => {
    onApply(view.conditions);
    setOpen(false);
  };

  const saveCurrent = async () => {
    const trimmed = name.trim();
    if (!trimmed || !value || saving) return;
    setSaving(true);
    try {
      const res = await fetchWithAuth('/filters', {
        method: 'POST',
        body: JSON.stringify({
          name: trimmed,
          conditions: value,
          ...(currentOrgId ? { orgId: currentOrgId } : {}),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        showToast({ type: 'error', message: body.error ?? t('savedViewsMenu.toasts.saveFailed') });
        return;
      }
      showToast({ type: 'success', message: t('savedViewsMenu.toasts.saved', { name: trimmed }) });
      setName('');
      setNaming(false);
      await fetchViews();
    } catch {
      showToast({ type: 'error', message: t('savedViewsMenu.toasts.saveFailed') });
    } finally {
      setSaving(false);
    }
  };

  const remove = async (view: SavedFilter) => {
    try {
      const res = await fetchWithAuth(`/filters/${view.id}`, { method: 'DELETE' });
      if (!res.ok) {
        showToast({ type: 'error', message: t('savedViewsMenu.toasts.deleteFailed') });
        return;
      }
      if (defaultId === view.id) {
        writeDefaultViewId(null);
        setDefaultId(null);
      }
      showToast({ type: 'success', message: t('savedViewsMenu.toasts.deleted', { name: view.name }) });
      await fetchViews();
    } catch {
      showToast({ type: 'error', message: t('savedViewsMenu.toasts.deleteFailed') });
    }
  };

  const toggleDefault = (view: SavedFilter) => {
    const next = defaultId === view.id ? null : view.id;
    writeDefaultViewId(next);
    setDefaultId(next);
  };

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        data-testid="saved-views-button"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
        className={`inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors ${
          open || activeView ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground'
        }`}
        title={t('savedViewsMenu.title')}
      >
        <Bookmark className="h-3.5 w-3.5" />
        <span className="max-w-40 truncate">{activeView ? activeView.name : t('savedViewsMenu.views')}</span>
      </button>

      {open && (
        <div
          data-testid="saved-views-menu"
          role="menu"
          className="absolute right-0 top-9 z-30 w-72 rounded-md border bg-popover p-1 shadow-lg"
        >
          <p className="px-2 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            {t('savedViewsMenu.title')}
          </p>

          {loading ? (
            <div className="flex items-center gap-2 px-2 py-3 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> {t('common:states.loading')}
            </div>
          ) : views.length === 0 ? (
            <p className="px-2 py-3 text-sm text-muted-foreground">
              {t('savedViewsMenu.empty')}
            </p>
          ) : (
            <div className="max-h-64 overflow-y-auto">
              {views.map(view => {
                const isActive = sameGroup(view.conditions, value);
                const isDefault = defaultId === view.id;
                return (
                  <div
                    key={view.id}
                    data-testid={`saved-view-${view.id}`}
                    className={`group flex items-center gap-1 rounded px-2 py-1.5 text-sm hover:bg-muted ${
                      isActive ? 'bg-muted' : ''
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => apply(view)}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      title={t('savedViewsMenu.applyTitle', { name: view.name })}
                    >
                      {isActive ? (
                        <Check className="h-3.5 w-3.5 shrink-0 text-primary" />
                      ) : (
                        <span className="h-3.5 w-3.5 shrink-0" />
                      )}
                      <span className="truncate">{view.name}</span>
                    </button>
                    <button
                      type="button"
                      data-testid={`saved-view-default-${view.id}`}
                      onClick={() => toggleDefault(view)}
                      title={isDefault ? t('savedViewsMenu.defaultAppliedTitle') : t('savedViewsMenu.setDefaultTitle')}
                      aria-pressed={isDefault}
                      className="shrink-0 rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground"
                    >
                      <Star className={`h-3.5 w-3.5 ${isDefault ? 'fill-warning text-warning' : ''}`} />
                    </button>
                    <button
                      type="button"
                      data-testid={`saved-view-delete-${view.id}`}
                      onClick={() => remove(view)}
                      title={t('savedViewsMenu.deleteTitle', { name: view.name })}
                      className="shrink-0 rounded p-1 text-muted-foreground hover:bg-background hover:text-destructive"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          <hr className="my-1" />

          {naming ? (
            <div className="flex items-center gap-1.5 px-2 py-1.5">
              <input
                ref={nameInputRef}
                type="text"
                data-testid="saved-view-name-input"
                placeholder={t('savedViewsMenu.viewNamePlaceholder')}
                value={name}
                maxLength={200}
                onChange={e => setName(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') void saveCurrent();
                  if (e.key === 'Escape') { setNaming(false); setName(''); }
                }}
                className="h-8 w-full rounded border bg-background px-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              />
              <button
                type="button"
                data-testid="saved-view-save-confirm"
                onClick={() => void saveCurrent()}
                disabled={!name.trim() || saving}
                className="inline-flex h-8 shrink-0 items-center rounded bg-primary px-2.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
              >
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : t('common:actions.save')}
              </button>
            </div>
          ) : (
            <button
              type="button"
              data-testid="saved-view-save-current"
              onClick={() => setNaming(true)}
              disabled={!hasFilter}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:text-muted-foreground disabled:hover:bg-transparent"
              title={hasFilter ? t('savedViewsMenu.saveCurrentTitle') : t('savedViewsMenu.buildFilterFirst')}
            >
              <Plus className="h-3.5 w-3.5 shrink-0" />
              {t('savedViewsMenu.saveCurrent')}
            </button>
          )}

          <a
            href="/settings/filters"
            className="flex items-center gap-2 rounded px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <ExternalLink className="h-3.5 w-3.5 shrink-0" />
            {t('savedViewsMenu.manageAll')}
          </a>
        </div>
      )}
    </div>
  );
}
