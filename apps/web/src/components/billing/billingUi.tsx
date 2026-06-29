// Shared presentational helpers for the quote + invoice billing UI, so copy and
// affordances can't drift between the editor and detail/document surfaces.

import { AlertTriangle } from 'lucide-react';
import type { QuoteProfit } from '@breeze/shared';
import { formatMoney } from './quotes/quoteTypes';

/**
 * Inline "Unsaved" affordance for blur-saved fields (terms / notes). Shown while
 * the field holds uncommitted edits; the field's onBlur save clears the dirty
 * flag on success, so this also stays lit if a save FAILS — surfacing that the
 * edit didn't persist instead of relying on a transient toast the user may miss.
 */
export function UnsavedBadge({ show, testId = 'unsaved-badge' }: { show: boolean; testId?: string }) {
  if (!show) return null;
  return (
    <span
      // role="status" (implicit aria-live=polite) so the badge appearing — e.g.
      // when a blur-save fails and the edit stays dirty — is announced, not just
      // shown. Dark-amber text (not the ~2:1 bright warning) keeps it readable.
      role="status"
      className="inline-flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-warning-foreground"
      data-testid={testId}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-warning" aria-hidden="true" />
      Unsaved
    </span>
  );
}

/**
 * The recurring-billing explanation shown beneath quote totals. Single source so
 * the editor and the detail view can't drift (the customer-facing QuoteDocument
 * keeps its own shorter copy intentionally).
 */
export function RecurringBillingNote({ className, testId }: { className?: string; testId?: string }) {
  return (
    <p className={`text-xs leading-relaxed text-muted-foreground ${className ?? ''}`} data-testid={testId}>
      Accepting this quote invoices only the one-time charges now. Recurring lines (monthly + annual) bill later on
      their own schedule. The first-period total combines the one-time charges with the first period of each
      recurring cadence.
    </p>
  );
}

/**
 * Internal cost / profit summary for a quote. Single source so the editor rail
 * and the internal detail view show the same figures with the same labels — and
 * so the "missing cost" warning stays readable (dark amber text + icon) instead
 * of the low-contrast bright-amber it used to be. NEVER rendered on the customer
 * document. Callers gate visibility on the cost-read permission.
 */
export function MarginPanel({ profit, currency }: { profit: QuoteProfit; currency: string }) {
  return (
    <div className="mt-3 rounded-md bg-muted/40 p-2 text-sm" data-testid="quote-margin">
      <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-[hsl(220_12%_40%)] dark:text-muted-foreground">
        Margin (internal)
      </div>
      <dl className="space-y-1 tabular-nums">
        <div className="flex justify-between"><dt className="text-muted-foreground">Cost</dt><dd data-testid="quote-margin-cost">{formatMoney(profit.totalCost, currency)}</dd></div>
        <div className="flex justify-between"><dt className="text-muted-foreground">Profit (one-time)</dt><dd data-testid="quote-margin-net-onetime">{formatMoney(profit.oneTimeNet, currency)}</dd></div>
        {Number(profit.monthlyRecurringNet) !== 0 && <div className="flex justify-between"><dt className="text-muted-foreground">Profit (monthly)</dt><dd data-testid="quote-margin-net-monthly">{formatMoney(profit.monthlyRecurringNet, currency)}<span className="text-xs text-muted-foreground">/mo</span></dd></div>}
        {Number(profit.annualRecurringNet) !== 0 && <div className="flex justify-between"><dt className="text-muted-foreground">Profit (annual)</dt><dd data-testid="quote-margin-net-annual">{formatMoney(profit.annualRecurringNet, currency)}<span className="text-xs text-muted-foreground">/yr</span></dd></div>}
      </dl>
      {profit.linesMissingCost > 0 && (
        <p className="mt-1 flex items-start gap-1 text-xs text-warning-foreground" data-testid="quote-margin-missing-cost">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" aria-hidden="true" />
          <span>
            Profit estimate is incomplete — {profit.linesMissingCost} line{profit.linesMissingCost === 1 ? '' : 's'} missing a cost.
          </span>
        </p>
      )}
    </div>
  );
}
