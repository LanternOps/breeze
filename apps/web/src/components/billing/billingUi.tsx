// Shared presentational helpers for the quote + invoice billing UI, so copy and
// affordances can't drift between the editor and detail/document surfaces.

import { AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import '../../lib/i18n';
import { marginPct, type QuoteProfit } from '@breeze/shared';
import { formatMoney } from './quotes/quoteTypes';

/**
 * Inline "Unsaved" affordance for blur-saved fields (terms / notes). Shown while
 * the field holds uncommitted edits; the field's onBlur save clears the dirty
 * flag on success, so this also stays lit if a save FAILS — surfacing that the
 * edit didn't persist instead of relying on a transient toast the user may miss.
 */
export function UnsavedBadge({ show, testId = 'unsaved-badge' }: { show: boolean; testId?: string }) {
  const { t } = useTranslation('billing');
  if (!show) return null;
  return (
    <span
      // role="status" (implicit aria-live=polite) so the badge appearing — e.g.
      // when a blur-save fails and the edit stays dirty — is announced, not just
      // shown. Dark-amber text (not the ~2:1 bright warning) keeps it readable.
      role="status"
      className="inline-flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-warning-foreground dark:text-warning"
      data-testid={testId}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-warning" aria-hidden="true" />
      {t('billingUi.unsaved')}
    </span>
  );
}

/**
 * The recurring-billing explanation shown beneath quote totals. Single source so
 * the editor and the detail view can't drift (the customer-facing QuoteDocument
 * keeps its own shorter copy intentionally).
 */
export function RecurringBillingNote({ className, testId }: { className?: string; testId?: string }) {
  const { t } = useTranslation('billing');
  return (
    <p className={`text-xs leading-relaxed text-muted-foreground ${className ?? ''}`} data-testid={testId}>
      {t('billingUi.recurringBillingNote')}
    </p>
  );
}

/**
 * Internal cost / profit summary for a quote or invoice. Single source so the
 * editor rail and the internal detail view show the same figures with the same
 * labels — and so the "missing cost" warning stays readable (dark amber text +
 * icon) instead of the low-contrast bright-amber it used to be. NEVER rendered on
 * the customer document. Each surface gates it on its own read permission
 * (`quotes:read` / `invoices:read`) — cost is a read affordance, not a write one.
 *
 * `idPrefix` namespaces the data-testids so quote and invoice instances don't
 * collide in tests; it defaults to `quote` for the original quote callers.
 * Invoices are one-time, so their `QuoteProfit` carries zero monthly/annual net
 * and those rows self-hide — the component needs no invoice-specific shape.
 */
export function MarginPanel({
  profit,
  currency,
  idPrefix = 'quote',
  onMissingCostClick,
}: {
  profit: QuoteProfit;
  currency: string;
  idPrefix?: string;
  /** Optional: makes the missing-cost notice an actionable button (e.g. the
   *  quote editor wires this to scroll/expand/focus the first offending line).
   *  Callers with nothing to jump to (QuoteDetail, InvoiceDetail/Editor) omit
   *  it and keep the plain static notice — MarginPanel itself stays generic. */
  onMissingCostClick?: () => void;
}) {
  const { t } = useTranslation('billing');
  // Margin (net / revenue), NOT markup (net / cost) — null (and hidden) when a
  // cadence has no cost-bearing lines to compute a percent from (div-by-zero
  // guard lives in marginPct). Partially-incomplete cadences (some lines have
  // cost, some don't) still show a percent computed over the available lines,
  // same partial-figure contract the dollar net already has — the missing-cost
  // notice below is the one shared caveat for both.
  const oneTimePct = marginPct(profit.oneTimeNet, profit.oneTimeRevenue);
  const monthlyPct = marginPct(profit.monthlyRecurringNet, profit.monthlyRecurringRevenue);
  const annualPct = marginPct(profit.annualRecurringNet, profit.annualRecurringRevenue);
  return (
    <div className="mt-3 rounded-md bg-muted/40 p-2 text-sm" data-testid={`${idPrefix}-margin`}>
      <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {t('billingUi.margin.title')}
      </div>
      <dl className="space-y-1 tabular-nums">
        <div className="flex justify-between"><dt className="text-muted-foreground">{t('billingUi.margin.cost')}</dt><dd data-testid={`${idPrefix}-margin-cost`}>{formatMoney(profit.totalCost, currency)}</dd></div>
        <div className="flex justify-between">
          <dt className="text-muted-foreground">{t('billingUi.margin.profitOneTime')}</dt>
          <dd data-testid={`${idPrefix}-margin-net-onetime`}>
            {formatMoney(profit.oneTimeNet, currency)}
            {oneTimePct !== null && <span className="ml-1 text-xs text-muted-foreground" data-testid={`${idPrefix}-margin-pct-onetime`}>({oneTimePct.toFixed(1)}%)</span>}
          </dd>
        </div>
        {Number(profit.monthlyRecurringNet) !== 0 && (
          <div className="flex justify-between">
            <dt className="text-muted-foreground">{t('billingUi.margin.profitMonthly')}</dt>
            <dd data-testid={`${idPrefix}-margin-net-monthly`}>
              {formatMoney(profit.monthlyRecurringNet, currency)}<span className="text-xs text-muted-foreground">{t('billingUi.units.perMonth')}</span>
              {monthlyPct !== null && <span className="ml-1 text-xs text-muted-foreground" data-testid={`${idPrefix}-margin-pct-monthly`}>({monthlyPct.toFixed(1)}%)</span>}
            </dd>
          </div>
        )}
        {Number(profit.annualRecurringNet) !== 0 && (
          <div className="flex justify-between">
            <dt className="text-muted-foreground">{t('billingUi.margin.profitAnnual')}</dt>
            <dd data-testid={`${idPrefix}-margin-net-annual`}>
              {formatMoney(profit.annualRecurringNet, currency)}<span className="text-xs text-muted-foreground">{t('billingUi.units.perYear')}</span>
              {annualPct !== null && <span className="ml-1 text-xs text-muted-foreground" data-testid={`${idPrefix}-margin-pct-annual`}>({annualPct.toFixed(1)}%)</span>}
            </dd>
          </div>
        )}
      </dl>
      {profit.linesMissingCost > 0 && (
        onMissingCostClick ? (
          <button
            type="button"
            onClick={onMissingCostClick}
            className="mt-1 flex w-full items-start gap-1 rounded text-left text-xs text-warning-foreground hover:underline focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring dark:text-warning"
            data-testid={`${idPrefix}-margin-missing-cost`}
          >
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" aria-hidden="true" />
            <span>
              {t('billingUi.margin.missingCost', { count: profit.linesMissingCost })}
            </span>
          </button>
        ) : (
          <p className="mt-1 flex items-start gap-1 text-xs text-warning-foreground dark:text-warning" data-testid={`${idPrefix}-margin-missing-cost`}>
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" aria-hidden="true" />
            <span>
              {t('billingUi.margin.missingCost', { count: profit.linesMissingCost })}
            </span>
          </p>
        )
      )}
    </div>
  );
}
