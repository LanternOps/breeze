// PO-style "to be ordered" breakdown for a won (accepted/converted) quote —
// the procurement view of the same lines the pricing tables render for the
// customer: SKU / part number / qty plus the toggle-gated unit cost, extended
// cost and markup. Internal Detail tab only; the portal/public documents never
// receive unitCost (toCustomerLines strips it server-side).
import { Fragment, useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, ClipboardCopy, Download } from 'lucide-react';
import '../../../lib/i18n';
import {
  computeLineTotal,
  deriveLineFulfillment,
  fromCents,
  markupPct,
  toCents,
  type QuoteLineFulfillmentStatus,
} from '@breeze/shared';
import { formatPercent } from '@/lib/i18n/format';
import { rowsToCsv, rowsToTsv } from '@/lib/csvExport';
import { downloadBlob } from '@/lib/downloadBlob';
import { usePermissions } from '../../../lib/permissions';
import { showToast } from '../../shared/Toast';
import {
  type QuoteDetail,
  type QuoteLine,
  type QuoteOrder,
  type QuoteOrderLine,
  formatMoney,
  formatQuantity,
  lineTitle,
  procurementSourceLabel,
} from './quoteTypes';
import {
  QuoteOrderAllocationRow,
  QuoteOrderTrackingDialog,
  unorderedRemainder,
  type QuoteOrderCandidate,
} from './QuoteOrderTracking';
import { StatusPill } from '../shared/StatusPill';
import type { StatusPillRole } from '../shared/statusPillRoles';

type Pax8Order = NonNullable<QuoteDetail['pax8Order']>;
type Pax8OrderLine = Pax8Order['lines'][number];

/** Cross-reference state for a single order line against its staged/converted
 *  Pax8 order — never a blanket "fulfilled"; the label is state-accurate.
 *  `line.submitState` is typed `Pax8SubmitState` (packages/shared/src/types/pax8-enums.ts:
 *  `pending | in_flight | succeeded | failed | needs_reconcile`), so this switches
 *  on the full real enum — a future member added there is a compile error here,
 *  not a silent fall-through to no badge.
 *  Precedence (checked in order):
 *   1. failed — the line's own submit outcome, OR an order-wide failure. Highest
 *      precedence. Order-level `status === 'failed'` is set by
 *      `deriveOrderStatus` (apps/api/src/services/pax8OrderSubmitRepository.ts)
 *      only when EVERY line failed, so pairing it with a `succeeded` line
 *      shouldn't occur in practice — checking it here anyway is defensive, not
 *      a case this UI expects to hit.
 *   2. needs_reconcile — the state a technician most needs to see (an unknown
 *      write against Pax8 that wasn't confirmed either way).
 *   3. ordered — only a CONFIRMED `succeeded` submit reads as ordered.
 *   4. staged (catch-all) — `pending`/`in_flight`: submission hasn't been
 *      confirmed ordered yet, regardless of the order's own status (an
 *      in-flight submission for THIS line is still "staged" from the tech's
 *      point of view even if the order record itself has moved past
 *      awaiting_details/draft for other lines). */
export function pax8BadgeState(order: Pax8Order, line: Pax8OrderLine): 'staged' | 'ordered' | 'failed' | 'reconcile' {
  if (line.submitState === 'failed' || order.status === 'failed') return 'failed';
  if (line.submitState === 'needs_reconcile') return 'reconcile';
  if (line.submitState === 'succeeded') return 'ordered';
  return 'staged'; // remaining Pax8SubmitState values: 'pending' | 'in_flight'
}

const PAX8_BADGE_ROLE: Record<'staged' | 'ordered' | 'failed' | 'reconcile', StatusPillRole> = {
  staged: 'info',
  ordered: 'success',
  failed: 'danger',
  reconcile: 'warning',
};

/** Lines the MSP actually has to procure once the quote is won: anything
 *  carrying a distributor identifier (SKU / part number), plus hardware-typed
 *  lines even without one. Service/labor and identifier-less manual lines
 *  stay out — there is nothing to order for them. */
export function orderableLines(lines: QuoteLine[]): QuoteLine[] {
  return lines
    .filter((l) => Boolean(l.sku || l.partNumber || l.itemType === 'hardware'))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt));
}

/** Bucket key for a line's distributor; identifier-less lines share 'unknown'. */
const UNKNOWN_VENDOR = 'unknown';

/** Vendor display text for a source key (raw key when unmapped — an unmapped
 *  distributor is still information). The map lives in quoteTypes so the
 *  fulfillment dialog shares it without an import cycle. */
