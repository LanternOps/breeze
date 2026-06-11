import { useCallback, useEffect, useState } from 'react';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, ActionError } from '../../lib/runAction';
import { navigateTo } from '@/lib/navigation';
import { loginPathWithNext } from '../../lib/authScope';

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

function hierarchyOrder(cats: Category[]): Array<Category & { depth: number }> {
  const byRank = (a: Category, b: Category) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name);
  const roots = cats.filter((c) => !c.parentId || !cats.some((p) => p.id === c.parentId));
  const out: Array<Category & { depth: number }> = [];
  for (const r of [...roots].sort(byRank)) {
    out.push({ ...r, depth: 0 });
    for (const ch of cats.filter((c) => c.parentId === r.id).sort(byRank)) {
      out.push({ ...ch, depth: 1 });
    }
  }
  return out;
}

function defaultsSummary(c: Category): string {
  const parts: string[] = [];
  if (c.defaultPriority) parts.push(c.defaultPriority.charAt(0).toUpperCase() + c.defaultPriority.slice(1));
  if (c.responseSlaMinutes != null) parts.push(`${c.responseSlaMinutes}m response`);
  if (c.resolutionSlaMinutes != null) parts.push(`${c.resolutionSlaMinutes}m resolve`);
  if (c.defaultHourlyRate) parts.push(`$${c.defaultHourlyRate}/h`);
  if (c.defaultBillable) parts.push('billable');
  else if (parts.length > 0) parts.push('non-billable');
  return parts.length > 0 ? parts.join(' · ') : '—';
}

const UNAUTHORIZED = () => void navigateTo(loginPathWithNext(), { replace: true });

