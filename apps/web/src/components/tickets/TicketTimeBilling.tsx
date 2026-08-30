import { useCallback, useEffect, useState } from 'react';
import '@/lib/i18n';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, handleActionError } from '../../lib/runAction';
import { startTimerAction, onTimerChanged, onBillingChanged, broadcastBillingChanged } from '../../lib/timerActions';
import { formatMinutes } from '../../lib/timeFormat';
import { sourceBadgeLabelKey } from '../time/timeEntrySource';
import { formatMoney } from '../billing/shared/format';
import { ApproximateMoneyLine } from '../billing/shared/ApproximateMoneyLine';

/** Mirrors the API's `CurrencyAmount` — money is reported per currency, never summed across. */
interface CurrencyAmount {
  currencyCode: string;
  amount: string;
}

interface BillingSummary {
  time: { totalMinutes: number; billableMinutes: number; billableAmounts: CurrencyAmount[] };
  parts: { partsCount: number; billableTotals: CurrencyAmount[] };
}

interface EntryRow {
  id: string;
  durationMinutes: number | null;
  description: string | null;
  isBillable: boolean;
  userName: string | null;
  endedAt: string | null;
  /** W06 (#3900) server-stamped provenance; absent on an older API. */
  source?: string | null;
}

/** One chip per currency; an empty list renders a dash rather than a zero in
 *  some assumed currency (spec §2: never label an amount with a currency it
 *  was not stamped in). */
function CurrencyAmounts({ amounts, testIdPrefix, empty }: { amounts: CurrencyAmount[]; testIdPrefix: string; empty: string }) {
  if (amounts.length === 0) return <>{empty}</>;
  return (
    <span className="flex flex-wrap justify-end gap-x-2">
      {amounts.map((a) => (
        <span key={a.currencyCode} data-testid={`${testIdPrefix}-${a.currencyCode}`}>
          {formatMoney(a.amount, a.currencyCode)}
        </span>
      ))}
    </span>
  );
}

/** `CurrencyAmount` (API shape) → the `{ code, amount }` shape every reporting
 *  helper consumes. Mapped explicitly rather than widening either type. */
function toReportingGroups(amounts: CurrencyAmount[]): { code: string; amount: string }[] {
  return amounts.map((a) => ({ code: a.currencyCode, amount: a.amount }));
}

