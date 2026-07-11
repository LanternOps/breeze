import { useTranslation } from 'react-i18next';
import { i18n } from '@/lib/i18n';
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, ActionError } from '../../lib/runAction';
import { showToast } from '../shared/Toast';
import { navigateTo } from '@/lib/navigation';
import { loginPathWithNext } from '../../lib/authScope';
import { priorityConfig, type TicketPriority } from '../tickets/ticketConfig';
import { formatCurrency } from '@/lib/i18n/format';

interface Category {
  id: string;
  name: string;
  color: string;
  parentId: string | null;
  defaultPriority: string | null;
  responseSlaMinutes: number | null;
  resolutionSlaMinutes: number | null;
  defaultBillable: boolean;
  defaultHourlyRate: string | null;
  sortOrder: number;
  isActive: boolean;
}

interface EditDraft {
  name: string;
  color: string;
  parentId: string;
  defaultPriority: string;
  responseSlaMinutes: string;
  resolutionSlaMinutes: string;
  defaultBillable: boolean;
  defaultHourlyRate: string;
}

// Single comparator shared by hierarchyOrder and moveWithinSiblings — the
// rendered order and the move order MUST agree (sortOrder, name tiebreak), so
// don't fork this.
const byRank = (a: Category, b: Category) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name);

// One level of nesting only — the UI never offers non-root parents and the API
// stays two-level in practice.
function hierarchyOrder(cats: Category[]): Array<Category & { depth: number }> {
  const roots = cats.filter((c) => !c.parentId || !cats.some((p) => p.id === c.parentId));
  const out: Array<Category & { depth: number }> = [];
  for (const r of [...roots].sort(byRank)) {
    out.push({ ...r, depth: 0 });
    for (const ch of cats.filter((c) => c.parentId === r.id).sort(byRank)) {
      out.push({ ...ch, depth: 1 });
    }
  }
  // Defensive: the API tolerates deeper/cyclic parents (PATCH can produce a
  // grandchild whose parent is itself a child); never hide a row from
  // management — append anything not emitted above at depth 0.
  const emitted = new Set(out.map((c) => c.id));
  for (const c of cats.filter((cat) => !emitted.has(cat.id)).sort(byRank)) {
    out.push({ ...c, depth: 0 });
  }
  return out;
}

// Compute the new id order for `id`'s sibling group (same parentId) after a
// one-step move. Returns null when the move would fall off either edge or the
// id is unknown — callers disable the corresponding arrow on null. Shares
// byRank with hierarchyOrder so visual order and move order agree even when
// sortOrder values tie (pre-existing rows all start at 0) — for the normal
// two-level case; rows on hierarchyOrder's defensive orphan path group by
// their raw parentId here and may not be visually adjacent.
export function moveWithinSiblings(cats: Category[], id: string, dir: -1 | 1): string[] | null {
  const target = cats.find((c) => c.id === id);
  if (!target) return null;
  const siblings = cats
    .filter((c) => (c.parentId ?? null) === (target.parentId ?? null))
    .sort(byRank);
  const idx = siblings.findIndex((c) => c.id === id);
  const swap = idx + dir;
  if (swap < 0 || swap >= siblings.length) return null;
  const order = siblings.map((c) => c.id);
  [order[idx], order[swap]] = [order[swap], order[idx]];
  return order;
}

function defaultsSummary(c: Category): string {
  const parts: string[] = [];
  if (c.defaultPriority) parts.push(priorityConfig[c.defaultPriority as TicketPriority]?.label ?? c.defaultPriority);
  if (c.responseSlaMinutes != null) parts.push(i18n.t('settings:ticketCategoriesPage.responseMinutes', { count: c.responseSlaMinutes }));
  if (c.resolutionSlaMinutes != null) parts.push(i18n.t('settings:ticketCategoriesPage.resolveMinutes', { count: c.resolutionSlaMinutes }));
  if (c.defaultHourlyRate) parts.push(i18n.t('settings:ticketCategoriesPage.hourlyRate', { rate: formatCurrency(parseFloat(c.defaultHourlyRate)) }));
  if (c.defaultBillable) parts.push('billable');
  else if (parts.length > 0) parts.push('non-billable');
  return parts.length > 0 ? parts.join(' · ') : '—';
}