export default function TicketCategoriesPage() {
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
        errorFallback: 'Category creation failed. Retry.',
        successMessage: `Category "${name.trim()}" created`,
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
        errorFallback: 'Update failed. Retry.',
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
        errorFallback: 'Update failed. Retry.',
        successMessage: 'Category updated',
        onUnauthorized: UNAUTHORIZED
      });
      setEditingId(null);
      void load();
    } catch (err) {
      if (!(err instanceof ActionError)) throw err;
    }
  }, [draft, load]);

  // Root categories that can be a parent in the create form (active, no parent)
  const createParentOptions = categories.filter((c) => !c.parentId && c.isActive);

  // Parent options for edit: exclude self and self's children
  function editParentOptions(id: string): Category[] {
    const childIds = categories.filter((c) => c.parentId === id).map((c) => c.id);
    const excluded = new Set([id, ...childIds]);
    // Only allow roots (depth=0) as parents; exclude self/children
    return categories.filter((c) => !c.parentId && !excluded.has(c.id));
  }

  const ordered = hierarchyOrder(categories);

  return (
    <div className="max-w-3xl" data-testid="ticket-categories-page">
      <h1 className="text-xl font-semibold" data-testid="ticket-categories-heading">Ticketing</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Categories organize the queue and carry SLA and billing defaults (SLA enforcement arrives with the SLA engine).
      </p>

      <div className="mt-4 flex items-end gap-2">
        <div className="flex-1">
          <label className="text-sm font-medium" htmlFor="cat-name">New category</label>
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
          aria-label="Category color"
          data-testid="ticket-categories-color-input"
        />
        <select
          value={createParentId}
          onChange={(e) => setCreateParentId(e.target.value)}
          className="rounded-md border bg-background px-2.5 py-1.5 text-sm"
          aria-label="Parent category"
          data-testid="ticket-categories-parent-input"
        >
          <option value="">None</option>
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
          Add
        </button>
      </div>

      <table className="mt-4 min-w-full divide-y" data-testid="ticket-categories-table">
        <thead className="bg-muted/40">
          <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <th className="px-4 py-2">Name</th>
            <th className="px-4 py-2">Defaults</th>
            <th className="px-4 py-2">Status</th>
            <th className="px-4 py-2" />
          </tr>
        </thead>
        <tbody className="divide-y">
          {loading ? (
            <tr><td colSpan={4} className="px-4 py-6 text-center text-sm text-muted-foreground">Loading.</td></tr>
          ) : error ? (
            <tr>
              <td colSpan={4} className="px-4 py-6 text-center text-sm text-muted-foreground" data-testid="ticket-categories-error">
                Categories failed to load.{' '}
                <button type="button" onClick={() => void load()} className="underline hover:text-foreground" data-testid="ticket-categories-retry">Retry</button>
              </td>
            </tr>
          ) : categories.length === 0 ? (
            <tr>
              <td colSpan={4} className="px-4 py-6 text-center text-sm text-muted-foreground" data-testid="ticket-categories-empty">
                No categories yet. Add the first one above.
              </td>
            </tr>
          ) : ordered.map((c) => (
            <>
              <tr key={c.id} data-testid={`ticket-category-row-${c.id}`} data-depth={c.depth}>
                <td className={`px-4 py-2 text-sm${c.depth > 0 ? ' pl-10' : ''}`}>
                  <span className="mr-1.5 inline-block h-3 w-3 rounded-sm align-middle" style={{ backgroundColor: c.color }} />
                  {c.name}
                </td>
                <td className="px-4 py-2 text-sm text-muted-foreground">{defaultsSummary(c)}</td>
                <td className="px-4 py-2 text-sm">{c.isActive ? 'Active' : 'Inactive'}</td>
                <td className="px-4 py-2 text-right space-x-2">
                  <button
                    type="button"
                    onClick={() => startEdit(c)}
                    className="text-sm text-muted-foreground hover:text-foreground"
                    data-testid={`ticket-category-edit-${c.id}`}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => void toggleActive(c)}
                    className="text-sm text-muted-foreground hover:text-foreground"
                    data-testid={`ticket-category-toggle-${c.id}`}
                  >
                    {c.isActive ? 'Deactivate' : 'Activate'}
                  </button>
                </td>
              </tr>
              {editingId === c.id && (
                <tr key={`edit-${c.id}`}>
                  <td colSpan={4} className="bg-muted/30 px-4 py-3">
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="text-xs font-medium">Name</label>
                        <input
                          value={draft.name}
                          onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                          className="w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
                          data-testid="ticket-category-edit-name"
                        />
                      </div>
                      <div>
                        <label className="text-xs font-medium">Color</label>
                        <input
                          type="color"
                          value={draft.color}
                          onChange={(e) => setDraft((d) => ({ ...d, color: e.target.value }))}
                          className="h-9 w-full rounded-md border"
                          data-testid="ticket-category-edit-color"
                        />
                      </div>
                      <div>
                        <label className="text-xs font-medium">Parent</label>
                        <select
                          value={draft.parentId}
                          onChange={(e) => setDraft((d) => ({ ...d, parentId: e.target.value }))}
                          className="w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
                          data-testid="ticket-category-edit-parent"
                        >
                          <option value="">None</option>
                          {editParentOptions(c.id).map((p) => (
                            <option key={p.id} value={p.id}>{p.name}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="text-xs font-medium">Default priority</label>
                        <select
                          value={draft.defaultPriority}
                          onChange={(e) => setDraft((d) => ({ ...d, defaultPriority: e.target.value }))}
                          className="w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
                          data-testid="ticket-category-edit-priority"
                        >
                          <option value="">None</option>
                          <option value="low">Low</option>
                          <option value="normal">Normal</option>
                          <option value="high">High</option>
                          <option value="urgent">Urgent</option>
                        </select>
                      </div>
                      <div>
                        <label className="text-xs font-medium">Response SLA (minutes)</label>
                        <input
                          type="number"
                          min={1}
                          value={draft.responseSlaMinutes}
                          onChange={(e) => setDraft((d) => ({ ...d, responseSlaMinutes: e.target.value }))}
                          className="w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
                          data-testid="ticket-category-edit-response-sla"
                        />
                      </div>
                      <div>
                        <label className="text-xs font-medium">Resolution SLA (minutes)</label>
                        <input
                          type="number"
                          min={1}
                          value={draft.resolutionSlaMinutes}
                          onChange={(e) => setDraft((d) => ({ ...d, resolutionSlaMinutes: e.target.value }))}
                          className="w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
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
                        <label htmlFor={`billable-${c.id}`} className="text-xs font-medium">Billable by default</label>
                      </div>
                      <div>
                        <label className="text-xs font-medium">Default hourly rate ($)</label>
                        <input
                          type="number"
                          min={0}
                          step={0.01}
                          value={draft.defaultHourlyRate}
                          onChange={(e) => setDraft((d) => ({ ...d, defaultHourlyRate: e.target.value }))}
                          className="w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
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
                        Save
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingId(null)}
                        className="rounded-md border px-3 py-1.5 text-sm font-medium"
                        data-testid={`ticket-category-cancel-${c.id}`}
                      >
                        Cancel
                      </button>
                    </div>
                  </td>
                </tr>
              )}
            </>
          ))}
        </tbody>
      </table>
    </div>
  );
}