const sourceLabel = procurementSourceLabel;

/** Fulfillment status → pill role. `not_ordered` has no role because it renders
 *  NO chip at all: the absence of a chip is what "not ordered yet" looks like,
 *  and a row of grey "Not ordered" pills on a fresh quote is pure noise. */
const FULFILLMENT_ROLE: Record<Exclude<QuoteLineFulfillmentStatus, 'not_ordered'>, StatusPillRole> = {
  ordered: 'info',
  partially_received: 'warning',
  received: 'success',
};

/** i18n leaf for a fulfillment status (the enum is snake_case, the catalog is
 *  camelCase — spelled out rather than transformed so keyUsage can see them). */
const FULFILLMENT_LABEL_KEY: Record<Exclude<QuoteLineFulfillmentStatus, 'not_ordered'>, string> = {
  ordered: 'quotes.detail.orderBreakdown.fulfillment.status.ordered',
  partially_received: 'quotes.detail.orderBreakdown.fulfillment.status.partiallyReceived',
  received: 'quotes.detail.orderBreakdown.fulfillment.status.received',
};

/**
 * Bucket the (already sorted) orderable lines by distributor so a tech can work
 * one vendor's cart at a time. Groups follow FIRST-APPEARANCE order of the
 * sources rather than an alphabetical sort, so the table's vendor sequence
 * tracks the quote's own line order; the identifier-less 'unknown' bucket is
 * always last because it's the leftover pile, not a vendor. Line order WITHIN a
 * group is preserved exactly as passed in.
 */
export function groupByVendor(lines: QuoteLine[]): { key: string; lines: QuoteLine[] }[] {
  const order: string[] = [];
  const buckets = new Map<string, QuoteLine[]>();
  for (const l of lines) {
    const key = l.procurementSource ?? UNKNOWN_VENDOR;
    if (!buckets.has(key)) {
      buckets.set(key, []);
      if (key !== UNKNOWN_VENDOR) order.push(key);
    }
    buckets.get(key)!.push(l);
  }
  const keys = [...order, ...(buckets.has(UNKNOWN_VENDOR) ? [UNKNOWN_VENDOR] : [])];
  return keys.map((key) => ({ key, lines: buckets.get(key)! }));
}

/**
 * Flatten the breakdown to spreadsheet rows. Keys become the header row, so
 * they stay stable machine-ish English regardless of UI locale — these files
 * get pasted into distributor order forms and partner-side sheets, where a
 * column named "Menge" one day and "Qty" the next breaks whatever consumes it.
 * Cost columns appear ONLY when the caller is already showing cost on screen,
 * so the export can never leak margin a viewer isn't cleared for.
 */
export function exportRows(
  lines: QuoteLine[],
  showCost: boolean,
  currency: string,
): Array<Record<string, string>> {
  return lines.map((l) => ({
    item: lineTitle(l),
    vendor: l.procurementSource ? sourceLabel(l.procurementSource) : '',
    manufacturer: l.manufacturer ?? '',
    sku: l.vendorSku || l.sku || '',
    partNumber: l.partNumber ?? '',
    qty: formatQuantity(l.quantity),
    ...(showCost
      ? {
          unitCost: l.unitCost ?? '',
          extCost: l.unitCost === null ? '' : computeLineTotal(l.quantity, l.unitCost),
          currency,
        }
      : {}),
  }));
}

