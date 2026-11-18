import { usePermissions } from '../../lib/permissions';
import type { BillingOutcomeStamp } from '../time/BillingOutcome';
import { useCallback, useEffect, useRef, useState } from 'react';
import '@/lib/i18n';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../stores/auth';
import { handleActionError, ActionError } from '../../lib/runAction';
import { approvalFriendly } from '../../lib/ticketApproval';
import { AwaitingApprovalChip, WriteOffHeldButton, isAwaitingApproval } from '../time/HeldEntryControls';
import { startTimerAction, onTimerChanged, onBillingChanged, deleteTimeEntryAction } from '../../lib/timerActions';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import WorkTypeSelect from '../shared/WorkTypeSelect';
import { formatMinutes } from '../../lib/timeFormat';
import { sourceBadgeLabelKey } from '../time/timeEntrySource';
import { formatMoney } from '../billing/shared/format';
import { ApproximateMoneyLine } from '../billing/shared/ApproximateMoneyLine';
import TicketQuickTimeEntry from './TicketQuickTimeEntry';
import { Trash2 } from 'lucide-react';
import { billedLaborMinutes, laborHours } from '@breeze/shared';
import { laborBreakdown } from '../time/laborBreakdown';

/** Mirrors the API's `CurrencyAmount` — money is reported per currency, never summed across. */
interface CurrencyAmount {
  currencyCode: string;
  amount: string;
}

interface BillingSummary {
  time: {
    totalMinutes: number;
    billableMinutes: number;
    /** #4628 §3.5 contract-covered time; absent on an API predating W03. */
    includedMinutes?: number;
    billableAmounts: CurrencyAmount[];
    /** #6466: count of billable entries with no hourly rate — those minutes are
     *  counted in `billableMinutes` (the minimum/rounding SQL doesn't filter on
     *  rate) but excluded from `billableAmounts`. Absent on an older API. */
    missingRateCount?: number;
  };
  parts: { partsCount: number; billableTotals: CurrencyAmount[] };
  defaults?: (BillingOutcomeStamp & { workTypeId?: string | null }) | null;
}

interface EntryRow {
  id: string;
  durationMinutes: number | null;
  /** #4628 §3.5 billed quantity after the card's minimum/rounding. Absent or
   *  null on a pre-feature row — then the duration is what bills. */
  billableMinutes?: number | null;
  description: string | null;
  isBillable: boolean;
  userName: string | null;
  endedAt: string | null;
  /** W06 (#3900) server-stamped provenance; absent on an older API. */
  source?: string | null;
  /** #8133: an invoiced entry is not offered for deletion (the API refuses it). */
  billingStatus?: 'not_billed' | 'billed' | 'no_charge' | 'contract' | 'awaiting_approval';
  /** Snapshot rate + its currency; null while unrated. Absent on an older API. */
  hourlyRate?: string | null;
  currencyCode?: string | null;
}

/** #8133: localized copy for the API's refusals of a time-entry DELETE. */
const DELETE_REFUSALS: Record<string, string> = {
  NOT_OWN_ENTRY: 'notOwnEntry',
  APPROVED_IMMUTABLE: 'approvedImmutable',
  ENTRY_BILLED: 'entryBilled',
  ENTRY_DELETE_LOST: 'deleteLost',
  ENTRY_NOT_FOUND: 'notFound',
};

/** #4628 §3.5 — one line naming the worked time whenever a minimum or the
 *  card's rounding moved the billed quantity. Returns null when they agree. */
