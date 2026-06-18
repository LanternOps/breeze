import { useCallback, useEffect, useState } from 'react';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, handleActionError } from '../../lib/runAction';
import { formatMoney } from '../../lib/timeFormat';
import { broadcastBillingChanged } from '../../lib/timerActions';
import CatalogItemPicker from '../catalog/CatalogItemPicker';
import { listCatalog, type CatalogItem } from '../../lib/api/catalog';

interface PartRow {
  id: string;
  description: string;
  quantity: string;
  unitPrice: string;
  costBasis: string | null;
  isBillable: boolean;
  catalogItemId: string | null;
}

export default function TicketPartsCard({ ticketId }: { ticketId: string }) {
  const [parts, setParts] = useState<PartRow[]>([]);
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [description, setDescription] = useState('');
  const [quantity, setQuantity] = useState('');
  const [unitPrice, setUnitPrice] = useState('');
  const [costBasis, setCostBasis] = useState('');
  const [billable, setBillable] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  // Optional catalog link (#1368): pick an item to prefill description/price/cost
  // and record ticket_parts.catalog_item_id. Catalog + ticket parts share the
  // partner/system scope gate, so anyone who can edit parts can read the catalog.
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [catalogItemId, setCatalogItemId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const res = await fetchWithAuth(`/tickets/${ticketId}/parts`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    if (res?.data) setParts(res.data as PartRow[]);
  }, [ticketId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Load active catalog items for the picker once. A failure (e.g. nothing in
  // the catalog) just leaves the picker empty — parts stay free-text.
  useEffect(() => {
    void listCatalog({ isActive: true, limit: 200 })
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => { if (body?.data) setCatalog(body.data as CatalogItem[]); })
      .catch(() => { /* picker simply has no options */ });
  }, []);

  const linkedItem = catalogItemId ? catalog.find((c) => c.id === catalogItemId) ?? null : null;

  const pickCatalogItem = (it: CatalogItem) => {
    setCatalogItemId(it.id);
    setDescription(it.name);
    setUnitPrice(String(Number(it.unitPrice)));
    setCostBasis(it.costBasis != null ? String(Number(it.costBasis)) : '');
  };

  // Reset form and list state when ticketId changes (mirror TicketTimeBilling)
  useEffect(() => {
    setFormOpen(false);
    setEditingId(null);
    setDescription('');
    setQuantity('');
    setUnitPrice('');
    setCostBasis('');
    setBillable(true);
    setConfirmingDeleteId(null);
    setCatalogItemId(null);
  }, [ticketId]);

  const resetForm = () => {
    setFormOpen(false);
    setEditingId(null);
    setDescription('');
    setQuantity('');
    setUnitPrice('');
    setCostBasis('');
    setBillable(true);
    setCatalogItemId(null);
  };

  const openAdd = () => { resetForm(); setFormOpen(true); };

  const openEdit = (part: PartRow) => {
    setEditingId(part.id);
    setDescription(part.description);
    setQuantity(String(Number(part.quantity)));
    setUnitPrice(String(Number(part.unitPrice)));
    setCostBasis(part.costBasis != null ? String(Number(part.costBasis)) : '');
    setBillable(part.isBillable);
    setCatalogItemId(part.catalogItemId ?? null);
    setFormOpen(true);
  };

  const submitForm = async () => {
    if (!description.trim()) return;
    const qty = Number(quantity);
    const price = Number(unitPrice);
    if (!Number.isFinite(qty) || qty <= 0) return;
    if (!Number.isFinite(price) || price < 0) return;

    const body: Record<string, unknown> = {
      description: description.trim(),
      quantity: qty,
      unitPrice: price,
      isBillable: billable,
      catalogItemId,
    };
    const cb = costBasis.trim();
    if (cb !== '') {
      body.costBasis = Number(cb);
    } else {
      body.costBasis = null;
    }

    setBusy(true);
    try {
      if (editingId) {
        await runAction({
          request: () =>
            fetchWithAuth(`/tickets/parts/${editingId}`, {
              method: 'PATCH',
              body: JSON.stringify(body),
            }),
          errorFallback: 'Failed to update part',
          successMessage: 'Part updated',
        });
      } else {
        await runAction({
          request: () =>
            fetchWithAuth(`/tickets/${ticketId}/parts`, {
              method: 'POST',
              body: JSON.stringify(body),
            }),
          errorFallback: 'Failed to add part',
          successMessage: 'Part added',
        });
      }
      resetForm();
      await refresh();
      broadcastBillingChanged();
    } catch (err) {
      handleActionError(err, editingId ? 'Failed to update part.' : 'Failed to add part.');
    } finally {
      setBusy(false);
    }
  };

  const deletePart = async (id: string) => {
    try {
      await runAction({
        request: () =>
          fetchWithAuth(`/tickets/parts/${id}`, { method: 'DELETE' }),
        errorFallback: 'Failed to delete part',
        successMessage: 'Part deleted',
      });
      setConfirmingDeleteId(null);
      await refresh();
      broadcastBillingChanged();
    } catch (err) {
      handleActionError(err, 'Failed to delete part.');
    }
  };

  return (
    <div className="mt-3 border-t pt-3" data-testid="ticket-parts-card">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Parts</p>

      {parts.length === 0 && !formOpen && (
        <p className="mt-1 text-xs text-muted-foreground" data-testid="ticket-parts-empty">No parts.</p>
      )}

      {parts.length > 0 && (
        <ul className="mt-2 space-y-1" data-testid="ticket-parts-list">
          {parts.map((part) => {
            const qty = Number(part.quantity);
            const price = Number(part.unitPrice);
            const lineTotal = qty * price;
            const margin =
              part.costBasis != null
                ? lineTotal - qty * Number(part.costBasis)
                : null;
            return (
              <li
                key={part.id}
                className="text-xs"
                data-testid={`ticket-part-${part.id}`}
              >
                <div className="flex items-start justify-between gap-1">
                  <span className="min-w-0 flex-1 truncate font-medium">
                    {part.description}
                  </span>
                  <span className="shrink-0 font-medium">{formatMoney(lineTotal)}</span>
                </div>
                <div className="flex items-center justify-between gap-1 text-muted-foreground">
                  <span>
                    {qty} × {formatMoney(price)}
                    {!part.isBillable && ' · non-billable'}
                  </span>
                  {margin != null && (
                    <span
                      className="shrink-0"
                      title="Margin"
                    >
                      {formatMoney(margin)}
                    </span>
                  )}
                </div>
                {confirmingDeleteId === part.id ? (
                  <div
                    className="mt-0.5 flex items-center gap-1"
                    data-testid={`ticket-part-delete-confirm-${part.id}`}
                  >
                    <span className="text-destructive">Delete?</span>
                    <span className="text-muted-foreground">·</span>
                    <button
                      type="button"
                      onClick={() => void deletePart(part.id)}
                      className="rounded px-1 py-0.5 text-xs font-medium text-destructive hover:bg-muted"
                      data-testid={`ticket-part-delete-confirm-yes-${part.id}`}
                    >
                      Confirm
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmingDeleteId(null)}
                      className="rounded px-1 py-0.5 text-xs hover:bg-muted"
                      data-testid={`ticket-part-delete-confirm-cancel-${part.id}`}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <div className="mt-0.5 flex gap-1">
                    <button
                      type="button"
                      onClick={() => openEdit(part)}
                      className="rounded px-1 py-0.5 text-xs hover:bg-muted"
                      data-testid={`ticket-part-edit-${part.id}`}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmingDeleteId(part.id)}
                      className="rounded px-1 py-0.5 text-xs text-destructive hover:bg-muted"
                      data-testid={`ticket-part-delete-${part.id}`}
                    >
                      Delete
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div className="mt-2">
        <button
          type="button"
          onClick={openAdd}
          className="rounded-md border px-2 py-1 text-xs hover:bg-muted"
          data-testid="ticket-parts-add-toggle"
        >
          Add part
        </button>
      </div>

      {formOpen && (
        <div className="mt-2 space-y-1.5 rounded-md border bg-muted/30 p-2" data-testid="ticket-parts-form">
          {/* Optional: pull a part from the catalog to prefill + link it (#1368). */}
          {catalog.length > 0 && (
            linkedItem ? (
              <div className="flex items-center justify-between gap-2 rounded-md border bg-background px-2 py-1 text-xs" data-testid="ticket-parts-form-linked">
                <span className="min-w-0 truncate">
                  <span className="text-muted-foreground">From catalog: </span>
                  <span className="font-medium">{linkedItem.name}</span>
                </span>
                <button
                  type="button"
                  onClick={() => setCatalogItemId(null)}
                  className="shrink-0 rounded px-1 py-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                  data-testid="ticket-parts-form-unlink"
                >
                  Unlink
                </button>
              </div>
            ) : (
              <CatalogItemPicker
                items={catalog}
                onSelect={pickCatalogItem}
                includeBundles={false}
                placeholder="Add from catalog (optional)"
                testId="ticket-parts-catalog-picker"
              />
            )
          )}
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Description"
            aria-label="Description"
            className="w-full rounded-md border bg-background px-2 py-1 text-xs"
            data-testid="ticket-parts-form-description"
          />
          <input
            type="number"
            min={0.01}
            step={0.01}
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            placeholder="Quantity"
            aria-label="Quantity"
            className="w-full rounded-md border bg-background px-2 py-1 text-xs"
            data-testid="ticket-parts-form-quantity"
          />
          <input
            type="number"
            min={0}
            step={0.01}
            value={unitPrice}
            onChange={(e) => setUnitPrice(e.target.value)}
            placeholder="Unit price"
            aria-label="Unit price"
            className="w-full rounded-md border bg-background px-2 py-1 text-xs"
            data-testid="ticket-parts-form-unit-price"
          />
          <input
            type="number"
            min={0}
            step={0.01}
            value={costBasis}
            onChange={(e) => setCostBasis(e.target.value)}
            placeholder="Cost (optional)"
            aria-label="Cost"
            className="w-full rounded-md border bg-background px-2 py-1 text-xs"
            data-testid="ticket-parts-form-cost-basis"
          />
          <label className="flex items-center gap-1.5 text-xs">
            <input
              type="checkbox"
              checked={billable}
              onChange={(e) => setBillable(e.target.checked)}
              data-testid="ticket-parts-form-billable"
            />
            Billable
          </label>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void submitForm()}
              disabled={busy}
              className="flex-1 rounded-md bg-primary px-2 py-1 text-xs font-medium text-white disabled:opacity-50"
              data-testid="ticket-parts-form-submit"
            >
              {busy ? 'Saving…' : editingId ? 'Update' : 'Add part'}
            </button>
            <button
              type="button"
              onClick={resetForm}
              className="rounded-md border px-2 py-1 text-xs hover:bg-muted"
              data-testid="ticket-parts-form-cancel"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
