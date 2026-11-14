// SavedViewsMenu — the "Views" control for the Devices filter toolbar. Lets a
// user save the current filter group as a named, reusable view and re-apply it
// later in one click. Views are RECALL (pick from a list), kept in their own
// ghost menu so they don't crowd the chip row (which is for BUILDING a filter).
//
// Persistence reuses the existing saved-filters backend (GET/POST/DELETE
// /filters); the conditions column stores the FilterConditionGroup verbatim.
// Saved filters are org-owned (saved_filters.org_id NOT NULL), so a save names
// its org in the body: the selected org in a focused view, or an org picked in
// the name row in the All-organizations view (#11879, same rule as #8330). The
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
import { useClickOutside } from '../../hooks/useClickOutside';
import { useFleetOrgOwner } from '../../hooks/useFleetOrgOwner';
import { ActionError, handleActionError, runAction } from '../../lib/runAction';
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
  const fleet = useFleetOrgOwner();
  const [open, setOpen] = useState(false);
  const [views, setViews] = useState<SavedFilter[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  // Shown when Save is pressed before the org scope has resolved (org list
  // loading or failed, nothing selected): there is no owner org to send.
  const [orgRequired, setOrgRequired] = useState(false);
  const [defaultId, setDefaultId] = useState<string | null>(() => readDefaultViewId());
  const rootRef = useRef<HTMLDivElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
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
    if (fleet.needsOrgSelection) {
      // All-organizations view: Save stays disabled until an org is picked, so
      // this is the Enter key. Unresolved scope: say why nothing happened.
      if (!fleet.isFleetScope) setOrgRequired(true);
      return;
    }
    setOrgRequired(false);
    setSaving(true);
    try {
      await runAction({
        request: () =>
          fetchWithAuth('/filters', {
            method: 'POST',
            body: JSON.stringify({ name: trimmed, conditions: value, orgId: fleet.bodyOrgId }),
          }),
        errorFallback: t('savedViewsMenu.toasts.saveFailed'),
        successMessage: t('savedViewsMenu.toasts.saved', { name: trimmed }),
      });
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      // runAction already toasted an ActionError. The name row stays open so
      // the user can correct and retry.
      if (!(err instanceof ActionError)) {
        showToast({ type: 'error', message: t('savedViewsMenu.toasts.saveFailed') });
      }
      return;
    } finally {
      setSaving(false);
    }
    setName('');
    setNaming(false);
    await fetchViews();
  };

  const remove = async (view: SavedFilter) => {
    try {
      await runAction({
        request: () => fetchWithAuth(`/filters/${view.id}`, { method: 'DELETE' }),
        errorFallback: t('savedViewsMenu.toasts.deleteFailed'),
        successMessage: t('savedViewsMenu.toasts.deleted', { name: view.name }),
      });
    } catch (err) {
      handleActionError(err, t('savedViewsMenu.toasts.deleteFailed'));
      return;
    }
    if (defaultId === view.id) {
      writeDefaultViewId(null);
      setDefaultId(null);
    }
    await fetchViews();
  };

  const toggleDefault = (view: SavedFilter) => {
    const next = defaultId === view.id ? null : view.id;
    writeDefaultViewId(next);
    setDefaultId(next);
  };

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        ref={triggerRef}
        type="button"
        data-testid="saved-views-button"
        aria-haspopup="dialog"
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
        // #9037: a dialog, not a menu — it holds buttons, a star toggle and a
        // name input. Escape closes and hands focus back to the trigger (while
        // naming, Escape only cancels the name input); below
        // `sm` it pins to the viewport gutters instead of hanging off the left
        // edge from its right-aligned anchor.
        <div
          data-testid="saved-views-menu"
          role="dialog"
          aria-modal="false"
          aria-label={t('savedViewsMenu.title')}
          onKeyDown={(e) => {
            if (e.key !== 'Escape' || naming) return;
            e.stopPropagation();
            setOpen(false);
            triggerRef.current?.focus();
          }}
          className="absolute right-0 top-9 z-30 w-72 rounded-md border bg-popover p-1 shadow-lg max-sm:fixed max-sm:inset-x-4 max-sm:top-auto max-sm:mt-1 max-sm:w-auto"
        >
          <p className="px-2 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
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
            <div className="space-y-1.5 px-2 py-1.5">
              {/* All-organizations view: a new view needs an owning org (#11879). */}
              {fleet.isFleetScope && (
                <div>
                  <select
                    data-testid="saved-view-org-picker"
                    aria-label={t('common:labels.organization')}
                    value={fleet.orgId}
                    onChange={e => fleet.setOrgId(e.target.value)}
                    className="h-8 w-full rounded border bg-background px-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                  >
                    <option value="" disabled>
                      {t('common:layout.org.noSelection')}
                    </option>
                    {fleet.organizations.map(org => (
                      <option key={org.id} value={org.id}>
                        {org.name}
                      </option>
                    ))}
                  </select>
                  {!fleet.orgId && (
                    <p data-testid="saved-view-org-hint" className="mt-1 text-xs text-muted-foreground">
                      {t('savedViewsMenu.ownerOrgHint')}
                    </p>
                  )}
                </div>
              )}
              <div className="flex items-center gap-1.5">
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
                    if (e.key === 'Escape') { setNaming(false); setName(''); setOrgRequired(false); }
                  }}
                  className="h-8 w-full rounded border bg-background px-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                />
                <button
                  type="button"
                  data-testid="saved-view-save-confirm"
                  onClick={() => void saveCurrent()}
                  disabled={!name.trim() || saving || (fleet.isFleetScope && !fleet.orgId)}
                  className="inline-flex h-8 shrink-0 items-center rounded bg-primary px-2.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
                >
                  {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : t('common:actions.save')}
                </button>
              </div>
              {orgRequired && (
                <p data-testid="saved-view-org-required" role="alert" className="text-xs text-destructive">
                  {t('common:layout.orgRequired.title')}
                </p>
              )}
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
