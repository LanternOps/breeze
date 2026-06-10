import { useCallback, useEffect, useState } from 'react';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, ActionError } from '../../lib/runAction';
import { navigateTo } from '@/lib/navigation';

interface Category {
  id: string; name: string; color: string; defaultPriority: string | null;
  responseSlaMinutes: number | null; resolutionSlaMinutes: number | null; isActive: boolean;
}

export default function TicketCategoriesPage() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [name, setName] = useState('');
  const [color, setColor] = useState('#1c8a9e');

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
    try {
      await runAction({
        request: () => fetchWithAuth('/ticket-categories', { method: 'POST', body: JSON.stringify({ name: name.trim(), color }) }),
        errorFallback: 'Category creation failed. Retry.',
        successMessage: `Category "${name.trim()}" created`,
        onUnauthorized: () => void navigateTo('/login', { replace: true })
      });
      setName('');
      void load();
    } catch (err) {
      if (!(err instanceof ActionError)) throw err;
    }
  }, [name, color, load]);

  const toggleActive = useCallback(async (cat: Category) => {
    try {
      await runAction({
        request: () => fetchWithAuth(`/ticket-categories/${cat.id}`, { method: 'PATCH', body: JSON.stringify({ isActive: !cat.isActive }) }),
        errorFallback: 'Update failed. Retry.',
        onUnauthorized: () => void navigateTo('/login', { replace: true })
      });
      void load();
    } catch (err) {
      if (!(err instanceof ActionError)) throw err;
    }
  }, [load]);

  return (
    <div className="max-w-3xl" data-testid="ticket-categories-page">
      <h1 className="text-xl font-semibold" data-testid="ticket-categories-heading">Ticketing</h1>
      <p className="mt-1 text-sm text-muted-foreground">Categories organize the queue and carry SLA and billing defaults (SLA enforcement arrives with the SLA engine).</p>

      <div className="mt-4 flex items-end gap-2">
        <div className="flex-1">
          <label className="text-sm font-medium" htmlFor="cat-name">New category</label>
          <input id="cat-name" value={name} onChange={(e) => setName(e.target.value)} className="w-full rounded-md border bg-background px-2.5 py-1.5 text-sm" data-testid="ticket-categories-name-input" />
        </div>
        <input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="h-9 w-12 rounded-md border" aria-label="Category color" data-testid="ticket-categories-color-input" />
        <button type="button" onClick={() => void create()} disabled={!name.trim()} className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50" data-testid="ticket-categories-create-button">Add</button>
      </div>

      <table className="mt-4 min-w-full divide-y" data-testid="ticket-categories-table">
        <thead className="bg-muted/40">
          <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <th className="px-4 py-2">Name</th><th className="px-4 py-2">Color</th><th className="px-4 py-2">Status</th><th className="px-4 py-2" />
          </tr>
        </thead>
        <tbody className="divide-y">
          {loading ? (
            <tr><td colSpan={4} className="px-4 py-6 text-center text-sm text-muted-foreground">Loading.</td></tr>
          ) : error ? (
            <tr><td colSpan={4} className="px-4 py-6 text-center text-sm text-muted-foreground" data-testid="ticket-categories-error">
              Categories failed to load.{' '}
              <button type="button" onClick={() => void load()} className="underline hover:text-foreground" data-testid="ticket-categories-retry">Retry</button>
            </td></tr>
          ) : categories.length === 0 ? (
            <tr><td colSpan={4} className="px-4 py-6 text-center text-sm text-muted-foreground" data-testid="ticket-categories-empty">No categories yet. Add the first one above.</td></tr>
          ) : categories.map((c) => (
            <tr key={c.id} data-testid={`ticket-category-row-${c.id}`}>
              <td className="px-4 py-2 text-sm">{c.name}</td>
              <td className="px-4 py-2"><span className="inline-block h-4 w-4 rounded" style={{ backgroundColor: c.color }} /></td>
              <td className="px-4 py-2 text-sm">{c.isActive ? 'Active' : 'Inactive'}</td>
              <td className="px-4 py-2 text-right">
                <button type="button" onClick={() => void toggleActive(c)} className="text-sm text-muted-foreground hover:text-foreground" data-testid={`ticket-category-toggle-${c.id}`}>
                  {c.isActive ? 'Deactivate' : 'Activate'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
