// PO-style "to be ordered" breakdown for a won (accepted/converted) quote —
// the procurement view of the same lines the pricing tables render for the
// customer: SKU / part number / qty plus the toggle-gated unit cost, extended
// cost and markup. Internal Detail tab only; the portal/public documents never
// receive unitCost (toCustomerLines strips it server-side).
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';
import '../../../lib/i18n';
import { computeLineTotal, fromCents, markupPct, toCents } from '@breeze/shared';
import { formatPercent } from '@/lib/i18n/format';
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

// `showCost` rides the same persisted "Show cost & margin" toggle as the rest
// of the billing UI, so "no margin on screen" holds here too: with it off the
// table still lists what to order (item/SKU/qty) but drops the economics.
export default function QuoteOrderBreakdown({ lines, currency, showCost }: {
  lines: QuoteLine[];
  currency: string;
  showCost: boolean;
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

  return (
    <div className="rounded-lg border bg-card shadow-xs" data-testid="quote-order-breakdown">
      <div className="flex items-baseline justify-between gap-2 border-b px-3 py-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t('quotes.detail.orderBreakdown.title')}
        </h3>
        <span className="text-xs text-muted-foreground" data-testid="quote-order-breakdown-count">
          {t('quotes.detail.orderBreakdown.itemCount', { count: lines.length })}
        </span>
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
          <tbody>
            {lines.map((l) => {
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
