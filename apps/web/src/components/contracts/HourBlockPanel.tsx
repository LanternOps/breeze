import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import type { HourBlockEstimate } from '@breeze/shared';
import { listContractHourPeriods, type HourPeriodRow } from '../../lib/api/contracts';
import { formatDate, formatMoney } from '../billing/invoiceTypes';

/** 6.5 -> "6.5", 10 -> "10", "12.00" -> "12": hours are 2-dp, never padded. */
const fmtHours = (n: number | string): string => String(Number(Number(n).toFixed(2)));
const PAGE = 12;

interface Props {
  contractId: string;
  currency: string;
  hourBlock: HourBlockEstimate | null;
  estimateFailed: boolean;
  /** Changes whenever the parent reloads the estimate; the history reloads with it. */
  reloadKey: unknown;
}

export default function HourBlockPanel({ contractId, currency, hourBlock: est, estimateFailed, reloadKey }: Props) {
  const { t } = useTranslation('billing');
  const [rows, setRows] = useState<HourPeriodRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [moreFailed, setMoreFailed] = useState(false);
  const mounted = useRef(true);
  /** Bumped per request; a response that is no longer the latest request is dropped. */
  const seq = useRef(0);

  const load = useCallback(async (after?: string) => {
    const mine = ++seq.current;
    const live = () => mounted.current && seq.current === mine;
    // A failed first page replaces the table; a failed "load more" keeps the rows already loaded.
    const fail = () => {
      if (!live()) return;
      if (after) setMoreFailed(true); else { setFailed(true); setMoreFailed(false); }
      setLoaded(true);
    };
    let res: Response;
    try {
      res = await listContractHourPeriods(contractId, { limit: PAGE, cursor: after });
    } catch { fail(); return; }
    if (!res.ok) { fail(); return; }
    const body = (await res.json().catch(() => null)) as { data?: { items?: HourPeriodRow[]; nextCursor?: string | null } } | null;
    // A 200 whose body is unreadable or has no item list is a failure, not an empty history.
    if (!Array.isArray(body?.data?.items)) { fail(); return; }
    if (!live()) return;
    const items = body!.data!.items!;
    setFailed(false);
    setMoreFailed(false);
    setRows((prev) => (after ? [...prev, ...items] : items));
    setCursor(body!.data!.nextCursor ?? null);
    setLoaded(true);
  }, [contractId]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // Initial load (and a change of contract).
  useEffect(() => { void load(); }, [load]);

  // Reload when the parent refreshes the estimate (a billing run may have closed a
  // period) -- but NOT when the first estimate merely arrives: that would fetch the
  // same page twice and, with a cursor already in hand, race the first response.
  const lastKey = useRef(reloadKey);
  useEffect(() => {
    if (lastKey.current === reloadKey) return;
    const firstArrival = lastKey.current == null;
    lastKey.current = reloadKey;
    if (!firstArrival) void load();
  }, [reloadKey, load]);

  const opening = est ? est.includedHours + est.carriedInHours : 0;
  const pct = est && opening > 0 ? Math.min(100, (est.consumedHours / opening) * 100) : 0;
  const alerting = !!est && est.alertPct != null && pct >= est.alertPct;
  const startsLater = !!est && est.periodStart > new Date().toISOString().slice(0, 10);

  return (
    <section className="rounded-lg border bg-card shadow-xs" data-testid="hour-block-panel">
      <h3 className="border-b px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {t('contracts.hourBlock.detail.title')}
      </h3>

      <div className="space-y-2 p-3 text-sm">
        {est && startsLater ? (
          <>
            {/* I9: the block starts at the NEXT period (advance, added mid-period) — say so instead of a 0-used bar. */}
            <p className="font-medium" data-testid="hour-block-starts-later">
              {t('contracts.hourBlock.detail.startsLater', { date: formatDate(est.periodStart) })}
            </p>
            <p className="text-xs text-muted-foreground" data-testid="hour-block-extra-rate">
              {t('contracts.hourBlock.detail.extraRate', { rate: formatMoney(est.overageUnitPrice, currency) })}
            </p>
          </>
        ) : est ? (
          <>
            <p className="font-medium tabular-nums" data-testid="hour-block-usage">
              {t('contracts.hourBlock.detail.usage', {
                used: fmtHours(est.consumedHours), included: fmtHours(opening),
                remaining: fmtHours(est.remainingHours), end: formatDate(est.periodEnd),
              })}
            </p>
            <div
              role="progressbar" aria-valuemin={0} aria-valuemax={opening} aria-valuenow={est.consumedHours}
              aria-label={t('contracts.hourBlock.detail.title')} data-testid="hour-block-bar"
              className="h-2 w-full overflow-hidden rounded-full bg-muted"
            >
              <div
                className={est.overageHours > 0 ? 'h-full bg-destructive' : alerting ? 'h-full bg-amber-500' : 'h-full bg-primary'}
                style={{ width: `${pct}%` }}
              />
            </div>
            {est.carriedInHours > 0 && (
              <p className="text-xs text-muted-foreground" data-testid="hour-block-carried">
                {t('contracts.hourBlock.detail.carried', { hours: fmtHours(est.carriedInHours) })}
              </p>
            )}
            {est.unapprovedHours > 0 && (
              <p className="text-xs text-amber-600 dark:text-amber-500" data-testid="hour-block-unapproved">
                {t('contracts.hourBlock.detail.unapproved', { hours: fmtHours(est.unapprovedHours) })}
              </p>
            )}
            {est.foreignCurrencyHours > 0 && (
              <p className="text-xs text-amber-600 dark:text-amber-500" data-testid="hour-block-foreign">
                {t('contracts.hourBlock.detail.foreign', { hours: fmtHours(est.foreignCurrencyHours) })}
              </p>
            )}
            {est.overageHours > 0 && (
              <div data-testid="hour-block-over">
                <p className="font-medium text-destructive">
                  {t('contracts.hourBlock.detail.over', { hours: fmtHours(est.overageHours), amount: formatMoney(est.overageValue, currency) })}
                </p>
                <p className="text-xs text-muted-foreground" data-testid="hour-block-timing-note">
                  {est.billingTiming === 'advance' ? t('contracts.hourBlock.detail.advanceNote') : t('contracts.hourBlock.detail.arrearsNote')}
                </p>
              </div>
            )}
            {est.lateEntryHours > 0 && (
              <p className="text-xs text-muted-foreground" data-testid="hour-block-late">
                {t('contracts.hourBlock.detail.lateEntry', { hours: fmtHours(est.lateEntryHours) })}
              </p>
            )}
            <p className="text-xs text-muted-foreground" data-testid="hour-block-extra-rate">
              {t('contracts.hourBlock.detail.extraRate', { rate: formatMoney(est.overageUnitPrice, currency) })}
            </p>
          </>
        ) : estimateFailed ? (
          <p className="text-xs text-amber-600 dark:text-amber-500" data-testid="hour-block-load-failed">
            {t('contracts.hourBlock.detail.loadFailed')}
          </p>
        ) : null}
      </div>

      <h4 className="border-y px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {t('contracts.hourBlock.history.title')}
      </h4>
      {failed ? (
        <p className="px-3 py-4 text-xs text-amber-600 dark:text-amber-500" data-testid="hour-block-history-error">
          {t('contracts.hourBlock.detail.loadFailed')}
        </p>
      ) : loaded && rows.length === 0 ? (
        <p className="px-3 py-4 text-sm text-muted-foreground" data-testid="hour-block-history-empty">
          {t('contracts.hourBlock.history.empty')}
        </p>
      ) : (
        <>
        <table className="w-full text-sm" data-testid="hour-block-history">
          <thead>
            <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-3 py-2 font-medium">{t('contracts.contractDetail.billingHistory.period')}</th>
              <th className="px-3 py-2 text-right font-medium">{t('contracts.hourBlock.history.included')}</th>
              <th className="px-3 py-2 text-right font-medium">{t('contracts.hourBlock.history.carriedIn')}</th>
              <th className="px-3 py-2 text-right font-medium">{t('contracts.hourBlock.history.used')}</th>
              <th className="px-3 py-2 text-right font-medium">{t('contracts.hourBlock.history.over')}</th>
              <th className="px-3 py-2 text-right font-medium">{t('contracts.hourBlock.history.carriedOut')}</th>
              <th className="px-3 py-2 font-medium">{t('contracts.contractDetail.billingHistory.invoice')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t" data-testid={`hour-block-history-row-${r.id}`}>
                <td className="px-3 py-2">{formatDate(r.periodStart)} – {formatDate(r.periodEnd)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{fmtHours(r.includedHours)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{fmtHours(r.carriedInHours)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{fmtHours(r.consumedHours)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{fmtHours(r.overageHours)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{fmtHours(r.carriedOutHours)}</td>
                <td className="px-3 py-2">
                  {r.overageInvoiceId
                    ? <a href={`/billing/invoices/${r.overageInvoiceId}`} className="text-primary hover:underline">{t('contracts.contractDetail.billingHistory.viewInvoice')}</a>
                    : Number(r.overageHours) > 0
                      // I7: the ledger says hours were over, but the draft invoice that carried them is gone
                      // (the FK is ON DELETE SET NULL) — nothing billed them. Say so; never a quiet dash.
                      ? <span className="text-xs text-amber-600 dark:text-amber-500" data-testid={`hour-block-history-removed-${r.id}`}>{t('contracts.hourBlock.history.invoiceRemoved')}</span>
                      : <span className="text-muted-foreground">—</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {moreFailed && (
          <p className="border-t px-3 py-2 text-xs text-amber-600 dark:text-amber-500" data-testid="hour-block-history-error">
            {t('contracts.hourBlock.detail.loadFailed')}
          </p>
        )}
        </>
      )}
      {cursor && !failed && (
        <div className="border-t px-3 py-2">
          <button
            type="button" onClick={() => void load(cursor)} data-testid="hour-block-history-more"
            className="rounded-md border px-3 py-1 text-xs font-medium hover:bg-muted"
          >
            {t('contracts.hourBlock.history.loadMore')}
          </button>
        </div>
      )}
    </section>
  );
}
