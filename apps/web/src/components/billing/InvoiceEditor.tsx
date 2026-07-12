import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '../../lib/i18n';
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
import { formatPercent } from '@/lib/i18n/format';

const UNAUTHORIZED = () => void navigateTo('/login', { replace: true });

interface Props {
  detail: InvoiceDetail;
  onChanged: () => void;
}

type AddMode = 'catalog' | 'manual';

// ── Save-grammar helpers (byte-similar local copies of QuoteEditor's — kept
//    inline per CLAUDE.md; a later pass may extract them to shared/). ─────────

// A transient "Saved" cue for a blur-to-save field. Returns the on-flag (drives
// the SR live region + green ring) and a trigger; clears its timer on unmount so
// a late fire can't setState a gone node.
function useSavedFlash(): [boolean, () => void] {
  const [on, setOn] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const flash = useCallback(() => {
    setOn(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setOn(false), 1500);
  }, []);
  return [on, flash];
}

// Visually-hidden polite live region — announces a transient "Saved" to screen
// readers, pairing with the dirty-ring clearing that sighted users see. The
// single per-field announcer (no toast) so SR users hear "Saved" once.
function SrSaved({ show, label, testId }: { show: boolean; label: string; testId?: string }) {
  // role="status" already implies aria-live="polite" — don't double it.
  return <span role="status" className="sr-only" data-testid={testId}>{show ? label : ''}</span>;
}

// A field's save-state outline: amber while unsaved, a brief green pulse when it
// lands, nothing at rest. It's a box-shadow (ring), so it never reflows
// neighbours. Pair with a constant `transition-shadow` on the field.
function fieldRing(dirty: boolean, saved: boolean): string {
  return dirty ? 'ring-1 ring-warning' : saved ? 'ring-1 ring-success' : '';
}

