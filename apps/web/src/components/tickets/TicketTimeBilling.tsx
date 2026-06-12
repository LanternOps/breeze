import { useCallback, useEffect, useState } from 'react';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, ActionError } from '../../lib/runAction';
import { showToast } from '../shared/Toast';
import { startTimerAction, onTimerChanged } from '../../lib/timerActions';
import { formatMinutes, formatMoney } from '../../lib/timeFormat';

interface BillingSummary {
  time: { totalMinutes: number; billableMinutes: number; billableAmount: string };
  parts: { partsCount: number; billableTotal: string };
}

interface EntryRow {
  id: string;
  durationMinutes: number | null;
  description: string | null;
  isBillable: boolean;
  userName: string | null;
  startedAt: string;
  endedAt: string | null;
  isApproved: boolean;
}

export default function TicketTimeBilling({ ticketId }: { ticketId: string }) {
  const [summary, setSummary] = useState<BillingSummary | null>(null);
  const [entries, setEntries] = useState<EntryRow[]>([]);
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const [minutes, setMinutes] = useState('');
  const [description, setDescription] = useState('');
  const [billable, setBillable] = useState(true);
  const [busy, setBusy] = useState(false);

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
    return onTimerChanged(() => void refresh());
  }, [refresh]);

  useEffect(() => {
    setQuickAddOpen(false);
    setMinutes('');
    setDescription('');
  }, [ticketId]);

  const handleActionError = (err: unknown, fallback: string) => {
    if (err instanceof ActionError && err.status === 401) return;
    if (!(err instanceof ActionError)) showToast({ type: 'error', message: fallback });
  };

  const startTimer = () => {
    void startTimerAction({ ticketId })
      .catch((err) => handleActionError(err, 'Failed to start timer.'));
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
        errorFallback: 'Failed to log time',
        successMessage: 'Time logged',
      });
      setQuickAddOpen(false);
      setMinutes('');
      setDescription('');
      await refresh();
    } catch (err) {
      handleActionError(err, 'Failed to log time.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3 border-t pt-3" data-testid="ticket-time-billing">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Time &amp; Billing</p>

      {summary && (
        <dl className="mt-2 space-y-1">
          <div className="flex justify-between text-xs">
            <dt className="text-muted-foreground">Total time</dt>
            <dd data-testid="ticket-billing-time-total">{formatMinutes(summary.time.totalMinutes)}</dd>
          </div>
          <div className="flex justify-between text-xs">
            <dt className="text-muted-foreground">Billable</dt>
            <dd data-testid="ticket-billing-time-billable">{formatMinutes(summary.time.billableMinutes)}</dd>
          </div>
          <div className="flex justify-between text-xs">
            <dt className="text-muted-foreground">Time amount</dt>
            <dd data-testid="ticket-billing-amount">{formatMoney(summary.time.billableAmount)}</dd>
          </div>
          <div className="flex justify-between text-xs">
            <dt className="text-muted-foreground">Parts ({summary.parts.partsCount})</dt>
            <dd data-testid="ticket-billing-parts-total">{formatMoney(summary.parts.billableTotal)}</dd>
          </div>
        </dl>
      )}

      <div className="mt-2 flex gap-2">
        <button
          type="button"
          onClick={startTimer}
          className="rounded-md border px-2 py-1 text-xs hover:bg-muted"
          data-testid="ticket-billing-start-timer"
        >
          Start timer
        </button>
        <button
          type="button"
          onClick={() => setQuickAddOpen((o) => !o)}
          className="rounded-md border px-2 py-1 text-xs hover:bg-muted"
          data-testid="ticket-billing-quick-add-toggle"
        >
          Log time
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
            placeholder="Minutes"
            aria-label="Minutes"
            className="w-full rounded-md border bg-background px-2 py-1 text-xs"
            data-testid="ticket-billing-quick-add-minutes"
          />
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Description (optional)"
            aria-label="Description"
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
            Billable
          </label>
          <button
            type="button"
            onClick={() => void submitQuickAdd()}
            disabled={busy}
            className="w-full rounded-md bg-primary px-2 py-1 text-xs font-medium text-white disabled:opacity-50"
            data-testid="ticket-billing-quick-add-submit"
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      )}

      {entries.length > 0 && (
        <ul className="mt-2 space-y-1" data-testid="ticket-billing-entries">
          {entries.map((entry) => (
            <li key={entry.id} className="flex items-start justify-between gap-1 text-xs">
              <span className="min-w-0 truncate text-muted-foreground">
                {entry.userName ?? 'Tech'}
                {entry.description ? ` — ${entry.description}` : ''}
              </span>
              <span className="shrink-0">
                {entry.endedAt == null ? 'running' : formatMinutes(entry.durationMinutes)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
