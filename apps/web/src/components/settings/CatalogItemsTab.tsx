import { useCallback, useEffect, useState } from 'react';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, handleActionError } from '../../lib/runAction';
import { showToast } from '../shared/Toast';
import { navigateTo } from '@/lib/navigation';
import { getJwtClaims, loginPathWithNext } from '../../lib/authScope';

// Catalog items are partner-scoped. numeric(12,2) columns (unitPrice, costBasis)
// serialize to JSON as strings, so the price fields are typed as string here.
interface CatalogItem {
  id: string;
  itemType: 'hardware' | 'software' | 'service';
  name: string;
  sku: string | null;
  unitPrice: string;
  costBasis: string | null;
  isBundle: boolean;
  isActive: boolean;
}

interface EditForm {
  itemType: 'hardware' | 'software' | 'service';
  name: string;
  sku: string;
  unitPrice: string;
  costBasis: string;
  isBundle: boolean;
}

const EMPTY_FORM: EditForm = {
  itemType: 'service',
  name: '',
  sku: '',
  unitPrice: '',
  costBasis: '',
  isBundle: false
};

const UNAUTHORIZED = () => void navigateTo(loginPathWithNext(), { replace: true });

export default function CatalogItemsTab() {
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState<EditForm>(EMPTY_FORM);
  // In-flight guards prevent double-submit duplicate POSTs.
  const [saving, setSaving] = useState(false);
  const [archivingId, setArchivingId] = useState<string | null>(null);

  // Catalog routes enforce requireScope('partner','system') server-side. Mirror
  // that client-side so org-scope users see a clear message instead of a
  // misleading "failed to load" 403. getJwtClaims returns null scope on a
  // missing/undecodable token; treat only confirmed 'organization' scope as
  // denied so we never hard-block on a decode failure (server still re-checks).
  const isOrgScoped = getJwtClaims().scope === 'organization';

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const res = await fetchWithAuth('/catalog?isActive=true');
      if (res.ok) {
        const body = (await res.json()) as { data: CatalogItem[] };
        setItems(body.data ?? []);
      } else {
        setError(true);
      }
    } catch {
      setError(true);
    }
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const openCreate = () => {
    setEditId(null);
    setForm(EMPTY_FORM);
    setEditorOpen(true);
  };

  const openEdit = (it: CatalogItem) => {
    setEditId(it.id);
    setForm({
      itemType: it.itemType,
      name: it.name,
      sku: it.sku ?? '',
      unitPrice: it.unitPrice,
      costBasis: it.costBasis ?? '',
      isBundle: it.isBundle
    });
    setEditorOpen(true);
  };

  const save = useCallback(async () => {
    if (saving) return; // guard re-entry while a save is in flight
    if (!form.name.trim()) return;
    const unitPrice = Number(form.unitPrice);
    // Blank or non-finite unit price: surface feedback instead of a silent
    // no-op. (Save is also disabled in this state — this is the belt-and-braces
    // path for keyboard/Enter submits.)
    if (!form.unitPrice.trim() || !Number.isFinite(unitPrice)) {
      showToast({ message: 'Enter a valid unit price.', type: 'error' });
      return;
    }
    const body: Record<string, unknown> = {
      itemType: form.itemType,
      name: form.name.trim(),
      sku: form.sku.trim() || null,
      unitPrice,
      costBasis: form.costBasis.trim() ? Number(form.costBasis) : null,
      isBundle: form.isBundle
    };
    setSaving(true);
    try {
      await runAction({
        request: () =>
          editId
            ? fetchWithAuth(`/catalog/${editId}`, { method: 'PATCH', body: JSON.stringify(body) })
            : fetchWithAuth('/catalog', { method: 'POST', body: JSON.stringify(body) }),
        errorFallback: editId ? 'Update failed. Retry.' : 'Item creation failed. Retry.',
        successMessage: editId ? 'Item updated' : `Item "${form.name.trim()}" created`,
        onUnauthorized: UNAUTHORIZED
      });
      setEditorOpen(false);
      void load();
    } catch (err) {
      handleActionError(err, editId ? 'Update failed. Retry.' : 'Item creation failed. Retry.');
    } finally {
      setSaving(false);
    }
  }, [form, editId, load, saving]);

  const archive = useCallback(async (id: string) => {
    if (archivingId) return; // guard re-entry while an archive is in flight
    setArchivingId(id);
    try {
      await runAction({
        request: () => fetchWithAuth(`/catalog/${id}/archive`, { method: 'POST' }),
        errorFallback: 'Archive failed. Retry.',
        successMessage: 'Item archived',
        onUnauthorized: UNAUTHORIZED
      });
      void load();
    } catch (err) {
      handleActionError(err, 'Archive failed. Retry.');
    } finally {
      setArchivingId(null);
    }
  }, [load, archivingId]);

  if (isOrgScoped) {
    return (
      <p className="text-center text-sm text-muted-foreground" data-testid="catalog-items-org-scope">
        The product catalog is available to partner accounts only.
      </p>
    );
  }

  if (loading) {
    return (
      <p className="text-center text-sm text-muted-foreground" data-testid="catalog-items-loading">
        Loading.
      </p>
    );
  }

  if (error) {
    return (
      <p className="text-center text-sm text-muted-foreground" data-testid="catalog-items-error">
        Catalog failed to load.{' '}
        <button
          type="button"
          onClick={() => void load()}
          className="underline hover:text-foreground"
          data-testid="catalog-items-retry"
        >
          Retry
        </button>
      </p>
    );
  }

  return (
    <div className="space-y-4" data-testid="catalog-items-tab">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Items</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Hardware, software, and service items available for quotes, contracts, and invoices.
          </p>
        </div>
        <button
          type="button"
          onClick={openCreate}
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-white"
          data-testid="catalog-add-item"
        >
          Add item
        </button>
      </div>

      {items.length === 0 ? (
        <p className="text-center text-sm text-muted-foreground" data-testid="catalog-items-empty">
          No catalog items yet.
        </p>
      ) : (
        <table className="min-w-full divide-y text-sm" data-testid="catalog-items-table">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="px-4 py-2 font-medium">Name</th>
              <th className="px-4 py-2 font-medium">Type</th>
              <th className="px-4 py-2 font-medium">SKU</th>
              <th className="px-4 py-2 font-medium">Price</th>
              <th className="px-4 py-2 font-medium">Bundle</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y">
            {items.map((it) => (
              <tr key={it.id} data-testid={`catalog-item-row-${it.id}`}>
                <td className="px-4 py-2">{it.name}</td>
                <td className="px-4 py-2">{it.itemType}</td>
                <td className="px-4 py-2">{it.sku ?? '—'}</td>
                <td className="px-4 py-2">{it.unitPrice}</td>
                <td className="px-4 py-2">{it.isBundle ? 'Yes' : '—'}</td>
                <td className="px-4 py-2 text-right space-x-2">
                  <button
                    type="button"
                    onClick={() => openEdit(it)}
                    className="text-sm text-muted-foreground hover:text-foreground"
                    data-testid={`catalog-edit-${it.id}`}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => void archive(it.id)}
                    disabled={archivingId !== null}
                    className="text-sm text-destructive hover:underline disabled:opacity-50"
                    data-testid={`catalog-archive-${it.id}`}
                  >
                    {archivingId === it.id ? 'Archiving…' : 'Archive'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {editorOpen && (
        <div className="rounded-md border bg-muted/30 p-4" data-testid="catalog-item-editor">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium" htmlFor="catalog-form-type-select">Type</label>
              <select
                id="catalog-form-type-select"
                value={form.itemType}
                onChange={(e) =>
                  setForm((f) => ({ ...f, itemType: e.target.value as EditForm['itemType'] }))
                }
                className="w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
                data-testid="catalog-form-type"
              >
                <option value="hardware">Hardware</option>
                <option value="software">Software</option>
                <option value="service">Service</option>
              </select>
            </div>
            <div>
              <label className="text-xs font-medium" htmlFor="catalog-form-name-input">Name</label>
              <input
                id="catalog-form-name-input"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                className="w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
                placeholder="Item name"
                data-testid="catalog-form-name"
              />
            </div>
            <div>
              <label className="text-xs font-medium" htmlFor="catalog-form-sku-input">SKU</label>
              <input
                id="catalog-form-sku-input"
                value={form.sku}
                onChange={(e) => setForm((f) => ({ ...f, sku: e.target.value }))}
                className="w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
                placeholder="SKU (optional)"
                data-testid="catalog-form-sku"
              />
            </div>
            <div>
              <label className="text-xs font-medium" htmlFor="catalog-form-price-input">Unit price</label>
              <input
                id="catalog-form-price-input"
                value={form.unitPrice}
                onChange={(e) => setForm((f) => ({ ...f, unitPrice: e.target.value }))}
                inputMode="decimal"
                className="w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
                placeholder="0.00"
                data-testid="catalog-form-price"
              />
            </div>
            <div>
              <label className="text-xs font-medium" htmlFor="catalog-form-cost-input">Cost basis</label>
              <input
                id="catalog-form-cost-input"
                value={form.costBasis}
                onChange={(e) => setForm((f) => ({ ...f, costBasis: e.target.value }))}
                inputMode="decimal"
                className="w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
                placeholder="Cost basis (optional)"
                data-testid="catalog-form-cost"
              />
            </div>
            <div className="flex items-end">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.isBundle}
                  onChange={(e) => setForm((f) => ({ ...f, isBundle: e.target.checked }))}
                  data-testid="catalog-form-bundle"
                />
                This item is a bundle
              </label>
            </div>
          </div>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => void save()}
              disabled={
                saving ||
                !form.name.trim() ||
                !form.unitPrice.trim() ||
                !Number.isFinite(Number(form.unitPrice))
              }
              className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
              data-testid="catalog-form-save"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              onClick={() => setEditorOpen(false)}
              className="rounded-md border px-3 py-1.5 text-sm font-medium"
              data-testid="catalog-form-cancel"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
