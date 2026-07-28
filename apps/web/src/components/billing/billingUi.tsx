// Shared presentational helpers for the quote + invoice billing UI, so copy and
// affordances can't drift between the editor and detail/document surfaces.

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Eye, EyeOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import '../../lib/i18n';
import { marginPct, type QuoteProfit } from '@breeze/shared';
import { formatMoney } from './quotes/quoteTypes';

/**
 * The ONE persisted "internal costs on screen?" preference for the whole billing
 * area. Its contract is "no margin on screen": when a screen-sharing tech hides
 * cost & margin it must STAY hidden across tabs and across quote/invoice
 * surfaces — a per-surface preference would leak margin the moment they open the
 * other document type. (The key name predates the invoice adoption; it's kept so
 * existing saved preferences survive.)
 */
export const SHOW_INTERNAL_MARGIN_KEY = 'breeze:quote-editor-show-margin';

// Same-page sync channel between hook instances: the `storage` event only fires
// in OTHER browser tabs, so without this a workspace-header toggle and a Detail
// pill on the same page would drift apart — "hide cost & margin" that leaves a
// second copy of the margin on screen is a broken promise.
const SHOW_MARGIN_EVENT = 'breeze:show-margin-change';

// In-memory fallback for restricted-storage contexts (private mode, blocked
// third-party storage): when localStorage is unusable the preference still has
// to stay coherent across every mounted instance for the life of the page —
// "hide cost & margin" that leaves a second copy of the margin on screen is
// the exact broken promise this hook exists to prevent. Session-only by nature.
let memoryShowMargin: boolean | null = null;

/** Test-only: the memory mirror outlives `localStorage.clear()` (that's its
 *  job), so suites that toggle the preference reset it between tests — same
 *  pattern as Toast's `_resetToastQueueForTests`. */
export function _resetShowMarginMemoryForTests() {
  memoryShowMargin = null;
}

function readShowMargin(): boolean {
  try {
    // Healthy storage is the single source of truth — including "key absent"
    // meaning the default (off). The memory mirror takes over only when
    // storage ACCESS throws (private mode / blocked storage); preferring it on
    // a merely-absent key would let a stale mirror override a cleared pref.
    if (typeof localStorage !== 'undefined') return localStorage.getItem(SHOW_INTERNAL_MARGIN_KEY) === '1';
  } catch { /* storage unusable — fall through to the memory mirror */ }
  return memoryShowMargin ?? false;
}

/** Read + flip the persisted cost/margin visibility preference. Every mounted
 *  instance stays in sync: same-page via SHOW_MARGIN_EVENT, cross-tab via the
 *  browser's `storage` event. */
export function useShowMargin(): [boolean, () => void] {
  const [showMargin, setShowMargin] = useState(readShowMargin);
  useEffect(() => {
    const sync = () => setShowMargin(readShowMargin());
    window.addEventListener('storage', sync);
    window.addEventListener(SHOW_MARGIN_EVENT, sync);
    return () => {
      window.removeEventListener('storage', sync);
      window.removeEventListener(SHOW_MARGIN_EVENT, sync);
    };
  }, []);
  const toggleMargin = useCallback(() => {
    setShowMargin((v) => {
      const next = !v;
      // The memory mirror is written unconditionally and the sibling-sync event
      // ALWAYS dispatches — even when localStorage is unavailable — so every
      // instance on the page agrees regardless of storage health. The dispatch
      // is deferred to a microtask so listeners re-read state after this
      // updater's writes have landed (and a StrictMode double-invoke stays
      // idempotent: same value written, same event fired).
      memoryShowMargin = next;
      try { localStorage.setItem(SHOW_INTERNAL_MARGIN_KEY, next ? '1' : '0'); } catch { /* memory mirror carries it */ }
      queueMicrotask(() => window.dispatchEvent(new Event(SHOW_MARGIN_EVENT)));
      return next;
    });
  }, []);
  return [showMargin, toggleMargin];
}

/**
 * The toggle that flips the preference — one control vocabulary for
 * "show/hide internal costs" across the billing surfaces: the detail rails
 * (`sm`) and the quote workspace's pinned header (`md`). The quote editor's
 * toolbar keeps an uncontrolled fallback copy only for standalone
 * mounts/tests; in the app the workspace header owns the control.
 */
export function MarginToggle({ show, onToggle, testId, size = 'sm' }: { show: boolean; onToggle: () => void; testId: string; size?: 'sm' | 'md' }) {
  const { t } = useTranslation('billing');
  // 'sm' — the quiet inline pill on the detail surfaces (h-7 / 28px: the
  // smallest hit target that clears WCAG 2.5.8's 24px floor with margin — this
  // pill gates the most sensitive data on screen and must not be the hardest
  // thing to hit). 'md' — sized to sit among the workspace header's action
  // buttons. One component so the control reads identically everywhere.
  const look = size === 'md' ? 'gap-1.5 px-3 py-2 text-sm' : 'h-7 gap-1 px-2.5 text-xs';
  const icon = size === 'md' ? 'h-4 w-4' : 'h-3.5 w-3.5';
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={show}
      data-testid={testId}
      className={`inline-flex shrink-0 items-center rounded-md border font-medium transition-colors hover:bg-muted focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring ${look} ${show ? 'border-primary/40 bg-primary/10 text-primary' : 'text-muted-foreground'}`}
    >
      {show ? <EyeOff className={icon} aria-hidden="true" /> : <Eye className={icon} aria-hidden="true" />}
      {show ? t('billingUi.hideCostMargin') : t('billingUi.showCostMargin')}
    </button>
  );
}

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
      className="inline-flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-warning-foreground dark:text-warning"
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