export default function InvoiceEditor({ detail, onChanged }: Props) {
  const { t } = useTranslation('billing');
  const { can } = usePermissions();
  const canWrite = can('invoices', 'write');
  // Cost/margin is a read affordance (mirrors InvoiceDetail + the quote rails'
  // `quotes:read` gate) — anyone who can read the invoice sees it.
  const canSeeMargin = can('invoices', 'read');
  const { invoice, lines } = detail;
  const currency = invoice.currencyCode;
  const profit = useMemo(() => computeInvoiceProfit(lines), [lines]);

  // Per-item "saving" state, keyed so one in-flight mutation never freezes the
  // rest of the editor. Keys: 'notes', 'terms', 'addLine', `qty-<lineId>`,
  // `price-<lineId>`, `name-<lineId>`, `desc-<lineId>`, `taxable-<lineId>`,
  // `visible-<lineId>`, `remove-<lineId>`. `pending` drives disabled styling;
  // `inFlight` is the synchronous double-submit guard (state updates are async).
  const inFlight = useRef<Set<string>>(new Set());
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const isPending = useCallback((key: string) => pending.has(key), [pending]);

  // Run a scoped mutation: mark the key pending, run, surface failures via the
  // standard handleActionError path, and always clear the key. Returns whether
  // the mutation succeeded so callers can flash a quiet "Saved" cue.
  const runScoped = useCallback(
    async (key: string, fn: () => Promise<void>, errMsg: string): Promise<boolean> => {
      if (inFlight.current.has(key)) return false;
      inFlight.current.add(key);
      setPending((s) => { const n = new Set(s); n.add(key); return n; });
      try {
        await fn();
        return true;
      } catch (err) {
        handleActionError(err, errMsg);
        return false;
      } finally {
        inFlight.current.delete(key);
        setPending((s) => { const n = new Set(s); n.delete(key); return n; });
      }
    },
    [],
  );

  const [notes, setNotes] = useState(invoice.notes ?? '');
  const [notesDirty, setNotesDirty] = useState(false);
  const [notesSaved, flashNotesSaved] = useSavedFlash();
  const [terms, setTerms] = useState(invoice.termsAndConditions ?? '');
  const [termsDirty, setTermsDirty] = useState(false);
  const [termsSaved, flashTermsSaved] = useSavedFlash();

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
    if (!res.ok) { handleActionError(new Error(res.statusText), t('invoiceEditor.errors.loadCatalog')); return; }
    const body = (await res.json()) as { data: CatalogItem[] };
    setCatalog(body.data ?? []);
  }, [t]);

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

  const addLine = useCallback(() =>
    runScoped('addLine', async () => {
      if (addMode === 'manual') {
        // A line needs at least a title (name) or a description (mirrors the API refine).
        if (!manualName.trim() && !manualDesc.trim()) return;
        // Guard qty/price with the same rules as the inline commit path so a bad
        // manual entry is explained, not silently coerced (Number('abc') → NaN).
        const q = Number(manualQty);
        const p = Number(manualPrice);
        if (!Number.isFinite(q) || q <= 0) {
          handleActionError(new Error('invalid quantity'), t('invoiceEditor.errors.quantityGreaterThanZero'));
          return;
        }
        if (!Number.isFinite(p) || p < 0) {
          handleActionError(new Error('invalid price'), t('invoiceEditor.errors.nonNegativeUnitPrice'));
          return;
        }
        await runAction({
          request: () => fetchWithAuth(`/invoices/${invoice.id}/lines`, {
            method: 'POST',
            body: JSON.stringify({
              name: manualName.trim() || null,
              description: manualDesc.trim() || null,
              quantity: q,
              unitPrice: p,
              taxable: manualTaxable,
            }),
          }),
          errorFallback: t('invoiceEditor.errors.addLine'),
          successMessage: t('invoiceEditor.success.lineAdded'),
          onUnauthorized: UNAUTHORIZED,
        });
        setManualName(''); setManualDesc(''); setManualQty('1'); setManualPrice('0.00'); setManualTaxable(false);
      } else {
        if (!picked) return;
        const pq = Number(pickQty);
        if (!Number.isFinite(pq) || pq <= 0) {
          handleActionError(new Error('invalid quantity'), t('invoiceEditor.errors.quantityGreaterThanZero'));
          return;
        }
        const path = picked.isBundle
          ? `/invoices/${invoice.id}/lines/bundle`
          : `/invoices/${invoice.id}/lines/catalog`;
        const body = picked.isBundle
          ? { bundleId: picked.id, quantity: pq }
          : { catalogItemId: picked.id, quantity: pq };
        await runAction({
          request: () => fetchWithAuth(path, { method: 'POST', body: JSON.stringify(body) }),
          errorFallback: t('invoiceEditor.errors.addLine'),
          successMessage: t('invoiceEditor.success.lineAdded'),
          onUnauthorized: UNAUTHORIZED,
        });
        setPicked(null); setPickQty('1');
      }
      refresh();
    }, t('invoiceEditor.errors.addLine')),
  [runScoped, addMode, manualName, manualDesc, manualQty, manualPrice, manualTaxable, picked, pickQty, invoice.id, refresh, t]);

  // Inline edit of an existing line. `scopeKey` is per-field so one in-flight
  // save (e.g. qty) never disables the sibling controls. Returns whether it
  // succeeded so the row can flash a quiet "Saved" cue.
  const patchLine = useCallback((lineId: string, patch: Record<string, unknown>, scopeKey: string) =>
    runScoped(scopeKey, async () => {
      await runAction({
        request: () => fetchWithAuth(`/invoices/${invoice.id}/lines/${lineId}`, {
          method: 'PATCH', body: JSON.stringify(patch),
        }),
        errorFallback: t('invoiceEditor.errors.updateLine'),
        onUnauthorized: UNAUTHORIZED,
      });
      refresh();
    }, t('invoiceEditor.errors.updateLine')),
  [runScoped, invoice.id, refresh, t]);

  const removeLine = useCallback((lineId: string) =>
    runScoped(`remove-${lineId}`, async () => {
      await runAction({
        request: () => fetchWithAuth(`/invoices/${invoice.id}/lines/${lineId}`, { method: 'DELETE' }),
        errorFallback: t('invoiceEditor.errors.removeLine'),
        successMessage: t('invoiceEditor.success.lineRemoved'),
        onUnauthorized: UNAUTHORIZED,
      });
      refresh();
    }, t('invoiceEditor.errors.removeLine')),
  [runScoped, invoice.id, refresh, t]);

  const saveNotes = useCallback(async () => {
    if (!notesDirty) return;
    const ok = await runScoped('notes', async () => {
      await runAction({
        request: () => fetchWithAuth(`/invoices/${invoice.id}`, {
          method: 'PATCH', body: JSON.stringify({ notes }),
        }),
        errorFallback: t('invoiceEditor.errors.saveNotes'),
        successMessage: t('invoiceEditor.success.notesSaved'),
        onUnauthorized: UNAUTHORIZED,
      });
      setNotesDirty(false);
      refresh();
    }, t('invoiceEditor.errors.saveNotes'));
    if (ok) flashNotesSaved();
  }, [notesDirty, notes, invoice.id, refresh, runScoped, flashNotesSaved, t]);

  const saveTerms = useCallback(async () => {
    if (!termsDirty) return;
    const ok = await runScoped('terms', async () => {
      await runAction({
        request: () => fetchWithAuth(`/invoices/${invoice.id}`, {
          method: 'PATCH', body: JSON.stringify({ termsAndConditions: terms }),
        }),
        errorFallback: t('invoiceEditor.errors.saveTerms'),
        successMessage: t('invoiceEditor.success.termsSaved'),
        onUnauthorized: UNAUTHORIZED,
      });
      setTermsDirty(false);
      refresh();
    }, t('invoiceEditor.errors.saveTerms'));
    if (ok) flashTermsSaved();
  }, [termsDirty, terms, invoice.id, refresh, runScoped, flashTermsSaved, t]);

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
          {t('invoiceEditor.unapprovedTime', { count: unapprovedCount })}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_300px]">
        {/* Lines */}
        <div className="space-y-4">
          <div className="rounded-lg border bg-card shadow-xs">
            <table className="w-full text-sm" data-testid="invoice-editor-lines">
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-3 py-2 font-medium">{t('invoiceEditor.table.item')}</th>
                  <th className="px-3 py-2 text-right font-medium">{t('invoiceEditor.table.qty')}</th>
                  <th className="px-3 py-2 text-right font-medium">{t('invoiceEditor.table.price')}</th>
                  <th className="px-3 py-2 text-center font-medium">{t('invoiceEditor.table.tax')}</th>
                  <th className="px-3 py-2 text-center font-medium" title={t('invoiceEditor.table.customerVisibleTitle')}>{t('invoiceEditor.table.customerVisible')}</th>
                  <th className="px-3 py-2 text-right font-medium">{t('invoiceEditor.table.total')}</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {parentLines.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-3 py-8 text-center text-sm text-muted-foreground">
                      {t('invoiceEditor.table.empty')}
                    </td>
                  </tr>
                ) : (
                  parentLines.map((l) => (
                    <LineRow
                      key={l.id}
                      line={l}
                      children={childrenOf(l.id)}
                      currency={currency}
                      isPending={isPending}
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
            <div className="mb-3 inline-flex gap-1 rounded-md border bg-muted/40 p-1" role="group" aria-label={t('invoiceEditor.addLine.sourceAria')}>
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
                  {m === 'catalog' ? t('invoiceEditor.addLine.catalogItem') : t('invoiceEditor.addLine.manualLine')}
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
                type="text" placeholder={t('invoiceEditor.fields.name')} aria-label={t('invoiceEditor.fields.lineName')} value={manualName}
                onChange={(e) => setManualName(e.target.value)}
                data-testid="invoice-manual-name"
                className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              />
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_80px_100px_auto_auto]">
                <input
                  type="text" placeholder={t('invoiceEditor.fields.descriptionOptional')} aria-label={t('invoiceEditor.fields.lineDescription')} value={manualDesc}
                  onChange={(e) => setManualDesc(e.target.value)}
                  data-testid="invoice-manual-desc"
                  className="h-9 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                />
                <input
                  type="number" min="0" step="0.01" placeholder={t('invoiceEditor.table.qty')} aria-label={t('invoiceEditor.fields.quantity')} value={manualQty}
                  onChange={(e) => setManualQty(e.target.value)}
                  data-testid="invoice-manual-qty"
                  className="h-9 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                />
                <input
                  type="number" min="0" step="0.01" placeholder={t('invoiceEditor.table.price')} aria-label={t('invoiceEditor.fields.unitPrice')} value={manualPrice}
                  onChange={(e) => setManualPrice(e.target.value)}
                  data-testid="invoice-manual-price"
                  className="h-9 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                />
                <label className="flex items-center gap-1 text-xs">
                  <input type="checkbox" checked={manualTaxable} onChange={(e) => setManualTaxable(e.target.checked)} data-testid="invoice-manual-taxable" />
                  {t('invoiceEditor.fields.taxable')}
                </label>
                <button
                  type="button" onClick={() => void addLine()} disabled={isPending('addLine') || (!manualName.trim() && !manualDesc.trim())}
                  data-testid="invoice-add-line-submit"
                  className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
                >
                  {t('invoiceEditor.addLine.add')}
                </button>
              </div>
              </div>
            ) : picked ? (
              <div className="flex flex-wrap items-center gap-2" data-testid="invoice-catalog-picked">
                <span className="inline-flex items-center gap-1.5 rounded-md border bg-muted/40 px-2.5 py-1.5 text-sm">
                  <span className="font-medium">{picked.name}</span>
                  {picked.isBundle && (
                    <span className="rounded border border-border bg-background px-1 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{t('invoiceEditor.addLine.bundle')}</span>
                  )}
                  <button type="button" onClick={() => setPicked(null)} aria-label={t('invoiceEditor.addLine.clearSelection')} className="ml-1 text-muted-foreground hover:text-foreground">×</button>
                </span>
                <input
                  type="number" min="0" step="0.01" value={pickQty}
                  onChange={(e) => setPickQty(e.target.value)} aria-label={t('invoiceEditor.fields.quantity')}
                  data-testid="invoice-pick-qty"
                  className="h-9 w-20 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                />
                <button
                  type="button" onClick={() => void addLine()} disabled={isPending('addLine')}
                  data-testid="invoice-catalog-add"
                  className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
                >
                  {t('invoiceEditor.addLine.add')}
                </button>
              </div>
            ) : catalog.length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="invoice-catalog-empty">
                {t('invoiceEditor.addLine.noCatalogItems')}{' '}
                <a href="/settings/catalog" className="underline hover:text-foreground">{t('invoiceEditor.addLine.addInCatalog')}</a>.
              </p>
            ) : (
              <CatalogItemPicker
                items={catalog}
                onSelect={(it) => { setPicked(it); setPickQty('1'); }}
                testId="invoice-catalog-picker"
                placeholder={t('invoiceEditor.addLine.searchCatalog')}
              />
            )}
          </div>
          )}
        </div>

        {/* Summary + bill-to + notes + actions */}
        <div className="space-y-4">
          <div className="rounded-lg border bg-card p-4 shadow-xs" data-testid="invoice-summary">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('invoiceEditor.summary.title')}</h3>
            <dl className="space-y-1 text-sm">
              <div className="flex justify-between"><dt className="text-muted-foreground">{t('invoiceEditor.summary.subtotal')}</dt><dd data-testid="invoice-subtotal">{formatMoney(invoice.subtotal, currency)}</dd></div>
              <div className="flex justify-between"><dt className="text-muted-foreground">{t('invoiceEditor.summary.tax')}{!noTaxRate ? ` (${formatPercent(Number(invoice.taxRate), { minimumFractionDigits: 2, maximumFractionDigits: 2 })})` : ''}</dt><dd data-testid="invoice-tax">{formatMoney(invoice.taxTotal, currency)}</dd></div>
              <div className="flex justify-between border-t pt-1 font-semibold"><dt>{t('invoiceEditor.summary.total')}</dt><dd data-testid="invoice-total">{formatMoney(invoice.total, currency)}</dd></div>
            </dl>
            {hasTaxableLine && noTaxRate && (
              <p className="mt-3 text-xs text-muted-foreground" data-testid="invoice-tax-rate-hint">
                {t('invoiceEditor.summary.noTaxRate')}{' '}
                <a href="/settings/billing" className="underline hover:text-foreground">{t('invoiceEditor.summary.setTaxRate')}</a>.
              </p>
            )}
            {/* Internal margin summary — at-a-glance profitability while building the
                invoice (the per-line cost/margin breakdown lives in InvoiceDetail's
                Accounting view). Reuses the shared quote math; never customer-facing. */}
            {canSeeMargin && <MarginPanel profit={profit} currency={currency} idPrefix="invoice" />}
          </div>

          <div className="rounded-lg border bg-card p-4 shadow-xs" data-testid="invoice-bill-to">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('invoiceEditor.billTo.title')}</h3>
            {invoice.billToName ? (
              <p className="text-sm">{invoice.billToName}</p>
            ) : (
              <p className="text-sm text-muted-foreground">
                {t('invoiceEditor.billTo.noContact')}{' '}
                <a href="/settings/organizations" className="underline hover:text-foreground">{t('invoiceEditor.billTo.addInSettings')}</a>.
              </p>
            )}
          </div>

          <div className="rounded-lg border bg-card p-4 shadow-xs">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('invoiceEditor.notes.title')}</h3>
              <UnsavedBadge show={notesDirty} />
            </div>
            <textarea
              value={notes}
              onChange={(e) => { setNotes(e.target.value); setNotesDirty(true); }}
              // Gate ENTRY, not save (disabled, like the qty/price inputs) — a
              // readOnly field is still focusable, so if canWrite flipped false
              // mid-edit the onBlur guard would silently drop the typed note.
              onBlur={() => { if (canWrite) void saveNotes(); }}
              // Also disable while the field's own save is in flight (matches the
              // quote editor's terms field) — a visual busy-cue; the inFlight guard
              // in runScoped already prevents a double-PATCH.
              disabled={!canWrite || isPending('notes')}
              data-testid="invoice-notes"
              rows={3}
              className={`w-full rounded-md border bg-background px-3 py-2 text-sm transition-shadow focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-60 ${fieldRing(notesDirty, notesSaved)}`}
              placeholder={t('invoiceEditor.notes.placeholder')}
            />
          </div>

          <div className="rounded-lg border bg-card p-4 shadow-xs">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('invoiceEditor.terms.title')}</h3>
              <UnsavedBadge show={termsDirty} />
            </div>
            <textarea
              value={terms}
              onChange={(e) => { setTerms(e.target.value); setTermsDirty(true); }}
              onBlur={() => { if (canWrite) void saveTerms(); }}
              disabled={!canWrite || isPending('terms')}
              data-testid="invoice-terms"
              rows={3}
              className={`w-full rounded-md border bg-background px-3 py-2 text-sm transition-shadow focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-60 ${fieldRing(termsDirty, termsSaved)}`}
              placeholder={t('invoiceEditor.terms.placeholder')}
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
  line, children, currency, isPending, onPatch, onRemove,
}: {
  line: InvoiceLine;
  children: InvoiceLine[];
  currency: string;
  isPending: (key: string) => boolean;
  onPatch: (lineId: string, patch: Record<string, unknown>, scopeKey: string) => Promise<boolean>;
  onRemove: (lineId: string) => void;
}) {
  const { t } = useTranslation('billing');
  const { can } = usePermissions();
  const canWrite = can('invoices', 'write');
  // Per-field pending: only the in-flight control disables, so a slow qty save
  // never freezes price/name/desc or a sibling line (scoped-pending backport).
  const nameKey = `name-${line.id}`;
  const descKey = `desc-${line.id}`;
  const qtyKey = `qty-${line.id}`;
  const priceKey = `price-${line.id}`;
  const taxableKey = `taxable-${line.id}`;
  const visibleKey = `visible-${line.id}`;
  const removeKey = `remove-${line.id}`;
  const [name, setName] = useState(line.name ?? '');
  const [desc, setDesc] = useState(line.description ?? '');
  const [qty, setQty] = useState(line.quantity);
  const [price, setPrice] = useState(line.unitPrice);
  // Guard an in-progress edit from being clobbered by a server resync mid-type:
  // the flag is set on keystroke and cleared when a commit is initiated (on
  // blur), so a background refresh landing mid-edit keeps the user's keystrokes
  // while a settled field re-adopts the server's canonical value (mirrors the
  // quote editor's EditableLineRow pattern).
  const nameEdited = useRef(false);
  const descEdited = useRef(false);
  const qtyEdited = useRef(false);
  const priceEdited = useRef(false);
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
  useEffect(() => { if (!qtyEdited.current) setQty(line.quantity); }, [line.quantity]);
  useEffect(() => { if (!priceEdited.current) setPrice(line.unitPrice); }, [line.unitPrice]);

  // Quiet row-level "Saved" flash in place of a per-field success toast:
  // committing any one field briefly pulses the green ring across the row.
  const [saved, setSaved] = useState(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (savedTimer.current) clearTimeout(savedTimer.current); }, []);
  const flashSaved = useCallback(() => {
    setSaved(true);
    if (savedTimer.current) clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setSaved(false), 1500);
  }, []);
  const edit = useCallback(async (patch: Record<string, unknown>, key: string): Promise<boolean> => {
    const ok = await onPatch(line.id, patch, key);
    if (ok) flashSaved();
    return ok;
  }, [onPatch, line.id, flashSaved]);

  // Per-field dirty cue (numeric compare for qty/price so re-typing "3.00" over
  // "3" reads as clean, not dirty).
  const nameDirty = name.trim() !== (line.name ?? '');
  const descDirty = desc.trim() !== (line.description ?? '');
  const qtyDirty = Number(qty) !== Number(line.quantity);
  const priceDirty = Number(price) !== Number(line.unitPrice);

  const commitName = () => {
    if (!canWrite) return;
    const next = name.trim();
    nameEdited.current = false; // committing — let the server value re-adopt next
    if (next === (line.name ?? '')) { setName(line.name ?? ''); return; }
    // A line can't have both name and description blank (mirrors the manual-add rule).
    if (!next && !(line.description ?? '').trim()) {
      handleActionError(new Error('empty line'), t('invoiceEditor.errors.nameOrDescription'));
      setName(line.name ?? '');
      return;
    }
    void edit({ name: next || null }, nameKey);
  };
  const commitDesc = () => {
    if (!canWrite) return;
    const next = desc.trim();
    descEdited.current = false;
    if (next === (line.description ?? '')) { setDesc(line.description ?? ''); return; }
    if (!next && !(line.name ?? '').trim()) {
      handleActionError(new Error('empty line'), t('invoiceEditor.errors.nameOrDescription'));
      setDesc(line.description ?? '');
      return;
    }
    void edit({ description: next || null }, descKey);
  };
  const commitQty = () => {
    if (!canWrite) return;
    const n = Number(qty);
    qtyEdited.current = false;
    if (n === Number(line.quantity)) { setQty(line.quantity); return; } // unchanged — silent (numeric compare)
    // A rejected entry no longer snaps back silently: tell the user why before reverting.
    if (!Number.isFinite(n) || n <= 0) {
      handleActionError(new Error('invalid quantity'), t('invoiceEditor.errors.quantityGreaterThanZero'));
      setQty(line.quantity);
      return;
    }
    void edit({ quantity: n }, qtyKey);
  };
  const commitPrice = () => {
    if (!canWrite) return;
    const n = Number(price);
    priceEdited.current = false;
    if (n === Number(line.unitPrice)) { setPrice(line.unitPrice); return; } // unchanged — silent (numeric compare)
    if (!Number.isFinite(n) || n < 0) {
      handleActionError(new Error('invalid price'), t('invoiceEditor.errors.nonNegativeUnitPrice'));
      setPrice(line.unitPrice);
      return;
    }
    void edit({ unitPrice: n }, priceKey);
  };

  return (
    <>
      <tr className="border-t" data-testid={`invoice-line-${line.id}`}>
        <td className="px-3 py-2">
          <input
            type="text" value={name} disabled={!canWrite || isPending(nameKey)}
            aria-label={t('invoiceEditor.fields.lineName')} placeholder={t('invoiceEditor.fields.name')}
            onChange={(e) => { setName(e.target.value); nameEdited.current = true; }}
            onBlur={commitName}
            data-testid={`invoice-line-name-${line.id}`}
            className={`h-8 w-full rounded-md border bg-background px-2 text-sm font-medium transition-shadow focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-60 ${fieldRing(nameDirty, saved)}`}
          />
        </td>
        <td className="px-3 py-2 text-right">
          <input
            type="number" min="0" step="0.01" value={qty} disabled={!canWrite || isPending(qtyKey)}
            aria-label={t('invoiceEditor.fields.quantity')}
            onChange={(e) => { setQty(e.target.value); qtyEdited.current = true; }}
            onBlur={commitQty}
            data-testid={`invoice-line-qty-${line.id}`}
            className={`h-8 w-20 rounded-md border bg-background px-2 text-right text-sm transition-shadow focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-60 ${fieldRing(qtyDirty, saved)}`}
          />
        </td>
        <td className="px-3 py-2 text-right">
          <input
            type="number" min="0" step="0.01" value={price} disabled={!canWrite || isPending(priceKey)}
            aria-label={t('invoiceEditor.fields.unitPrice')}
            onChange={(e) => { setPrice(e.target.value); priceEdited.current = true; }}
            onBlur={commitPrice}
            data-testid={`invoice-line-price-${line.id}`}
            className={`h-8 w-24 rounded-md border bg-background px-2 text-right text-sm transition-shadow focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-60 ${fieldRing(priceDirty, saved)}`}
          />
        </td>
        <td className="px-3 py-2 text-center">
          <input
            type="checkbox" checked={line.taxable} disabled={!canWrite || isPending(taxableKey)}
            onChange={(e) => void edit({ taxable: e.target.checked }, taxableKey)}
            data-testid={`invoice-line-taxable-${line.id}`}
          />
        </td>
        <td className="px-3 py-2 text-center">
          <input
            type="checkbox" checked={line.customerVisible} disabled={!canWrite || isPending(visibleKey)}
            onChange={(e) => void edit({ customerVisible: e.target.checked }, visibleKey)}
            data-testid={`invoice-line-visible-${line.id}`}
          />
        </td>
        <td className="px-3 py-2 text-right">
          {formatMoney(line.lineTotal, currency)}
          <SrSaved show={saved} label={t('invoiceEditor.saved')} testId={`invoice-line-saved-${line.id}`} />
        </td>
        <td className="px-3 py-2 text-right">
          {canWrite && (
            <button
              type="button" onClick={() => onRemove(line.id)} disabled={isPending(removeKey)}
              data-testid={`invoice-line-remove-${line.id}`}
              className="rounded-md border border-destructive/40 px-2 py-1 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
            >
              {t('invoiceEditor.remove')}
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
            disabled={!canWrite || isPending(descKey)}
            aria-label={t('invoiceEditor.fields.lineDescription')}
            placeholder={t('invoiceEditor.fields.descriptionOptional')}
            onChange={(e) => { setDesc(e.target.value); descEdited.current = true; autoGrowDesc(); }}
            onBlur={commitDesc}
            rows={2}
            data-testid={`invoice-line-desc-${line.id}`}
            className={`min-h-8 w-full resize-y overflow-hidden rounded-md border bg-background px-2 py-1 text-sm text-muted-foreground transition-shadow focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-60 ${fieldRing(descDirty, saved)}`}
          />
        </td>
      </tr>
      {children.map((ch) => (
        <tr key={ch.id} className="border-t bg-muted/20 text-xs text-muted-foreground" data-testid={`invoice-line-child-${ch.id}`}>
          <td className="px-3 py-1.5 pl-8"><span aria-hidden="true">↳ </span>{lineTitle(ch)}{!ch.customerVisible ? t('invoiceEditor.hiddenSuffix') : ''}</td>
          <td className="px-3 py-1.5 text-right">{ch.quantity}</td>
          <td className="px-3 py-1.5 text-right">{formatMoney(ch.unitPrice, currency)}</td>
          <td colSpan={4} />
        </tr>
      ))}
    </>
  );
}