export default function TicketTimeBilling({ ticketId }: { ticketId: string }) {
  const { t } = useTranslation('tickets');
  const [summary, setSummary] = useState<BillingSummary | null>(null);
  const [entries, setEntries] = useState<EntryRow[]>([]);
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const [minutes, setMinutes] = useState('');
  const [description, setDescription] = useState('');
  const [billable, setBillable] = useState(true);
  const [busy, setBusy] = useState(false);
  const [startingTimer, setStartingTimer] = useState(false);

  const refresh = useCallback(async () => {
    const [sumRes, listRes] = await Promise.all([
      fetchWithAuth(`/tickets/${ticketId}/billing-summary`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
      fetchWithAuth(`/tickets/${ticketId}/time-entries?limit=5`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
    ]);
    if (sumRes?.data) setSummary(sumRes.data as BillingSummary);
    if (listRes?.data) setEntries(listRes.data as EntryRow[]);
  }, [ticketId]);

  useEffect(() => {
    void refresh();
    const unsubTimer = onTimerChanged(() => void refresh());
    const unsubBilling = onBillingChanged(() => void refresh());
    return () => { unsubTimer(); unsubBilling(); };
  }, [refresh]);

  useEffect(() => {
    setQuickAddOpen(false);
    setMinutes('');
    setDescription('');
    setBillable(true);
  }, [ticketId]);

  const startTimer = () => {
    // Guard against double-fire: a start request takes a beat server-side, and
    // overlapping starts race the one-running-timer unique index. Disabling the
    // button in flight keeps the happy path single-shot.
    if (startingTimer) return;
    setStartingTimer(true);
    void startTimerAction({ ticketId })
      .catch((err) => handleActionError(err, t('ticketTimeBilling.toast.startTimerFailed')))
      .finally(() => setStartingTimer(false));
  };

  const submitQuickAdd = async () => {
    const mins = Math.round(Number(minutes));
    if (!Number.isFinite(mins) || mins <= 0) return;
    setBusy(true);
    try {
      const end = new Date();
      const start = new Date(end.getTime() - mins * 60_000);
      await runAction({
        request: () =>
          fetchWithAuth('/time-entries', {
            method: 'POST',
            body: JSON.stringify({
              ticketId,
              startedAt: start.toISOString(),
              endedAt: end.toISOString(),
              description: description || undefined,
              isBillable: billable,
            }),
          }),
        errorFallback: t('ticketTimeBilling.toast.logFailed'),
        successMessage: t('ticketTimeBilling.toast.logged'),
      });
      setQuickAddOpen(false);
      setMinutes('');
      setDescription('');
      await refresh();
      // Notify the workbench feed (and other billing listeners) so the new
      // time-entry line appears without a manual reload — mirrors the timer
      // start/stop and parts-mutation paths.
      broadcastBillingChanged();
    } catch (err) {
      handleActionError(err, t('ticketTimeBilling.toast.logFailedSentence'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3 border-t pt-3" data-testid="ticket-time-billing">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('ticketTimeBilling.title')}</p>

      {summary && (
        <dl className="mt-2 space-y-1">
          <div className="flex justify-between text-xs">
            <dt className="text-muted-foreground">{t('ticketTimeBilling.totalTime')}</dt>
            <dd data-testid="ticket-billing-time-total">{formatMinutes(summary.time.totalMinutes)}</dd>
          </div>
          <div className="flex justify-between text-xs">
            <dt className="text-muted-foreground">{t('ticketTimeBilling.billable')}</dt>
            <dd data-testid="ticket-billing-time-billable">{formatMinutes(summary.time.billableMinutes)}</dd>
          </div>
          <div className="flex justify-between text-xs">
            <dt className="text-muted-foreground">{t('ticketTimeBilling.timeAmount')}</dt>
            <dd data-testid="ticket-billing-amount">
              <CurrencyAmounts amounts={summary.time.billableAmounts ?? []} testIdPrefix="ticket-billing-amount" empty={t('ticketTimeBilling.noAmount')} />
            </dd>
          </div>
          <div className="flex justify-end">
            <ApproximateMoneyLine byCurrency={toReportingGroups(summary.time.billableAmounts ?? [])} testId="ticket-labor-approx" />
          </div>
          <div className="flex justify-between text-xs">
            <dt className="text-muted-foreground">{t('ticketTimeBilling.partsCount', { count: summary.parts.partsCount })}</dt>
            <dd data-testid="ticket-billing-parts-total">
              <CurrencyAmounts amounts={summary.parts.billableTotals ?? []} testIdPrefix="ticket-billing-parts-total" empty={t('ticketTimeBilling.noAmount')} />
            </dd>
          </div>
          <div className="flex justify-end">
            <ApproximateMoneyLine byCurrency={toReportingGroups(summary.parts.billableTotals ?? [])} testId="ticket-parts-approx" />
          </div>
        </dl>
      )}

      <div className="mt-2 flex gap-2">
        <button
          type="button"
          onClick={startTimer}
          disabled={startingTimer}
          className="rounded-md border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
          data-testid="ticket-billing-start-timer"
        >
          {startingTimer ? t('ticketTimeBilling.starting') : t('ticketTimeBilling.startTimer')}
        </button>
        <button
          type="button"
          onClick={() => setQuickAddOpen((o) => !o)}
          className="rounded-md border px-2 py-1 text-xs hover:bg-muted"
          data-testid="ticket-billing-quick-add-toggle"
        >
          {t('ticketTimeBilling.logTime')}
        </button>
      </div>

      {quickAddOpen && (
        <div className="mt-2 space-y-1.5 rounded-md border bg-muted/30 p-2" data-testid="ticket-billing-quick-add">
          <input
            type="number"
            min={1}
            step={1}
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
            placeholder={t('ticketTimeBilling.minutes')}
            aria-label={t('ticketTimeBilling.minutes')}
            className="w-full rounded-md border bg-background px-2 py-1 text-xs"
            data-testid="ticket-billing-quick-add-minutes"
          />
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t('ticketTimeBilling.descriptionPlaceholder')}
            aria-label={t('common:labels.description')}
            className="w-full rounded-md border bg-background px-2 py-1 text-xs"
            data-testid="ticket-billing-quick-add-description"
          />
          <label className="flex items-center gap-1.5 text-xs">
            <input
              type="checkbox"
              checked={billable}
              onChange={(e) => setBillable(e.target.checked)}
              data-testid="ticket-billing-quick-add-billable"
            />
            {t('ticketTimeBilling.billable')}
          </label>
          <button
            type="button"
            onClick={() => void submitQuickAdd()}
            disabled={busy}
            className="w-full rounded-md bg-primary px-2 py-1 text-xs font-medium text-white disabled:opacity-50"
            data-testid="ticket-billing-quick-add-submit"
          >
            {busy ? t('common:states.saving') : t('common:actions.save')}
          </button>
        </div>
      )}

      {entries.length > 0 && (
        <ul className="mt-2 space-y-1" data-testid="ticket-billing-entries">
          {entries.map((entry) => (
            <li key={entry.id} className="flex items-start justify-between gap-1 text-xs">
              <span className="min-w-0 truncate text-muted-foreground">
                {entry.userName ?? t('ticketTimeBilling.techFallback')}
                {entry.description ? ` — ${entry.description}` : ''}
                {sourceBadgeLabelKey(entry.source) && (
                  <span
                    data-testid={`time-entry-source-${entry.id}`}
                    className="ml-1 rounded-full bg-muted px-1.5 py-0.5 text-[10px]"
                  >
                    {t(/* i18n-dynamic */ `common:${sourceBadgeLabelKey(entry.source)!}`)}
                  </span>
                )}
              </span>
              <span className="shrink-0">
                {entry.endedAt == null ? t('ticketTimeBilling.running') : formatMinutes(entry.durationMinutes)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
