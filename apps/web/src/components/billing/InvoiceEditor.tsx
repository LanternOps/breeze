import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { runAction, handleActionError } from '../../lib/runAction';
import { usePermissions } from '../../lib/permissions';
import { showToast } from '../shared/Toast';
import {
  type InvoiceDetail,
  type InvoiceLine,
  formatMoney,
} from './invoiceTypes';
import CatalogItemPicker from '../catalog/CatalogItemPicker';
import { listCatalog, type CatalogItem } from '../../lib/api/catalog';

const UNAUTHORIZED = () => void navigateTo('/login', { replace: true });

interface Props {
  detail: InvoiceDetail;
  onChanged: () => void;
}

type AddMode = 'catalog' | 'manual';

export default function InvoiceEditor({ detail, onChanged }: Props) {
  const { can } = usePermissions();
  const canWrite = can('invoices', 'write');
  const { invoice, lines } = detail;
  const currency = invoice.currencyCode;

  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState(invoice.notes ?? '');
  const [notesDirty, setNotesDirty] = useState(false);

  // Add-line form
  const [addMode, setAddMode] = useState<AddMode>('catalog');
  const [manualDesc, setManualDesc] = useState('');
  const [manualQty, setManualQty] = useState('1');
  const [manualPrice, setManualPrice] = useState('0.00');
  const [manualTaxable, setManualTaxable] = useState(false);
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [picked, setPicked] = useState<CatalogItem | null>(null);
  const [pickQty, setPickQty] = useState('1');

  useEffect(() => { setNotes(invoice.notes ?? ''); setNotesDirty(false); }, [invoice.notes]);

  const loadCatalog = useCallback(async () => {
    const res = await listCatalog({ isActive: true, limit: 200 });
    if (res.status === 401) return UNAUTHORIZED();
    if (!res.ok) { handleActionError(new Error(res.statusText), 'Failed to load catalog.'); return; }
    const body = (await res.json()) as { data: CatalogItem[] };
    setCatalog(body.data ?? []);
  }, []);

  useEffect(() => { void loadCatalog(); }, [loadCatalog]);

  const unapprovedCount = useMemo(
    () => lines.filter((l) => l.isUnapprovedTime).length,
    [lines],
  );

  // Only top-level (non-child) lines render as editable rows; bundle children are
  // shown read-only nested under their parent.
  const parentLines = useMemo(() => lines.filter((l) => l.parentLineId === null), [lines]);
  const childrenOf = useCallback(
    (parentId: string) => lines.filter((l) => l.parentLineId === parentId),
    [lines],
  );

  const refresh = useCallback(() => onChanged(), [onChanged]);

  const addLine = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (addMode === 'manual') {
        if (!manualDesc.trim()) return;
        await runAction({
          request: () => fetchWithAuth(`/invoices/${invoice.id}/lines`, {
            method: 'POST',
            body: JSON.stringify({
              description: manualDesc.trim(),
              quantity: Number(manualQty),
              unitPrice: Number(manualPrice),
              taxable: manualTaxable,
            }),
          }),
          errorFallback: 'Could not add line.',
          successMessage: 'Line added',
          onUnauthorized: UNAUTHORIZED,
        });
        setManualDesc(''); setManualQty('1'); setManualPrice('0.00'); setManualTaxable(false);
      } else {
        if (!picked) return;
        const path = picked.isBundle
          ? `/invoices/${invoice.id}/lines/bundle`
          : `/invoices/${invoice.id}/lines/catalog`;
        const body = picked.isBundle
          ? { bundleId: picked.id, quantity: Number(pickQty) }
          : { catalogItemId: picked.id, quantity: Number(pickQty) };
        await runAction({
          request: () => fetchWithAuth(path, { method: 'POST', body: JSON.stringify(body) }),
          errorFallback: 'Could not add line.',
          successMessage: 'Line added',
          onUnauthorized: UNAUTHORIZED,
        });
        setPicked(null); setPickQty('1');
      }
      refresh();
    } catch (err) {
      handleActionError(err, 'Could not add line.');
    } finally {
      setBusy(false);
    }
  }, [busy, addMode, manualDesc, manualQty, manualPrice, manualTaxable, picked, pickQty, invoice.id, refresh]);

  const patchLine = useCallback(async (lineId: string, patch: Record<string, unknown>) => {
    if (busy) return;
    setBusy(true);
    try {
      await runAction({
        request: () => fetchWithAuth(`/invoices/${invoice.id}/lines/${lineId}`, {
          method: 'PATCH', body: JSON.stringify(patch),
        }),
        errorFallback: 'Could not update line.',
        onUnauthorized: UNAUTHORIZED,
      });
      refresh();
    } catch (err) {
      handleActionError(err, 'Could not update line.');
    } finally {
      setBusy(false);
    }
  }, [busy, invoice.id, refresh]);

  const removeLine = useCallback(async (lineId: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await runAction({
        request: () => fetchWithAuth(`/invoices/${invoice.id}/lines/${lineId}`, { method: 'DELETE' }),
        errorFallback: 'Could not remove line.',
        successMessage: 'Line removed',
        onUnauthorized: UNAUTHORIZED,
      });
      refresh();
    } catch (err) {
      handleActionError(err, 'Could not remove line.');
    } finally {
      setBusy(false);
    }
  }, [busy, invoice.id, refresh]);

  const saveNotes = useCallback(async () => {
    if (busy || !notesDirty) return;
    setBusy(true);
    try {
      await runAction({
        request: () => fetchWithAuth(`/invoices/${invoice.id}`, {
          method: 'PATCH', body: JSON.stringify({ notes }),
        }),
        errorFallback: 'Could not save notes.',
        successMessage: 'Notes saved',
        onUnauthorized: UNAUTHORIZED,
      });
      setNotesDirty(false);
      refresh();
    } catch (err) {
      handleActionError(err, 'Could not save notes.');
    } finally {
      setBusy(false);
    }
  }, [busy, notesDirty, notes, invoice.id, refresh]);

  const issue = useCallback(async (alsoSend: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      // Issue first; on success optionally send.
      await runAction({
        request: () => fetchWithAuth(`/invoices/${invoice.id}/issue`, { method: 'POST' }),
        errorFallback: 'Could not issue invoice.',
        successMessage: alsoSend ? undefined : 'Invoice issued',
        onUnauthorized: UNAUTHORIZED,
      });
      if (alsoSend) {
        // /send is honest about whether an email actually went out. The invoice
        // is issued either way; only claim "sent" when an email was dispatched,
        // otherwise warn so the operator knows nothing was emailed. We suppress
        // runAction's own success toast and post-process the result ourselves.
        const result = await runAction<{ data: { emailed: boolean } }>({
          request: () => fetchWithAuth(`/invoices/${invoice.id}/send`, { method: 'POST' }),
          errorFallback: 'Invoice issued, but sending failed.',
          onUnauthorized: UNAUTHORIZED,
        });
        if (result?.data?.emailed) {
          showToast({ type: 'success', message: 'Invoice issued and sent' });
        } else {
          showToast({ type: 'warning', message: 'Invoice issued — but no email was sent (no billing contact / email not configured)' });
        }
      }
    } catch (err) {
      handleActionError(err, 'Could not issue invoice.');
    } finally {
      // Always refresh: if issue succeeded but send threw, we still need to leave
      // the draft editor so a second click doesn't re-issue and hit 409 NOT_A_DRAFT.
      refresh();
      setBusy(false);
    }
  }, [busy, invoice.id, refresh]);

  const hasVisibleLines = lines.some((l) => l.customerVisible);

  return (
    <div className="space-y-6" data-testid="invoice-editor">
      {unapprovedCount > 0 && (
        <div
          className="rounded-md border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-400"
          data-testid="invoice-unapproved-warning"
        >
          {unapprovedCount} line{unapprovedCount === 1 ? '' : 's'} reference unapproved time. Review before issuing.
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_300px]">
        {/* Lines */}
        <div className="space-y-4">
          <div className="rounded-lg border bg-card shadow-sm">
            <table className="w-full text-sm" data-testid="invoice-editor-lines">
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-3 py-2 font-medium">Description</th>
                  <th className="px-3 py-2 text-right font-medium">Qty</th>
                  <th className="px-3 py-2 text-right font-medium">Price</th>
                  <th className="px-3 py-2 text-center font-medium">Tax</th>
                  <th className="px-3 py-2 text-center font-medium">Visible</th>
                  <th className="px-3 py-2 text-right font-medium">Total</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {parentLines.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-3 py-8 text-center text-sm text-muted-foreground">
                      No lines yet. Add catalog items, a bundle, or a manual line below.
                    </td>
                  </tr>
                ) : (
                  parentLines.map((l) => (
                    <LineRow
                      key={l.id}
                      line={l}
                      children={childrenOf(l.id)}
                      currency={currency}
                      disabled={busy}
                      onPatch={patchLine}
                      onRemove={removeLine}
                    />
                  ))
                )}
              </tbody>
            </table>
          </div>

          {/* Add line */}
          {canWrite && (
          <div className="rounded-lg border bg-card p-4 shadow-sm" data-testid="invoice-add-line">
            <div className="mb-3 flex gap-2">
              {(['catalog', 'manual'] as AddMode[]).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setAddMode(m)}
                  data-testid={`invoice-add-mode-${m}`}
                  className={`rounded-md border px-3 py-1.5 text-xs font-medium ${
                    addMode === m ? 'border-primary bg-primary/10 text-primary' : 'hover:bg-muted'
                  }`}
                >
                  {m === 'catalog' ? 'Catalog item' : 'Manual line'}
                </button>
              ))}
            </div>
            {addMode === 'manual' ? (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_80px_100px_auto_auto]">
                <input
                  type="text" placeholder="Description" value={manualDesc}
                  onChange={(e) => setManualDesc(e.target.value)}
                  data-testid="invoice-manual-desc"
                  className="h-9 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
                <input
                  type="number" min="0" step="0.01" placeholder="Qty" value={manualQty}
                  onChange={(e) => setManualQty(e.target.value)}
                  data-testid="invoice-manual-qty"
                  className="h-9 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
                <input
                  type="number" min="0" step="0.01" placeholder="Price" value={manualPrice}
                  onChange={(e) => setManualPrice(e.target.value)}
                  data-testid="invoice-manual-price"
                  className="h-9 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
                <label className="flex items-center gap-1 text-xs">
                  <input type="checkbox" checked={manualTaxable} onChange={(e) => setManualTaxable(e.target.checked)} data-testid="invoice-manual-taxable" />
                  Taxable
                </label>
                <button
                  type="button" onClick={() => void addLine()} disabled={busy || !manualDesc.trim()}
                  data-testid="invoice-add-line-submit"
                  className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
                >
                  Add
                </button>
              </div>
            ) : picked ? (
              <div className="flex flex-wrap items-center gap-2" data-testid="invoice-catalog-picked">
                <span className="inline-flex items-center gap-1.5 rounded-md border bg-muted/40 px-2.5 py-1.5 text-sm">
                  <span className="font-medium">{picked.name}</span>
                  {picked.isBundle && (
                    <span className="rounded border border-border bg-background px-1 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Bundle</span>
                  )}
                  <button type="button" onClick={() => setPicked(null)} aria-label="Clear selection" className="ml-1 text-muted-foreground hover:text-foreground">×</button>
                </span>
                <input
                  type="number" min="0" step="0.01" value={pickQty}
                  onChange={(e) => setPickQty(e.target.value)} aria-label="Quantity"
                  data-testid="invoice-pick-qty"
                  className="h-9 w-20 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
                <button
                  type="button" onClick={() => void addLine()} disabled={busy}
                  data-testid="invoice-catalog-add"
                  className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
                >
                  Add
                </button>
              </div>
            ) : catalog.length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="invoice-catalog-empty">
                No catalog items.{' '}
                <a href="/settings/catalog" className="underline hover:text-foreground">Add some in Product Catalog</a>.
              </p>
            ) : (
              <CatalogItemPicker
                items={catalog}
                onSelect={(it) => { setPicked(it); setPickQty('1'); }}
                testId="invoice-catalog-picker"
                placeholder="Search catalog by name or SKU"
              />
            )}
          </div>
          )}
        </div>

        {/* Summary + bill-to + notes + actions */}
        <div className="space-y-4">
          <div className="rounded-lg border bg-card p-4 shadow-sm" data-testid="invoice-summary">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Summary</h3>
            <dl className="space-y-1 text-sm">
              <div className="flex justify-between"><dt className="text-muted-foreground">Subtotal</dt><dd data-testid="invoice-subtotal">{formatMoney(invoice.subtotal, currency)}</dd></div>
              <div className="flex justify-between"><dt className="text-muted-foreground">Tax{invoice.taxRate ? ` (${(Number(invoice.taxRate) * 100).toFixed(2)}%)` : ''}</dt><dd data-testid="invoice-tax">{formatMoney(invoice.taxTotal, currency)}</dd></div>
              <div className="flex justify-between border-t pt-1 font-semibold"><dt>Total</dt><dd data-testid="invoice-total">{formatMoney(invoice.total, currency)}</dd></div>
            </dl>
          </div>

          <div className="rounded-lg border bg-card p-4 shadow-sm" data-testid="invoice-bill-to">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Bill to</h3>
            <p className="text-sm">{invoice.billToName ?? 'Set on the organization billing settings.'}</p>
          </div>

          <div className="rounded-lg border bg-card p-4 shadow-sm">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Notes</h3>
            <textarea
              value={notes}
              onChange={(e) => { setNotes(e.target.value); setNotesDirty(true); }}
              // Gate ENTRY, not save (disabled, like the qty/price inputs) — a
              // readOnly field is still focusable, so if canWrite flipped false
              // mid-edit the onBlur guard would silently drop the typed note.
              onBlur={() => { if (canWrite) void saveNotes(); }}
              disabled={!canWrite}
              data-testid="invoice-notes"
              rows={3}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60"
              placeholder="Internal or customer notes…"
            />
          </div>

          <div className="space-y-2">
            {can('invoices', 'send') && (
              <button
                type="button"
                onClick={() => void issue(false)}
                disabled={busy || !hasVisibleLines}
                data-testid="invoice-issue"
                className="inline-flex w-full items-center justify-center rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
              >
                Issue
              </button>
            )}
            {can('invoices', 'send') && (
              <button
                type="button"
                onClick={() => void issue(true)}
                disabled={busy || !hasVisibleLines}
                data-testid="invoice-issue-send"
                className="inline-flex w-full items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
              >
                Issue &amp; Send
              </button>
            )}
            {!hasVisibleLines && (
              <p className="text-center text-xs text-muted-foreground" data-testid="invoice-no-visible-hint">
                Add at least one customer-visible line to issue.
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function LineRow({
  line, children, currency, disabled, onPatch, onRemove,
}: {
  line: InvoiceLine;
  children: InvoiceLine[];
  currency: string;
  disabled: boolean;
  onPatch: (lineId: string, patch: Record<string, unknown>) => void;
  onRemove: (lineId: string) => void;
}) {
  const { can } = usePermissions();
  const canWrite = can('invoices', 'write');
  const editDisabled = disabled || !canWrite;
  const [qty, setQty] = useState(line.quantity);
  const [price, setPrice] = useState(line.unitPrice);
  useEffect(() => { setQty(line.quantity); setPrice(line.unitPrice); }, [line.quantity, line.unitPrice]);

  return (
    <>
      <tr className="border-t" data-testid={`invoice-line-${line.id}`}>
        <td className="px-3 py-2">{line.description}</td>
        <td className="px-3 py-2 text-right">
          <input
            type="number" min="0" step="0.01" value={qty} disabled={editDisabled}
            onChange={(e) => setQty(e.target.value)}
            onBlur={() => { if (canWrite && qty !== line.quantity) onPatch(line.id, { quantity: Number(qty) }); }}
            data-testid={`invoice-line-qty-${line.id}`}
            className="h-8 w-20 rounded-md border bg-background px-2 text-right text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </td>
        <td className="px-3 py-2 text-right">
          <input
            type="number" min="0" step="0.01" value={price} disabled={editDisabled}
            onChange={(e) => setPrice(e.target.value)}
            onBlur={() => { if (canWrite && price !== line.unitPrice) onPatch(line.id, { unitPrice: Number(price) }); }}
            data-testid={`invoice-line-price-${line.id}`}
            className="h-8 w-24 rounded-md border bg-background px-2 text-right text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </td>
        <td className="px-3 py-2 text-center">
          <input
            type="checkbox" checked={line.taxable} disabled={editDisabled}
            onChange={(e) => onPatch(line.id, { taxable: e.target.checked })}
            data-testid={`invoice-line-taxable-${line.id}`}
          />
        </td>
        <td className="px-3 py-2 text-center">
          <input
            type="checkbox" checked={line.customerVisible} disabled={editDisabled}
            onChange={(e) => onPatch(line.id, { customerVisible: e.target.checked })}
            data-testid={`invoice-line-visible-${line.id}`}
          />
        </td>
        <td className="px-3 py-2 text-right">{formatMoney(line.lineTotal, currency)}</td>
        <td className="px-3 py-2 text-right">
          {canWrite && (
            <button
              type="button" onClick={() => onRemove(line.id)} disabled={disabled}
              data-testid={`invoice-line-remove-${line.id}`}
              className="rounded-md border border-destructive/40 px-2 py-1 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
            >
              Remove
            </button>
          )}
        </td>
      </tr>
      {children.map((ch) => (
        <tr key={ch.id} className="border-t bg-muted/20 text-xs text-muted-foreground" data-testid={`invoice-line-child-${ch.id}`}>
          <td className="px-3 py-1.5 pl-8">↳ {ch.description}{!ch.customerVisible ? ' (hidden)' : ''}</td>
          <td className="px-3 py-1.5 text-right">{ch.quantity}</td>
          <td className="px-3 py-1.5 text-right">{formatMoney(ch.unitPrice, currency)}</td>
          <td colSpan={4} />
        </tr>
      ))}
    </>
  );
}
