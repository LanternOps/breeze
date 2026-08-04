// PO-style "to be ordered" breakdown for a won (accepted/converted) quote —
// the procurement view of the same lines the pricing tables render for the
// customer: SKU / part number / qty plus the toggle-gated unit cost, extended
// cost and markup. Internal Detail tab only; the portal/public documents never
// receive unitCost (toCustomerLines strips it server-side).
import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, ClipboardCopy, Download } from 'lucide-react';
import '../../../lib/i18n';
import { computeLineTotal, fromCents, markupPct, toCents } from '@breeze/shared';
import { formatPercent } from '@/lib/i18n/format';
import { rowsToCsv, rowsToTsv } from '@/lib/csvExport';
import { downloadBlob } from '@/lib/downloadBlob';
import { showToast } from '../../shared/Toast';
import { type QuoteLine, formatMoney, formatQuantity, lineTitle } from './quoteTypes';

/** Lines the MSP actually has to procure once the quote is won: anything
 *  carrying a distributor identifier (SKU / part number), plus hardware-typed
 *  lines even without one. Service/labor and identifier-less manual lines
 *  stay out — there is nothing to order for them. */
export function orderableLines(lines: QuoteLine[]): QuoteLine[] {
  return lines
    .filter((l) => Boolean(l.sku || l.partNumber || l.itemType === 'hardware'))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt));
}

// Distributor identifiers are stored as the API's snake_case source keys; the
// breakdown shows the vendor's own branding. Unknown sources fall through to the
// raw key rather than an em-dash — an unmapped distributor is still information.
const SOURCE_LABELS: Record<string, string> = { td_synnex: 'TD SYNNEX', pax8: 'Pax8' };

/** Bucket key for a line's distributor; identifier-less lines share 'unknown'. */
const UNKNOWN_VENDOR = 'unknown';

/** Vendor display text for a source key (raw key when unmapped — an unmapped
 *  distributor is still information). */
function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}

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
export default function QuoteOrderBreakdown({ lines, currency, showCost, quoteNumber }: {
  lines: QuoteLine[];
  currency: string;
  showCost: boolean;
  /** Used only to name the downloaded file; a quote without a number yet still
   *  exports (the filename just falls back to the generic form). */
  quoteNumber: string | null;
}) {
  const { t } = useTranslation('billing');
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
  const na = '—';
  const groups = useMemo(() => groupByVendor(lines), [lines]);
  // A single group is just "the table" — a lone header row would be noise.
  const showGroupHeaders = groups.length > 1;
  // Item + Vendor + SKU + Part # + Qty (+ Unit cost + Ext. cost + Markup).
  const columnCount = showCost ? 8 : 5;

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
                return (
                <tr key={l.id} className="border-t" data-testid={`quote-order-breakdown-line-${l.id}`}>
                  <td className="px-3 py-2">
                    <span className="font-medium text-foreground">{lineTitle(l)}</span>
                    {l.recurrence !== 'one_time' && (
                      <span className="ml-2 inline-flex items-center rounded-full border border-border bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-foreground/70 dark:text-muted-foreground">
                        {t(/* i18n-dynamic */ `quotes.recurrence.${l.recurrence}`)}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {l.procurementSource ? (SOURCE_LABELS[l.procurementSource] ?? l.procurementSource) : na}
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
                );
              })}
            </tbody>
          ))}
          {showCost && (
            <tfoot>
              <tr className="border-t">
                {/* Item + Vendor + SKU + Part # + Qty + Unit cost = 6 cells before
                    the Ext. cost figure; the trailing empty cell covers Markup. */}
                <td colSpan={6} className="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide text-muted-foreground">
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
    </div>
  );
}