// `showCost` rides the same persisted "Show cost & margin" toggle as the rest
// of the billing UI, so "no margin on screen" holds here too: with it off the
// table still lists what to order (item/SKU/qty) but drops the economics.
export default function QuoteOrderBreakdown({ lines, currency, showCost, quoteId, quoteNumber, pax8Order, orders, onChanged }: {
  lines: QuoteLine[];
  currency: string;
  showCost: boolean;
  /** The quote these lines belong to — the fulfillment routes are nested under
   *  it (`/quotes/:quoteId/orders`). */
  quoteId: string;
  /** Used only to name the downloaded file; a quote without a number yet still
   *  exports (the filename just falls back to the generic form). */
  quoteNumber: string | null;
  /** The same quote's staged/converted Pax8 order, if any — cross-referenced
   *  against each line below by `sourceQuoteLineId` to render a state-accurate
   *  badge. Optional/nullable: a won quote may have no Pax8 order at all. */
  pax8Order?: QuoteDetail['pax8Order'];
  /** Real-world purchase orders recorded against these lines. */
  orders?: QuoteOrder[];
  /** Reload the quote after a fulfillment mutation. */
  onChanged?: () => void;
}) {
  const { t } = useTranslation('billing');
  const { can } = usePermissions();
  // quotes:fulfill is deliberately separate from quotes:write: a tech who can
  // edit a draft can't necessarily record real purchases against it. Without it
  // the breakdown stays a read-only procurement view — statuses still show.
  const canFulfill = can('quotes', 'fulfill');
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [dialogOpen, setDialogOpen] = useState(false);
  // Same cents math as the pricing tables (computeLineTotal/toCents) so the
  // cost total is penny-consistent with MarginPanel's cost figure.
  const costTotal = useMemo(
    () =>
      fromCents(
        lines.reduce(
          (sum, l) => (l.unitCost === null ? sum : sum + toCents(computeLineTotal(l.quantity, l.unitCost))),
          0,
        ),
      ),
    [lines],
  );
  const missingCostCount = useMemo(() => lines.filter((l) => l.unitCost === null).length, [lines]);
  // Keyed by sourceQuoteLineId so the item cell can look up this line's own
  // Pax8 submit outcome in O(1). Lines with a null sourceQuoteLineId (shouldn't
  // happen for a quote-sourced order, but defensive) are excluded rather than
  // colliding on a shared `null` key.
  const pax8ByLine = useMemo(
    () => new Map((pax8Order?.lines ?? []).filter((l) => l.sourceQuoteLineId).map((l) => [l.sourceQuoteLineId as string, l])),
    [pax8Order],
  );
  // Allocations keyed by the quote line they cover, so each row can derive its
  // own fulfillment status and list its own allocations in O(1). Carries the
  // owning order alongside each allocation — the row shows the vendor/order ref
  // the allocation belongs to.
  const allocationsByLine = useMemo(() => {
    const map = new Map<string, { allocation: QuoteOrderLine; order: QuoteOrder }[]>();
    for (const order of orders ?? []) {
      for (const allocation of order.lines) {
        const bucket = map.get(allocation.quoteLineId);
        if (bucket) bucket.push({ allocation, order });
        else map.set(allocation.quoteLineId, [{ allocation, order }]);
      }
    }
    return map;
  }, [orders]);

  const na = '—';
  const groups = useMemo(() => groupByVendor(lines), [lines]);
  // A single group is just "the table" — a lone header row would be noise.
  const showGroupHeaders = groups.length > 1;
  // Item + Vendor + SKU + Part # + Qty (+ Unit cost + Ext. cost + Markup), plus
  // the leading select box when the viewer may record orders.
  const columnCount = (showCost ? 8 : 5) + (canFulfill ? 1 : 0);

  const toggleLine = useCallback((lineId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(lineId)) next.delete(lineId);
      else next.add(lineId);
      return next;
    });
  }, []);

  // Lines the dialog can actually order: selected AND with something left to
  // order. A fully-covered line is dropped rather than defaulted to a bogus
  // quantity — the create schema rejects anything ≤ 0 anyway.
  const candidates = useMemo<QuoteOrderCandidate[]>(
    () =>
      lines
        .filter((l) => selected.has(l.id))
        .map((l) => ({
          lineId: l.id,
          title: lineTitle(l),
          remainder: unorderedRemainder(
            l.quantity,
            (allocationsByLine.get(l.id) ?? []).map((x) => x.allocation),
          ),
          procurementSource: l.procurementSource ?? null,
        }))
        .filter((c) => Number(c.remainder) > 0),
    [lines, selected, allocationsByLine],
  );

  const closeDialog = useCallback(() => setDialogOpen(false), []);
  const handleOrdered = useCallback(() => {
    setSelected(new Set());
    onChanged?.();
  }, [onChanged]);

  const handleExportCsv = useCallback(() => {
    const csv = rowsToCsv(exportRows(lines, showCost, currency));
    downloadBlob(
      new Blob([csv], { type: 'text/csv;charset=utf-8;' }),
      `quote-${quoteNumber ?? 'draft'}-to-be-ordered.csv`,
    );
  }, [lines, showCost, currency, quoteNumber]);

  // Clipboard writes are a user-gesture API and can be refused (permission,
  // insecure context, no clipboard at all in some embedded webviews) — a copy
  // button that silently does nothing is worse than one that says it failed.
  const handleCopyTsv = useCallback(async () => {
    const tsv = rowsToTsv(exportRows(lines, showCost, currency));
    try {
      await navigator.clipboard.writeText(tsv);
      showToast({ type: 'success', message: t('quotes.detail.orderBreakdown.copied') });
    } catch {
      showToast({ type: 'error', message: t('quotes.detail.orderBreakdown.copyFailed') });
    }
  }, [lines, showCost, currency, t]);

  return (
    <div className="rounded-lg border bg-card shadow-xs" data-testid="quote-order-breakdown">
      <div className="flex items-baseline justify-between gap-2 border-b px-3 py-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t('quotes.detail.orderBreakdown.title')}
        </h3>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground" data-testid="quote-order-breakdown-count">
            {t('quotes.detail.orderBreakdown.itemCount', { count: lines.length })}
          </span>
          {canFulfill && (
            <button
              type="button"
              disabled={selected.size === 0}
              onClick={() => setDialogOpen(true)}
              data-testid="quote-order-breakdown-mark-ordered"
              className="rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              {t('quotes.detail.orderBreakdown.fulfillment.markOrdered')}
            </button>
          )}
          {/* Real <button>s with an accessible name (aria-label doubles as the
              hover tooltip via title) — icon-only, but tabbable and announced. */}
          <button
            type="button"
            onClick={handleExportCsv}
            className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            aria-label={t('quotes.detail.orderBreakdown.exportCsv')}
            title={t('quotes.detail.orderBreakdown.exportCsv')}
            data-testid="quote-order-breakdown-export-csv"
          >
            <Download className="h-4 w-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={handleCopyTsv}
            className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            aria-label={t('quotes.detail.orderBreakdown.copyTsv')}
            title={t('quotes.detail.orderBreakdown.copyTsv')}
            data-testid="quote-order-breakdown-copy-tsv"
          >
            <ClipboardCopy className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </div>
      <div
        className="overflow-x-auto"
        role="region"
        aria-label={t('quotes.detail.tableScrollAria', { label: t('quotes.detail.orderBreakdown.title') })}
        tabIndex={0}
      >
        <table className="w-full min-w-[36rem] text-sm" data-testid="quote-order-breakdown-table">
          <thead>
            <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
              {canFulfill && (
                <th className="w-8 px-3 py-2 font-medium">
                  <span className="sr-only">{t('quotes.detail.orderBreakdown.fulfillment.selectColumn')}</span>
                </th>
              )}
              <th className="px-3 py-2 font-medium">{t('quotes.detail.orderBreakdown.table.item')}</th>
              <th className="px-3 py-2 font-medium">{t('quotes.detail.orderBreakdown.table.vendor')}</th>
              <th className="px-3 py-2 font-medium">{t('quotes.detail.orderBreakdown.table.sku')}</th>
              <th className="px-3 py-2 font-medium">{t('quotes.detail.orderBreakdown.table.partNumber')}</th>
              <th className="px-3 py-2 text-right font-medium">{t('quotes.detail.orderBreakdown.table.qty')}</th>
              {showCost && (
                <>
                  <th className="px-3 py-2 text-right font-medium">{t('quotes.detail.orderBreakdown.table.unitCost')}</th>
                  <th className="px-3 py-2 text-right font-medium">{t('quotes.detail.orderBreakdown.table.extCost')}</th>
                  <th className="px-3 py-2 text-right font-medium">{t('quotes.detail.orderBreakdown.table.markup')}</th>
                </>
              )}
            </tr>
          </thead>
          {/* One <tbody> per vendor so a tech can work a single distributor's
              cart at a time. The cost total stays in the shared <tfoot> below —
              it spans EVERY line, not one subtotal per group. */}
          {groups.map((group) => (
            <tbody key={group.key} data-testid={`quote-order-breakdown-tbody-${group.key}`}>
              {showGroupHeaders && (
                <tr className="border-t bg-muted/50" data-testid={`quote-order-breakdown-group-${group.key}`}>
                  <th
                    scope="colgroup"
                    colSpan={columnCount}
                    className="px-3 py-1.5 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                  >
                    {group.key === UNKNOWN_VENDOR
                      ? t('quotes.detail.orderBreakdown.unknownVendor')
                      : sourceLabel(group.key)}
                  </th>
                </tr>
              )}
              {group.lines.map((l) => {
                const mk = markupPct(l.unitPrice, l.unitCost);
                const pax8Line = pax8Order ? pax8ByLine.get(l.id) : undefined;
                const pax8Badge = pax8Line ? pax8BadgeState(pax8Order!, pax8Line) : null;
                const allocations = allocationsByLine.get(l.id) ?? [];
                const fulfillment = deriveLineFulfillment(allocations.map((x) => x.allocation));
                return (
                <Fragment key={l.id}>
                <tr className="border-t" data-testid={`quote-order-breakdown-line-${l.id}`}>
                  {canFulfill && (
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        checked={selected.has(l.id)}
                        onChange={() => toggleLine(l.id)}
                        aria-label={t('quotes.detail.orderBreakdown.fulfillment.select', { item: lineTitle(l) })}
                        data-testid={`quote-order-breakdown-select-${l.id}`}
                        className="h-4 w-4 rounded border-border accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                      />
                    </td>
                  )}
                  <td className="px-3 py-2">
                    <span className="font-medium text-foreground">{lineTitle(l)}</span>
                    {l.recurrence !== 'one_time' && (
                      <span className="ml-2 inline-flex items-center rounded-full border border-border bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-foreground/70 dark:text-muted-foreground">
                        {t(/* i18n-dynamic */ `quotes.recurrence.${l.recurrence}`)}
                      </span>
                    )}
                    {pax8Badge && (
                      <StatusPill
                        role={PAX8_BADGE_ROLE[pax8Badge]}
                        label={t(/* i18n-dynamic */ `quotes.detail.orderBreakdown.pax8Badge.${pax8Badge}`)}
                        className="ml-2"
                        testId={`quote-order-breakdown-pax8-${l.id}`}
                      />
                    )}
                    {/* No chip for 'not_ordered' — the absence IS the state, and
                        a grid of grey "Not ordered" pills on a fresh quote is noise. */}
                    {fulfillment !== 'not_ordered' && (
                      <StatusPill
                        role={FULFILLMENT_ROLE[fulfillment]}
                        label={t(/* i18n-dynamic */ FULFILLMENT_LABEL_KEY[fulfillment])}
                        className="ml-2"
                        testId={`quote-order-breakdown-status-${l.id}`}
                      />
                    )}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {l.procurementSource ? sourceLabel(l.procurementSource) : na}
                    {l.manufacturer && <div className="text-xs">{l.manufacturer}</div>}
                  </td>
                  {/* Vendor SKU is what the distributor's cart wants; the internal
                      SKU is the fallback when the line wasn't sourced from one. */}
                  <td className="px-3 py-2 tabular-nums text-muted-foreground">{l.vendorSku || l.sku || na}</td>
                  <td className="px-3 py-2 tabular-nums text-muted-foreground">{l.partNumber || na}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatQuantity(l.quantity)}</td>
                  {showCost && (
                    <>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {l.unitCost === null ? na : formatMoney(l.unitCost, currency)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {l.unitCost === null ? na : formatMoney(computeLineTotal(l.quantity, l.unitCost), currency)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                        {mk === null ? na : formatPercent(mk / 100, { maximumFractionDigits: 2 })}
                      </td>
                    </>
                  )}
                </tr>
                {allocations.map(({ allocation, order }) => (
                  <QuoteOrderAllocationRow
                    key={allocation.id}
                    quoteId={quoteId}
                    allocation={allocation}
                    vendorLabel={order.vendorName ?? (order.procurementSource ? sourceLabel(order.procurementSource) : null)}
                    orderRef={order.orderRef}
                    colSpan={columnCount}
                    canFulfill={canFulfill}
                    onChanged={onChanged}
                  />
                ))}
                </Fragment>
                );
              })}
            </tbody>
          ))}
          {showCost && (
            <tfoot>
              <tr className="border-t">
                {/* Item + Vendor + SKU + Part # + Qty + Unit cost = 6 cells before
                    the Ext. cost figure (7 with the leading select column); the
                    trailing empty cell covers Markup. */}
                <td colSpan={canFulfill ? 7 : 6} className="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {t('quotes.detail.orderBreakdown.costTotal')}
                </td>
                <td className="px-3 py-2 text-right font-semibold tabular-nums" data-testid="quote-order-breakdown-cost-total">
                  {formatMoney(costTotal, currency)}
                </td>
                <td className="px-3 py-2" />
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      {/* Missing costs understate the total silently — flag them (same warning
          treatment as the editor's per-line missing-cost figure). */}
      {showCost && missingCostCount > 0 && (
        <p
          className="flex items-center gap-1 border-t px-3 py-2 text-xs text-warning-foreground dark:text-warning"
          data-testid="quote-order-breakdown-missing-cost"
        >
          <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />
          {t('quotes.detail.orderBreakdown.missingCost', { count: missingCostCount })}
        </p>
      )}
      {/* Mounted only while open so every attempt gets fresh state — including a
          fresh idempotency key. */}
      {dialogOpen && (
        <QuoteOrderTrackingDialog
          open
          quoteId={quoteId}
          candidates={candidates}
          onClose={closeDialog}
          onChanged={handleOrdered}
        />
      )}
    </div>
  );
}