const UNAUTHORIZED = () => void navigateTo(loginPathWithNext(), { replace: true });

export default function TicketCategoriesPage() {
  const { t } = useTranslation('settings');
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  // Create form state
  const [name, setName] = useState('');
  const [color, setColor] = useState('#1c8a9e');
  const [createParentId, setCreateParentId] = useState('');

  // Edit state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<EditDraft>({
    name: '', color: '#1c8a9e', parentId: '', defaultPriority: '',
    responseSlaMinutes: '', resolutionSlaMinutes: '', defaultBillable: false, defaultHourlyRate: ''
  });

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const res = await fetchWithAuth('/ticket-categories');
      if (res.ok) setCategories((await res.json()).data ?? []);
      else setError(true);
    } catch {
      setError(true);
    }
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const create = useCallback(async () => {
    if (!name.trim()) return;
    const body: Record<string, unknown> = { name: name.trim(), color };
    if (createParentId) body.parentId = createParentId;
    try {
      await runAction({
        request: () => fetchWithAuth('/ticket-categories', { method: 'POST', body: JSON.stringify(body) }),
        errorFallback: t('ticketCategoriesPage.categoryCreationFailedRetry'),
        successMessage: t('ticketCategoriesPage.categoryCreated', { name: name.trim() }),
        onUnauthorized: UNAUTHORIZED
      });
      setName('');
      setCreateParentId('');
      void load();
    } catch (err) {
      if (!(err instanceof ActionError)) throw err;
    }
  }, [name, color, createParentId, load]);

  const toggleActive = useCallback(async (cat: Category) => {
    try {
      await runAction({
        request: () => fetchWithAuth(`/ticket-categories/${cat.id}`, { method: 'PATCH', body: JSON.stringify({ isActive: !cat.isActive }) }),
        errorFallback: t('ticketCategoriesPage.updateFailedRetry'),
        onUnauthorized: UNAUTHORIZED
      });
      void load();
    } catch (err) {
      if (!(err instanceof ActionError)) throw err;
    }
  }, [load]);

  const startEdit = useCallback((cat: Category) => {
    setEditingId(cat.id);
    setDraft({
      name: cat.name,
      color: cat.color,
      parentId: cat.parentId ?? '',
      defaultPriority: cat.defaultPriority ?? '',
      responseSlaMinutes: cat.responseSlaMinutes?.toString() ?? '',
      resolutionSlaMinutes: cat.resolutionSlaMinutes?.toString() ?? '',
      defaultBillable: cat.defaultBillable,
      defaultHourlyRate: cat.defaultHourlyRate ?? ''
    });
  }, []);

  const saveEdit = useCallback(async (id: string) => {
    if (!draft.name.trim()) return;
    // Number('60a') is NaN and Number('1e999') is Infinity — both JSON-serialize
    // to null, so refuse anything non-finite instead of silently nulling.
    const numeric = [draft.responseSlaMinutes, draft.resolutionSlaMinutes, draft.defaultHourlyRate];
    if (numeric.some((v) => v !== '' && !Number.isFinite(Number(v)))) {
      showToast({ type: 'error', message: t('ticketCategoriesPage.sLAMinutesAndHourlyRateMustBeNumbers') });
      return;
    }
    const payload = {
      name: draft.name.trim(),
      color: draft.color,
      parentId: draft.parentId || null,
      defaultPriority: draft.defaultPriority || null,
      responseSlaMinutes: draft.responseSlaMinutes === '' ? null : Number(draft.responseSlaMinutes),
      resolutionSlaMinutes: draft.resolutionSlaMinutes === '' ? null : Number(draft.resolutionSlaMinutes),
      defaultBillable: draft.defaultBillable,
      defaultHourlyRate: draft.defaultHourlyRate === '' ? null : Number(draft.defaultHourlyRate)
    };
    try {
      await runAction({
        request: () => fetchWithAuth(`/ticket-categories/${id}`, { method: 'PATCH', body: JSON.stringify(payload) }),
        errorFallback: t('ticketCategoriesPage.updateFailedRetry'),
        successMessage: t('ticketCategoriesPage.categoryUpdated'),
        onUnauthorized: UNAUTHORIZED
      });
      setEditingId(null);
      void load();
    } catch (err) {
      if (!(err instanceof ActionError)) throw err;
    }
  }, [draft, load]);

  const move = useCallback(async (cat: Category, dir: -1 | 1) => {
    const order = moveWithinSiblings(categories, cat.id, dir);
    if (!order) return;
    // Optimistic: apply the new ranks locally; restore server truth on failure.
    const rank = new Map(order.map((id, i) => [id, i]));
    setCategories((prev) => prev.map((c) => (rank.has(c.id) ? { ...c, sortOrder: rank.get(c.id)! } : c)));
    try {
      await runAction({
        request: () => fetchWithAuth('/ticket-categories/reorder', { method: 'PUT', body: JSON.stringify({ ids: order }) }),
        errorFallback: t('ticketCategoriesPage.reorderFailedRetry'),
        onUnauthorized: UNAUTHORIZED
      });
    } catch (err) {
      void load();
      if (!(err instanceof ActionError)) throw err;
    }
  }, [categories, load]);

  // Root categories that can be a parent in the create form (active, no parent)
  const createParentOptions = categories.filter((c) => !c.parentId && c.isActive);

  // Parent options for edit: exclude self and self's children
  function editParentOptions(id: string): Category[] {
    const childIds = categories.filter((c) => c.parentId === id).map((c) => c.id);
    const excluded = new Set([id, ...childIds]);
    // Only allow roots (depth=0) as parents; exclude self/children
    return categories.filter((c) => !c.parentId && !excluded.has(c.id));
  }

  const ordered = useMemo(() => hierarchyOrder(categories), [categories]);

  return (
    <div className="max-w-3xl" data-testid="ticket-categories-page">
      <h1 className="text-xl font-semibold" data-testid="ticket-categories-heading">{t('ticketCategoriesPage.ticketing')}</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        {t('ticketCategoriesPage.categoriesOrganizeTheQueueAndCarrySLAAndBillingDefaultsS')}</p>

      <div className="mt-4 flex items-end gap-2">
        <div className="flex-1">
          <label className="text-sm font-medium" htmlFor="cat-name">{t('ticketCategoriesPage.newCategory')}</label>
          <input
            id="cat-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
            data-testid="ticket-categories-name-input"
          />
        </div>
        <input
          type="color"
          value={color}
          onChange={(e) => setColor(e.target.value)}
          className="h-9 w-12 rounded-md border"
          aria-label={t('ticketCategoriesPage.categoryColor')}
          data-testid="ticket-categories-color-input"
        />
        <select
          value={createParentId}
          onChange={(e) => setCreateParentId(e.target.value)}
          className="rounded-md border bg-background px-2.5 py-1.5 text-sm"
          aria-label={t('ticketCategoriesPage.parentCategory')}
          data-testid="ticket-categories-parent-input"
        >
          <option value="">{t('ticketCategoriesPage.none')}</option>
          {createParentOptions.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => void create()}
          disabled={!name.trim()}
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          data-testid="ticket-categories-create-button"
        >
          {t('ticketCategoriesPage.add')}</button>
      </div>

      <table className="mt-4 min-w-full divide-y" data-testid="ticket-categories-table">
        <thead className="bg-muted/40">
          <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <th className="px-4 py-2">{t('ticketCategoriesPage.name')}</th>
            <th className="px-4 py-2">{t('ticketCategoriesPage.defaults')}</th>
            <th className="px-4 py-2">{t('ticketCategoriesPage.status')}</th>
            <th className="px-4 py-2" />
          </tr>
        </thead>
        <tbody className="divide-y">
          {loading ? (
            <tr><td colSpan={4} className="px-4 py-6 text-center text-sm text-muted-foreground">{t('ticketCategoriesPage.loading')}</td></tr>
          ) : error ? (
            <tr>
              <td colSpan={4} className="px-4 py-6 text-center text-sm text-muted-foreground" data-testid="ticket-categories-error">
                {t('ticketCategoriesPage.categoriesFailedToLoad')}{' '}
                <button type="button" onClick={() => void load()} className="underline hover:text-foreground" data-testid="ticket-categories-retry">{t('ticketCategoriesPage.retry')}</button>
              </td>
            </tr>
          ) : categories.length === 0 ? (
            <tr>
              <td colSpan={4} className="px-4 py-6 text-center text-sm text-muted-foreground" data-testid="ticket-categories-empty">
                {t('ticketCategoriesPage.noCategoriesYetAddTheFirstOneAbove')}</td>
            </tr>
          ) : ordered.map((c) => (
            <Fragment key={c.id}>
              <tr key={c.id} data-testid={`ticket-category-row-${c.id}`} data-depth={c.depth}>
                <td className={`px-4 py-2 text-sm${c.depth > 0 ? ' pl-10' : ''}`}>
                  <span className="mr-1.5 inline-block h-3 w-3 rounded-sm align-middle" style={{ backgroundColor: c.color }} />
                  {c.name}
                </td>
                <td className="px-4 py-2 text-sm text-muted-foreground">{defaultsSummary(c)}</td>
                <td className="px-4 py-2 text-sm">{c.isActive ? t('ticketCategoriesPage.active') : t('ticketCategoriesPage.inactive')}</td>
                <td className="px-4 py-2 text-right space-x-2">
                  <button
                    type="button"
                    onClick={() => void move(c, -1)}
                    disabled={moveWithinSiblings(categories, c.id, -1) === null}
                    className="text-sm text-muted-foreground hover:text-foreground disabled:opacity-30"
                    aria-label={t('ticketCategoriesPage.moveUp', { name: c.name })}
                    data-testid={`ticket-category-move-up-${c.id}`}
                  >
                    ▲
                  </button>
                  <button
                    type="button"
                    onClick={() => void move(c, 1)}
                    disabled={moveWithinSiblings(categories, c.id, 1) === null}
                    className="text-sm text-muted-foreground hover:text-foreground disabled:opacity-30"
                    aria-label={t('ticketCategoriesPage.moveDown', { name: c.name })}
                    data-testid={`ticket-category-move-down-${c.id}`}
                  >
                    ▼
                  </button>
                  <button
                    type="button"
                    onClick={() => startEdit(c)}
                    className="text-sm text-muted-foreground hover:text-foreground"
                    data-testid={`ticket-category-edit-${c.id}`}
                  >
                    {t('ticketCategoriesPage.edit')}</button>
                  <button
                    type="button"
                    onClick={() => void toggleActive(c)}
                    className="text-sm text-muted-foreground hover:text-foreground"
                    data-testid={`ticket-category-toggle-${c.id}`}
                  >
                    {c.isActive ? t('ticketCategoriesPage.deactivate') : t('ticketCategoriesPage.activate')}
                  </button>
                </td>
              </tr>
              {editingId === c.id && (
                <tr key={`edit-${c.id}`}>
                  <td colSpan={4} className="bg-muted/30 px-4 py-3">
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="text-xs font-medium" htmlFor="edit-name">{t('ticketCategoriesPage.name')}</label>
                        <input
                          value={draft.name}
                          onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                          className="w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
                          id="edit-name"
                          data-testid="ticket-category-edit-name"
                        />
                      </div>
                      <div>
                        <label className="text-xs font-medium" htmlFor="edit-color">{t('ticketCategoriesPage.color')}</label>
                        <input
                          type="color"
                          value={draft.color}
                          onChange={(e) => setDraft((d) => ({ ...d, color: e.target.value }))}
                          className="h-9 w-full rounded-md border"
                          id="edit-color"
                          data-testid="ticket-category-edit-color"
                        />
                      </div>
                      <div>
                        <label className="text-xs font-medium" htmlFor="edit-parent">{t('ticketCategoriesPage.parent')}</label>
                        <select
                          value={draft.parentId}
                          onChange={(e) => setDraft((d) => ({ ...d, parentId: e.target.value }))}
                          className="w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
                          id="edit-parent"
                          data-testid="ticket-category-edit-parent"
                        >
                          <option value="">{t('ticketCategoriesPage.none')}</option>
                          {editParentOptions(c.id).map((p) => (
                            <option key={p.id} value={p.id}>{p.name}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="text-xs font-medium" htmlFor="edit-priority">{t('ticketCategoriesPage.defaultPriority')}</label>
                        <select
                          value={draft.defaultPriority}
                          onChange={(e) => setDraft((d) => ({ ...d, defaultPriority: e.target.value }))}
                          className="w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
                          id="edit-priority"
                          data-testid="ticket-category-edit-priority"
                        >
                          <option value="">{t('ticketCategoriesPage.none')}</option>
                          {(Object.keys(priorityConfig) as TicketPriority[]).map((p) => (
                            <option key={p} value={p}>{priorityConfig[p].label}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="text-xs font-medium" htmlFor="edit-response-sla">{t('ticketCategoriesPage.responseSLAMinutes')}</label>
                        <input
                          type="number"
                          min={1}
                          value={draft.responseSlaMinutes}
                          onChange={(e) => setDraft((d) => ({ ...d, responseSlaMinutes: e.target.value }))}
                          className="w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
                          id="edit-response-sla"
                          data-testid="ticket-category-edit-response-sla"
                        />
                      </div>
                      <div>
                        <label className="text-xs font-medium" htmlFor="edit-resolution-sla">{t('ticketCategoriesPage.resolutionSLAMinutes')}</label>
                        <input
                          type="number"
                          min={1}
                          value={draft.resolutionSlaMinutes}
                          onChange={(e) => setDraft((d) => ({ ...d, resolutionSlaMinutes: e.target.value }))}
                          className="w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
                          id="edit-resolution-sla"
                          data-testid="ticket-category-edit-resolution-sla"
                        />
                      </div>
                      <div className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          id={`billable-${c.id}`}
                          checked={draft.defaultBillable}
                          onChange={(e) => setDraft((d) => ({ ...d, defaultBillable: e.target.checked }))}
                          data-testid="ticket-category-edit-billable"
                        />
                        <label htmlFor={`billable-${c.id}`} className="text-xs font-medium">{t('ticketCategoriesPage.billableByDefault')}</label>
                      </div>
                      <div>
                        <label className="text-xs font-medium" htmlFor="edit-rate">{t('ticketCategoriesPage.defaultHourlyRate')}</label>
                        <input
                          type="number"
                          min={0}
                          step={0.01}
                          value={draft.defaultHourlyRate}
                          onChange={(e) => setDraft((d) => ({ ...d, defaultHourlyRate: e.target.value }))}
                          className="w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
                          id="edit-rate"
                          data-testid="ticket-category-edit-rate"
                        />
                      </div>
                    </div>
                    <div className="mt-3 flex gap-2">
                      <button
                        type="button"
                        onClick={() => void saveEdit(c.id)}
                        disabled={!draft.name.trim()}
                        className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                        data-testid={`ticket-category-save-${c.id}`}
                      >
                        {t('ticketCategoriesPage.save')}</button>
                      <button
                        type="button"
                        onClick={() => setEditingId(null)}
                        className="rounded-md border px-3 py-1.5 text-sm font-medium"
                        data-testid={`ticket-category-cancel-${c.id}`}
                      >
                        {t('ticketCategoriesPage.cancel')}</button>
                    </div>
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}
