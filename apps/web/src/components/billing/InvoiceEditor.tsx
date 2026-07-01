import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { runAction, handleActionError } from '../../lib/runAction';
import { usePermissions } from '../../lib/permissions';
import { UnsavedBadge, MarginPanel } from './billingUi';
import {
  type InvoiceDetail,
  type InvoiceLine,
  formatMoney,
  lineTitle,
  computeInvoiceProfit,
} from './invoiceTypes';
import CatalogItemPicker from '../catalog/CatalogItemPicker';
import PolishButton from '../catalog/PolishButton';
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
  // Cost/margin is a read affordance (mirrors InvoiceDetail + the quote rails'
  // `quotes:read` gate) — anyone who can read the invoice sees it.
  const canSeeMargin = can('invoices', 'read');
  const { invoice, lines } = detail;
  const currency = invoice.currencyCode;
  const profit = useMemo(() => computeInvoiceProfit(lines), [lines]);

  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState(invoice.notes ?? '');
  const [notesDirty, setNotesDirty] = useState(false);
  const [terms, setTerms] = useState(invoice.termsAndConditions ?? '');
  const [termsDirty, setTermsDirty] = useState(false);

  // Add-line form
  const [addMode, setAddMode] = useState<AddMode>('catalog');
  const [manualName, setManualName] = useState('');
  const [manualDesc, setManualDesc] = useState('');
  const [manualQty, setManualQty] = useState('1');
  const [manualPrice, setManualPrice] = useState('0.00');
  const [manualTaxable, setManualTaxable] = useState(false);
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [picked, setPicked] = useState<CatalogItem | null>(null);
  const [pickQty, setPickQty] = useState('1');

  useEffect(() => { setNotes(invoice.notes ?? ''); setNotesDirty(false); }, [invoice.notes]);
  useEffect(() => { setTerms(invoice.termsAndConditions ?? ''); setTermsDirty(false); }, [invoice.termsAndConditions]);

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
        // A line needs at least a title (name) or a description (mirrors the API refine).
        if (!manualName.trim() && !manualDesc.trim()) return;
        await runAction({
          request: () => fetchWithAuth(`/invoices/${invoice.id}/lines`, {
            method: 'POST',
            body: JSON.stringify({
              name: manualName.trim() || null,
              description: manualDesc.trim() || null,
              quantity: Number(manualQty),
              unitPrice: Number(manualPrice),
              taxable: manualTaxable,
            }),
          }),
          errorFallback: 'Could not add line.',
          successMessage: 'Line added',
          onUnauthorized: UNAUTHORIZED,
        });
        setManualName(''); setManualDesc(''); setManualQty('1'); setManualPrice('0.00'); setManualTaxable(false);
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
  }, [busy, addMode, manualName, manualDesc, manualQty, manualPrice, manualTaxable, picked, pickQty, invoice.id, refresh]);

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

  const saveTerms = useCallback(async () => {
    if (busy || !termsDirty) return;
    setBusy(true);
    try {
      await runAction({
        request: () => fetchWithAuth(`/invoices/${invoice.id}`, {
          method: 'PATCH', body: JSON.stringify({ termsAndConditions: terms }),
        }),
        errorFallback: 'Could not save terms.',
        successMessage: 'Terms saved',
        onUnauthorized: UNAUTHORIZED,
      });
      setTermsDirty(false);
      refresh();
    } catch (err) {
      handleActionError(err, 'Could not save terms.');
    } finally {
      setBusy(false);
    }
  }, [busy, termsDirty, terms, invoice.id, refresh]);

  // Tax rate is inherited from partner Billing settings, not set per invoice. When
  // a line is marked taxable but no rate is configured, the Tax row reads $0.00
  // with no obvious cause — point the operator at where the rate actually lives.
  const hasTaxableLine = lines.some((l) => l.taxable);
  const noTaxRate = !invoice.taxRate || Number(invoice.taxRate) <= 0;

  return (
    <div className="space-y-6" data-testid="invoice-editor">
      {unapprovedCount > 0 && (
        <div
          className="rounded-md border border-warning/40 bg-warning/15 px-4 py-3 text-sm text-[hsl(36_92%_28%)] dark:text-warning"
          data-testid="invoice-unapproved-warning"
        >
          {unapprovedCount} line{unapprovedCount === 1 ? '' : 's'} reference unapproved time. Review before issuing.
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_300px]">
        {/* Lines */}
        <div className="space-y-4">
          <div className="rounded-lg border bg-card shadow-xs">
            <table className="w-full text-sm" data-testid="invoice-editor-lines">
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-3 py-2 font-medium">Description</th>
                  <th className="px-3 py-2 text-right font-medium">Qty</th>
                  <th className="px-3 py-2 text-right font-medium">Price</th>
                  <th className="px-3 py-2 text-center font-medium">Tax</th>
                  <th className="px-3 py-2 text-center font-medium" title="Whether this line appears on the customer's invoice">Customer-visible</th>
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
          <div className="rounded-lg border bg-card p-4 shadow-xs" data-testid="invoice-add-line">
            {/* Segmented control — same vocabulary as the New-invoice source toggle
                so "pick one mode" looks identical everywhere in the invoice flow. */}
            <div className="mb-3 inline-flex gap-1 rounded-md border bg-muted/40 p-1" role="group" aria-label="Add line source">
              {(['catalog', 'manual'] as AddMode[]).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setAddMode(m)}
                  aria-pressed={addMode === m}
                  data-testid={`invoice-add-mode-${m}`}
                  className={`rounded px-3 py-1.5 text-xs font-medium transition ${
                    addMode === m ? 'bg-card text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {m === 'catalog' ? 'Catalog item' : 'Manual line'}
                </button>
              ))}
            </div>
            {addMode === 'manual' ? (
              <div className="space-y-2">
              {(manualName.trim() || manualDesc.trim()) && (
                <PolishButton
                  idSuffix="invoice-manual"
                  getText={() => ({ name: manualName, description: manualDesc })}
                  onApply={(r) => {
                    if (r.name !== null) setManualName(r.name);
                    if (r.description !== null) setManualDesc(r.description);
                  }}
                />
              )}
              <input
                type="text" placeholder="Name" aria-label="Line name" value={manualName}
                onChange={(e) => setManualName(e.target.value)}
                data-testid="invoice-manual-name"
                className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              />
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_80px_100px_auto_auto]">
                <input
                  type="text" placeholder="Description (optional)" aria-label="Line description" value={manualDesc}
                  onChange={(e) => setManualDesc(e.target.value)}
                  data-testid="invoice-manual-desc"
                  className="h-9 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                />
                <input
                  type="number" min="0" step="0.01" placeholder="Qty" aria-label="Quantity" value={manualQty}
                  onChange={(e) => setManualQty(e.target.value)}
                  data-testid="invoice-manual-qty"
                  className="h-9 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                />
                <input
                  type="number" min="0" step="0.01" placeholder="Price" aria-label="Unit price" value={manualPrice}
                  onChange={(e) => setManualPrice(e.target.value)}
                  data-testid="invoice-manual-price"
                  className="h-9 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                />
                <label className="flex items-center gap-1 text-xs">
                  <input type="checkbox" checked={manualTaxable} onChange={(e) => setManualTaxable(e.target.checked)} data-testid="invoice-manual-taxable" />
                  Taxable
                </label>
                <button
                  type="button" onClick={() => void addLine()} disabled={busy || (!manualName.trim() && !manualDesc.trim())}
                  data-testid="invoice-add-line-submit"
                  className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
                >
                  Add
                </button>
              </div>
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
                  className="h-9 w-20 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
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
          <div className="rounded-lg border bg-card p-4 shadow-xs" data-testid="invoice-summary">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Summary</h3>
            <dl className="space-y-1 text-sm">
              <div className="flex justify-between"><dt className="text-muted-foreground">Subtotal</dt><dd data-testid="invoice-subtotal">{formatMoney(invoice.subtotal, currency)}</dd></div>
              <div className="flex justify-between"><dt className="text-muted-foreground">Tax{!noTaxRate ? ` (${(Number(invoice.taxRate) * 100).toFixed(2)}%)` : ''}</dt><dd data-testid="invoice-tax">{formatMoney(invoice.taxTotal, currency)}</dd></div>
              <div className="flex justify-between border-t pt-1 font-semibold"><dt>Total</dt><dd data-testid="invoice-total">{formatMoney(invoice.total, currency)}</dd></div>
            </dl>
            {hasTaxableLine && noTaxRate && (
              <p className="mt-3 text-xs text-muted-foreground" data-testid="invoice-tax-rate-hint">
                Lines are marked taxable, but no tax rate is set.{' '}
                <a href="/settings/billing" className="underline hover:text-foreground">Set one in Billing settings</a>.
              </p>
            )}
            {/* Internal margin summary — at-a-glance profitability while building the
                invoice (the per-line cost/margin breakdown lives in InvoiceDetail's
                Accounting view). Reuses the shared quote math; never customer-facing. */}
            {canSeeMargin && <MarginPanel profit={profit} currency={currency} idPrefix="invoice" />}
          </div>

          <div className="rounded-lg border bg-card p-4 shadow-xs" data-testid="invoice-bill-to">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Bill to</h3>
            {invoice.billToName ? (
              <p className="text-sm">{invoice.billToName}</p>
            ) : (
              <p className="text-sm text-muted-foreground">
                No billing contact set.{' '}
                <a href="/settings/organizations" className="underline hover:text-foreground">Add one in Organization settings</a>.
              </p>
            )}
          </div>

          <div className="rounded-lg border bg-card p-4 shadow-xs">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Notes</h3>
              <UnsavedBadge show={notesDirty} />
            </div>
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
              className={`w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-60 ${notesDirty ? 'ring-1 ring-warning' : ''}`}
              placeholder="Internal or customer notes…"
            />
          </div>

          <div className="rounded-lg border bg-card p-4 shadow-xs">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Terms & Conditions</h3>
              <UnsavedBadge show={termsDirty} />
            </div>
            <textarea
              value={terms}
              onChange={(e) => { setTerms(e.target.value); setTermsDirty(true); }}
              onBlur={() => { if (canWrite) void saveTerms(); }}
              disabled={!canWrite}
              data-testid="invoice-terms"
              rows={3}
              className={`w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-60 ${termsDirty ? 'ring-1 ring-warning' : ''}`}
              placeholder="Payment terms, warranty clauses, etc."
            />
          </div>

          {/* Issue / Issue & Send / Download PDF / Delete draft live in the
              workspace header (InvoiceActions) so they're reachable from any tab
              — mirrors the quote editor, which carries no Send button of its own. */}
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
  const [name, setName] = useState(line.name ?? '');
  const [desc, setDesc] = useState(line.description ?? '');
  const [qty, setQty] = useState(line.quantity);
  const [price, setPrice] = useState(line.unitPrice);
  // Guard an in-progress name/description edit from being clobbered by a server
  // resync mid-type (mirrors the quote editor's EditableLineRow pattern).
  const nameEdited = useRef(false);
  const descEdited = useRef(false);
  // Auto-grow the (full-width) description textarea to fit its content, while
  // still letting the user drag the resize handle for a bigger/smaller box.
  const descRef = useRef<HTMLTextAreaElement>(null);
  const autoGrowDesc = () => {
    const el = descRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  };
  useEffect(() => { if (!nameEdited.current) setName(line.name ?? ''); }, [line.name]);
  useEffect(() => { if (!descEdited.current) setDesc(line.description ?? ''); }, [line.description]);
  useEffect(() => { autoGrowDesc(); }, [desc]);
  useEffect(() => { setQty(line.quantity); setPrice(line.unitPrice); }, [line.quantity, line.unitPrice]);

  const commitName = () => {
    if (!canWrite) return;
    const next = name.trim();
    nameEdited.current = false; // committing — let the server value re-adopt next
    if (next === (line.name ?? '')) { setName(line.name ?? ''); return; }
    // A line can't have both name and description blank (mirrors the manual-add rule).
    if (!next && !(line.description ?? '').trim()) {
      handleActionError(new Error('empty line'), 'A line needs a name or a description.');
      setName(line.name ?? '');
      return;
    }
    onPatch(line.id, { name: next || null });
  };
  const commitDesc = () => {
    if (!canWrite) return;
    const next = desc.trim();
    descEdited.current = false;
    if (next === (line.description ?? '')) { setDesc(line.description ?? ''); return; }
    if (!next && !(line.name ?? '').trim()) {
      handleActionError(new Error('empty line'), 'A line needs a name or a description.');
      setDesc(line.description ?? '');
      return;
    }
    onPatch(line.id, { description: next || null });
  };

  return (
    <>
      <tr className="border-t" data-testid={`invoice-line-${line.id}`}>
        <td className="px-3 py-2">
          <input
            type="text" value={name} disabled={editDisabled}
            aria-label="Line name" placeholder="Name"
            onChange={(e) => { setName(e.target.value); nameEdited.current = true; }}
            onBlur={commitName}
            data-testid={`invoice-line-name-${line.id}`}
            className="h-8 w-full rounded-md border bg-background px-2 text-sm font-medium focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-60"
          />
        </td>
        <td className="px-3 py-2 text-right">
          <input
            type="number" min="0" step="0.01" value={qty} disabled={editDisabled}
            onChange={(e) => setQty(e.target.value)}
            onBlur={() => { if (canWrite && qty !== line.quantity) onPatch(line.id, { quantity: Number(qty) }); }}
            data-testid={`invoice-line-qty-${line.id}`}
            className="h-8 w-20 rounded-md border bg-background px-2 text-right text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
          />
        </td>
        <td className="px-3 py-2 text-right">
          <input
            type="number" min="0" step="0.01" value={price} disabled={editDisabled}
            onChange={(e) => setPrice(e.target.value)}
            onBlur={() => { if (canWrite && price !== line.unitPrice) onPatch(line.id, { unitPrice: Number(price) }); }}
            data-testid={`invoice-line-price-${line.id}`}
            className="h-8 w-24 rounded-md border bg-background px-2 text-right text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
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
      {/* Full-width description row, so writers get a roomy, expandable box
          instead of a cramped cell — matches the quote editor. */}
      <tr className="border-0" data-testid={`invoice-line-desc-row-${line.id}`}>
        <td colSpan={7} className="px-3 pb-2 pt-0">
          <textarea
            ref={descRef}
            value={desc}
            disabled={editDisabled}
            aria-label="Line description"
            placeholder="Description (optional)"
            onChange={(e) => { setDesc(e.target.value); descEdited.current = true; autoGrowDesc(); }}
            onBlur={commitDesc}
            rows={2}
            data-testid={`invoice-line-desc-${line.id}`}
            className="min-h-8 w-full resize-y overflow-hidden rounded-md border bg-background px-2 py-1 text-sm text-muted-foreground focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-60"
          />
        </td>
      </tr>
      {children.map((ch) => (
        <tr key={ch.id} className="border-t bg-muted/20 text-xs text-muted-foreground" data-testid={`invoice-line-child-${ch.id}`}>
          <td className="px-3 py-1.5 pl-8"><span aria-hidden="true">↳ </span>{lineTitle(ch)}{!ch.customerVisible ? ' (hidden)' : ''}</td>
          <td className="px-3 py-1.5 text-right">{ch.quantity}</td>
          <td className="px-3 py-1.5 text-right">{formatMoney(ch.unitPrice, currency)}</td>
          <td colSpan={4} />
        </tr>
      ))}
    </>
  );
}