function billedVsWorked(
  t: (key: string, options?: Record<string, unknown>) => string,
  durationMinutes: number | null,
  billableMinutes: number | null | undefined
): string | null {
  const worked = laborHours(durationMinutes ?? 0);
  const billed = laborHours(billedLaborMinutes({ billableMinutes, durationMinutes }));
  if (worked === billed) return null;
  return t('ticketTimeBilling.billedVsWorked', { worked, billed });
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

export default function TicketTimeBilling({ ticketId, readOnly = false, embedded = false, onTotalMinutesChange }: {
  ticketId: string;
  /** Inside a titled Details section: no own rule or heading. */
  embedded?: boolean;
  /** Reports the logged total for the section summary once it loads. */
  onTotalMinutesChange?: (minutes: number) => void;
  /** #10073: the ticket is a merged tombstone. Every time write on it answers
   *  409 TICKET_MERGED, so totals and entries stay visible and nothing that
   *  writes is offered. The host shows the reason. */
  readOnly?: boolean;
}) {
  const { t } = useTranslation('tickets');
  const { can } = usePermissions();
  const canManageBilling = can('time_entries', 'manage_billing');
  // #8133: Delete is offered to anyone who can write time entries; the server
  // decides per entry (own + unapproved, or a manage-all admin) and its
  // refusal message is shown.
  const canWriteTime = can('time_entries', 'write');
  const [pendingDelete, setPendingDelete] = useState<EntryRow | null>(null);
  // #8133: the entry whose DELETE is in flight. Tracked by id so a request
  // that settles after the view changed only clears its own state, never a
  // confirm the user has since opened for another entry.
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const deletingShown = deletingId !== null && deletingId === pendingDelete?.id;
  // #8133: the workbench swaps ticketId without remounting; an open confirm
  // must not survive that, or confirming would delete an entry from the
  // ticket the user just left.
  useEffect(() => { setPendingDelete(null); }, [ticketId]);
  const [summary, setSummary] = useState<BillingSummary | null>(null);
  const onTotalRef = useRef(onTotalMinutesChange);
  onTotalRef.current = onTotalMinutesChange;
  const totalMinutes = summary?.time.totalMinutes;
  useEffect(() => {
    if (typeof totalMinutes === 'number') onTotalRef.current?.(totalMinutes);
  }, [totalMinutes]);
  const [entries, setEntries] = useState<EntryRow[]>([]);
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const [timerWorkTypeId, setTimerWorkTypeId] = useState<string | null | undefined>(undefined);
  const [startingTimer, setStartingTimer] = useState(false);
  // Hard-mode approval gate (#8196): the start was refused with APPROVAL_REQUIRED.
  const [approvalBlocked, setApprovalBlocked] = useState(false);

  // Assigned during render so it is already current when the ticketId prop
  // changes — a state update would land a tick too late for an in-flight fetch.
  const latestTicketId = useRef(ticketId);
  latestTicketId.current = ticketId;

  const refresh = useCallback(async () => {
    const requested = ticketId;
    const [sumRes, listRes] = await Promise.all([
      fetchWithAuth(`/tickets/${ticketId}/billing-summary`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
      fetchWithAuth(`/tickets/${ticketId}/time-entries?limit=5`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
    ]);
    // The workbench swaps this component's ticketId prop without remounting, so
    // a response for the PREVIOUSLY selected ticket can land after the switch.
    // Applying it would prefill the rate box with another org's number under
    // another org's currency (#5321 review) — drop it instead.
    if (requested !== latestTicketId.current) return;
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
    setApprovalBlocked(false);
    setQuickAddOpen(false);
    setTimerWorkTypeId(undefined);
  }, [ticketId]);

  const startTimer = (opts: { nonBillable?: boolean } = {}) => {
    // Guard against double-fire: a start request takes a beat server-side, and
    // overlapping starts race the one-running-timer unique index. Disabling the
    // button in flight keeps the happy path single-shot.
    if (startingTimer || readOnly) return;
    setStartingTimer(true);
    setApprovalBlocked(false);
    void startTimerAction(
      {
        ticketId,
        ...(timerWorkTypeId !== undefined ? { workTypeId: timerWorkTypeId } : {}),
        ...(opts.nonBillable ? { isBillable: false } : {}),
      },
      approvalFriendly(t),
    )
      .catch((err) => {
        if (err instanceof ActionError && err.code === 'APPROVAL_REQUIRED') setApprovalBlocked(true);
        handleActionError(err, t('ticketTimeBilling.toast.startTimerFailed'));
      })
      .finally(() => setStartingTimer(false));
  };

  // #8133: delete one entry after the confirm dialog. deleteTimeEntryAction
  // broadcasts the timer and billing events, which refresh this panel, the
  // workbench feed and the header timer.
  const confirmDelete = async () => {
    const entry = pendingDelete;
    if (!entry || readOnly) return;
    setDeletingId(entry.id);
    try {
      await deleteTimeEntryAction(entry, {
        errorFallback: t('ticketTimeBilling.toast.deleteFailed'),
        successMessage: t('ticketTimeBilling.toast.deleted'),
      }, (code) => {
        const key = DELETE_REFUSALS[code];
        return key ? t(/* i18n-dynamic */ `ticketTimeBilling.deleteRefusal.${key}`) : undefined;
      });
    } catch (err) {
      handleActionError(err, t('ticketTimeBilling.toast.deleteFailed'));
      // A refusal may mean it was approved or invoiced since the list loaded.
      void refresh();
    } finally {
      setDeletingId((cur) => (cur === entry.id ? null : cur));
      setPendingDelete((cur) => (cur?.id === entry.id ? null : cur));
    }
  };

  return (
    <div className={embedded ? undefined : 'mt-3 border-t pt-3'} data-testid="ticket-time-billing">
      {!embedded && <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('ticketTimeBilling.title')}</p>}

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
          {(summary.time.includedMinutes ?? 0) > 0 && (
            <div className="flex justify-end text-xs text-muted-foreground" data-testid="ticket-billing-included">
              {t('ticketTimeBilling.includedMinutes', { hours: laborHours(summary.time.includedMinutes ?? 0) })}
            </div>
          )}
          <div className="flex justify-between text-xs">
            <dt className="text-muted-foreground">{t('ticketTimeBilling.timeAmount')}</dt>
            <dd data-testid="ticket-billing-amount">
              <CurrencyAmounts amounts={summary.time.billableAmounts ?? []} testIdPrefix="ticket-billing-amount" empty={t('ticketTimeBilling.noAmount')} />
            </dd>
          </div>
          {/* #6466/BQ-4: billableMinutes above already includes rate-less
              entries (the minimum/rounding SQL doesn't filter on rate), so
              the amount row above this note can be blank for a nonzero
              billable-hours figure. Rendered BELOW the amount row it refers
              to ("not counted in the amount above") — must stay below it. */}
          {(summary.time.missingRateCount ?? 0) > 0 && (
            <div className="flex justify-end text-xs text-muted-foreground" data-testid="ticket-billing-missing-rate">
              {t('ticketTimeBilling.missingRateCount', { count: summary.time.missingRateCount })}
            </div>
          )}
          {/* #9561: the amount above is a sum of per-entry figures, each billed
              at its minutes rounded to 2-decimal hours × rate (by design). */}
          {(summary.time.billableAmounts?.length ?? 0) > 0 && (
            <div className="flex justify-end text-right text-[11px] text-muted-foreground" data-testid="ticket-billing-labor-rule">
              {t('ticketTimeBilling.laborRule')}
            </div>
          )}
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

      <label className="mt-2 block text-[11px] text-muted-foreground">
        {t('workType.label')}
        <WorkTypeSelect value={timerWorkTypeId === undefined ? summary?.defaults?.workTypeId ?? null : timerWorkTypeId} onChange={setTimerWorkTypeId} testId="timer-work-type" disabled={startingTimer || readOnly} />
      </label>
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          onClick={() => startTimer()}
          disabled={startingTimer || readOnly}
          className="rounded-md border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
          data-testid="ticket-billing-start-timer"
        >
          {startingTimer ? t('ticketTimeBilling.starting') : t('ticketTimeBilling.startTimer')}
        </button>
        <button
          type="button"
          onClick={() => setQuickAddOpen((o) => !o)}
          disabled={readOnly}
          className="rounded-md border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
          data-testid="ticket-billing-quick-add-toggle"
        >
          {t('ticketTimeBilling.logTime')}
        </button>
      </div>

      {approvalBlocked && !readOnly && (
        <div className="mt-2 rounded-md border border-warning/40 bg-warning/10 p-2 text-xs text-foreground" role="alert" data-testid="ticket-billing-approval-required">
          <p>{t('ticketApproval.errors.approvalRequired')}</p>
          {/* Only billing managers may start non-billable (the server enforces it),
              so a tech without the grant gets guidance, not a button that would 403. */}
          {canManageBilling && (
            <button
              type="button"
              onClick={() => startTimer({ nonBillable: true })}
              disabled={startingTimer}
              className="mt-1.5 rounded-md border border-warning/50 px-2 py-1 text-xs hover:bg-warning/20 disabled:opacity-50"
              data-testid="ticket-billing-start-non-billable"
            >
              {t('ticketApproval.timer.startNonBillable')}
            </button>
          )}
        </div>
      )}

      {quickAddOpen && !readOnly && (
        <div className="mt-2 rounded-md border bg-muted/30 p-2">
          <TicketQuickTimeEntry
            key={ticketId}
            ticketId={ticketId}
            defaults={summary?.defaults ?? null}
            onLogged={async () => { setQuickAddOpen(false); await refresh(); }}
          />
        </div>
      )}

      {entries.length > 0 && (
        <ul className="mt-2 space-y-1" data-testid="ticket-billing-entries">
          {entries.map((entry) => (
            <li key={entry.id} className="flex items-start justify-between gap-1 text-xs">
              <span className="min-w-0 truncate text-muted-foreground">
                {entry.userName ?? t('ticketTimeBilling.techFallback')}
                {entry.description ? ` — ${entry.description}` : ''}
                {isAwaitingApproval(entry) && <AwaitingApprovalChip entryId={entry.id} className="ml-1" />}
                {sourceBadgeLabelKey(entry.source) && (
                  <span
                    data-testid={`time-entry-source-${entry.id}`}
                    className="ml-1 rounded-full bg-muted px-1.5 py-0.5 text-xs"
                  >
                    {t(/* i18n-dynamic */ `common:${sourceBadgeLabelKey(entry.source)!}`)}
                  </span>
                )}
              </span>
              <span className="shrink-0 text-right">
                {entry.endedAt == null ? t('ticketTimeBilling.running') : formatMinutes(entry.durationMinutes)}
                {entry.endedAt != null && billedVsWorked(t, entry.durationMinutes, entry.billableMinutes) && (
                  <span className="block text-xs text-muted-foreground" data-testid={`time-entry-billed-vs-worked-${entry.id}`}>
                    {billedVsWorked(t, entry.durationMinutes, entry.billableMinutes)}
                  </span>
                )}
                {laborBreakdown(t, entry) && (
                  <span className="block text-xs tabular-nums text-muted-foreground" data-testid={`ticket-billing-entry-labor-${entry.id}`}>
                    {laborBreakdown(t, entry)}
                  </span>
                )}
              </span>
              {isAwaitingApproval(entry) && !readOnly && <WriteOffHeldButton entryId={entry.id} className="shrink-0 !px-1.5 !py-0.5 !text-[11px]" />}
              {canWriteTime && !readOnly && entry.billingStatus !== 'billed' && (
                <button
                  type="button"
                  onClick={() => setPendingDelete(entry)}
                  data-testid={`ticket-billing-delete-${entry.id}`}
                  aria-label={entry.description
                    ? t('ticketTimeBilling.deleteEntryWithDescription', {
                        duration: entry.endedAt == null ? t('ticketTimeBilling.running') : formatMinutes(entry.durationMinutes),
                        tech: entry.userName ?? t('ticketTimeBilling.techFallback'),
                        description: entry.description,
                      })
                    : t('ticketTimeBilling.deleteEntry', {
                        duration: entry.endedAt == null ? t('ticketTimeBilling.running') : formatMinutes(entry.durationMinutes),
                        tech: entry.userName ?? t('ticketTimeBilling.techFallback'),
                      })}
                  title={t('common:actions.delete')}
                  className="shrink-0 rounded px-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                >
                  <Trash2 className="h-3 w-3" aria-hidden="true" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* #10073: a confirm left open when the ticket turns read-only (merged
          meanwhile) stops rendering; the delete would only 409. */}
      <ConfirmDialog
        open={pendingDelete !== null && !readOnly}
        onClose={() => { if (!deletingShown) setPendingDelete(null); }}
        onConfirm={() => void confirmDelete()}
        title={t('ticketTimeBilling.deleteConfirmTitle')}
        message={pendingDelete
          ? t('ticketTimeBilling.deleteConfirmMessage', {
              duration: pendingDelete.endedAt == null
                ? t('ticketTimeBilling.running')
                : formatMinutes(pendingDelete.durationMinutes),
              tech: pendingDelete.userName ?? t('ticketTimeBilling.techFallback'),
            })
          : ''}
        confirmLabel={t('common:actions.delete')}
        variant="destructive"
        isLoading={deletingShown}
        confirmTestId="ticket-billing-delete-confirm"
        dialogTestId="ticket-billing-delete-dialog"
      />
    </div>
  );
}
