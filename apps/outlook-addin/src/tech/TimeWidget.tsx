/**
 * Time tracking widget (Task 24): always shows the technician's global
 * running timer (fetched on mount + polled every 30s), start/stop against the
 * linked ticket, and a manual log form for completed work.
 *
 * Starting a timer always auto-stops any prior running timer server-side
 * (`POST /office-addin/time/start`), so when one is already running on a
 * DIFFERENT ticket than `linkedTicket` we show an explicit warning
 * ("Starts here and stops the timer on <internalNumber>") and only call
 * `startTimer` on confirm. Starting with nothing running, or a timer already
 * running on this same ticket, proceeds directly.
 *
 * `isBillable` is a tri-state checkbox: the field is omitted from the
 * `logTime` request entirely unless the technician actually clicks it, so the
 * server's own default applies untouched (schema: `isBillable?: boolean`).
 *
 * The suggested AI duration (`suggestedDurationMinutes`, from the last
 * `fetchDraft` response held by `TechPane`) prefills the manual form's
 * duration field, but — same dirty-tracking pattern as `CreateTicketForm` —
 * never clobbers a value the technician has already edited.
 *
 * `linkedTicket` takes `LinkableTicket` (the `{id, internalNumber}` shape
 * `LinkEmailAction` already defined) rather than the fuller
 * `AddinTicketSummary` — TechPane's `selectedTicket` state is
 * `AddinTicketSummary | MatchedTicket | null`, and this widget only needs the
 * id + display number, same reasoning `LinkEmailAction` used.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  fetchRunningTimer,
  startTimer,
  stopTimer,
  logTime,
  TechApiError,
  type LogTimeRequest,
  type RunningTimerEntry,
} from './api';
import type { LinkableTicket } from './LinkEmailAction';

export interface TimeWidgetProps {
  linkedTicket: LinkableTicket | null;
  /** Last AI draft's `suggestedTimeMinutes`, if any — prefills the log form's duration. */
  suggestedDurationMinutes?: number;
  onBanner: (message: string | null) => void;
}

const POLL_INTERVAL_MS = 30_000;

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof TechApiError ? `${fallback} (${err.code}).` : `${fallback}.`;
}

export function TimeWidget({ linkedTicket, suggestedDurationMinutes, onBanner }: TimeWidgetProps) {
  const [running, setRunning] = useState<RunningTimerEntry | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [pendingStart, setPendingStart] = useState(false);

  const [logMode, setLogMode] = useState<'duration' | 'range'>('duration');
  const [durationMinutes, setDurationMinutes] = useState('');
  const [durationTouched, setDurationTouched] = useState(false);
  const [rangeStart, setRangeStart] = useState('');
  const [rangeEnd, setRangeEnd] = useState('');
  const [description, setDescription] = useState('');
  const [isBillable, setIsBillable] = useState(false);
  const [isBillableTouched, setIsBillableTouched] = useState(false);
  const [logSubmitting, setLogSubmitting] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetchRunningTimer();
      setRunning(res.running);
    } catch (err) {
      onBanner(errorMessage(err, 'Failed to load timer'));
    } finally {
      setLoaded(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onBanner is a stable setter passed from TechPane
  }, []);

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => {
      void refresh();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [refresh]);

  useEffect(() => {
    if (!durationTouched && suggestedDurationMinutes != null) {
      setDurationMinutes(String(suggestedDurationMinutes));
    }
  }, [suggestedDurationMinutes, durationTouched]);

  async function doStart(): Promise<void> {
    if (!linkedTicket) return;
    setStarting(true);
    onBanner(null);
    try {
      const res = await startTimer({ ticketId: linkedTicket.id });
      setRunning({
        id: res.entry.id,
        ticketId: res.entry.ticketId,
        ticketInternalNumber: linkedTicket.internalNumber,
        startedAt: res.entry.startedAt,
        description: res.entry.description,
      });
      setPendingStart(false);
    } catch (err) {
      onBanner(errorMessage(err, 'Failed to start timer'));
    } finally {
      setStarting(false);
    }
  }

  function handleStartClick(): void {
    if (!linkedTicket) return;
    if (running && running.ticketId !== linkedTicket.id) {
      setPendingStart(true);
      return;
    }
    void doStart();
  }

  async function handleStop(): Promise<void> {
    setStopping(true);
    onBanner(null);
    try {
      await stopTimer({});
      setRunning(null);
    } catch (err) {
      onBanner(errorMessage(err, 'Failed to stop timer'));
    } finally {
      setStopping(false);
    }
  }

  function computeLogWindow(): { startedAt: string; endedAt: string } | null {
    if (logMode === 'duration') {
      const minutes = Number(durationMinutes);
      if (!minutes || minutes <= 0) return null;
      const end = new Date();
      const start = new Date(end.getTime() - minutes * 60_000);
      return { startedAt: start.toISOString(), endedAt: end.toISOString() };
    }
    if (!rangeStart || !rangeEnd) return null;
    const start = new Date(rangeStart);
    const end = new Date(rangeEnd);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
    return { startedAt: start.toISOString(), endedAt: end.toISOString() };
  }

  const logWindow = computeLogWindow();
  const canSubmitLog = Boolean(linkedTicket && logWindow && description.trim());

  async function handleLogSubmit(): Promise<void> {
    if (!linkedTicket || !logWindow || !description.trim()) return;
    setLogSubmitting(true);
    onBanner(null);
    try {
      const body: LogTimeRequest = {
        ticketId: linkedTicket.id,
        startedAt: logWindow.startedAt,
        endedAt: logWindow.endedAt,
        description: description.trim(),
      };
      if (isBillableTouched) body.isBillable = isBillable;
      await logTime(body);
      setDescription('');
      setDurationMinutes('');
      setDurationTouched(false);
      setRangeStart('');
      setRangeEnd('');
      setIsBillable(false);
      setIsBillableTouched(false);
    } catch (err) {
      onBanner(errorMessage(err, 'Failed to log time'));
    } finally {
      setLogSubmitting(false);
    }
  }

  return (
    <div data-testid="time-widget" className="flex flex-col gap-2 rounded-md border border-gray-200 p-3">
      <span className="text-xs font-medium text-gray-600">Time tracking</span>

      {loaded && running && (
        <div data-testid="time-running" className="flex items-center justify-between gap-2 text-sm text-gray-900">
          <span>
            Running on {running.ticketInternalNumber ?? 'an untracked ticket'} since{' '}
            {new Date(running.startedAt).toLocaleTimeString()}
          </span>
          <button
            type="button"
            data-testid="time-stop-button"
            onClick={() => void handleStop()}
            disabled={stopping}
            className="rounded-md border border-gray-300 px-2 py-1 text-xs hover:bg-gray-50 disabled:opacity-50"
          >
            Stop
          </button>
        </div>
      )}
      {loaded && !running && (
        <div data-testid="time-idle" className="text-xs text-gray-400">
          No timer running.
        </div>
      )}

      {!pendingStart && (
        <button
          type="button"
          data-testid="time-start-button"
          onClick={handleStartClick}
          disabled={!linkedTicket || starting}
          className="w-fit rounded-md border border-blue-300 bg-blue-50 px-2 py-1 text-xs hover:bg-blue-100 disabled:opacity-50"
        >
          Start on this ticket
        </button>
      )}

      {pendingStart && running && (
        <div data-testid="time-start-warning" className="flex flex-col gap-1 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800">
          <span>
            Starts here and stops the timer on {running.ticketInternalNumber ?? 'the other ticket'}.
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              data-testid="time-start-confirm"
              onClick={() => void doStart()}
              disabled={starting}
              className="rounded-md border border-amber-400 bg-amber-100 px-2 py-1 hover:bg-amber-200 disabled:opacity-50"
            >
              Start anyway
            </button>
            <button
              type="button"
              data-testid="time-start-cancel"
              onClick={() => setPendingStart(false)}
              className="rounded-md border border-gray-300 px-2 py-1 hover:bg-gray-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div data-testid="time-log-form" className="flex flex-col gap-2 border-t border-gray-100 pt-2">
        <span className="text-xs font-medium text-gray-600">Log time manually</span>

        <div className="flex gap-3 text-xs">
          <label className="flex items-center gap-1">
            <input
              type="radio"
              name="time-log-mode"
              data-testid="time-log-mode-duration"
              checked={logMode === 'duration'}
              onChange={() => setLogMode('duration')}
            />
            Duration
          </label>
          <label className="flex items-center gap-1">
            <input
              type="radio"
              name="time-log-mode"
              data-testid="time-log-mode-range"
              checked={logMode === 'range'}
              onChange={() => setLogMode('range')}
            />
            Start/end
          </label>
        </div>

        {logMode === 'duration' ? (
          <input
            data-testid="time-log-duration"
            type="number"
            min={1}
            placeholder="Minutes"
            value={durationMinutes}
            onChange={(e) => {
              setDurationMinutes(e.target.value);
              setDurationTouched(true);
            }}
            className="rounded-md border border-gray-300 px-2 py-1 text-xs"
          />
        ) : (
          <div className="flex gap-2">
            <input
              data-testid="time-log-start"
              type="datetime-local"
              value={rangeStart}
              onChange={(e) => setRangeStart(e.target.value)}
              className="rounded-md border border-gray-300 px-2 py-1 text-xs"
            />
            <input
              data-testid="time-log-end"
              type="datetime-local"
              value={rangeEnd}
              onChange={(e) => setRangeEnd(e.target.value)}
              className="rounded-md border border-gray-300 px-2 py-1 text-xs"
            />
          </div>
        )}

        <textarea
          data-testid="time-log-description"
          placeholder="What did you work on?"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          className="rounded-md border border-gray-300 px-2 py-1 text-xs"
        />

        <label className="flex items-center gap-1 text-xs">
          <input
            type="checkbox"
            data-testid="time-log-billable"
            checked={isBillable}
            onChange={(e) => {
              setIsBillable(e.target.checked);
              setIsBillableTouched(true);
            }}
          />
          Billable
        </label>

        <button
          type="button"
          data-testid="time-log-submit"
          onClick={() => void handleLogSubmit()}
          disabled={!canSubmitLog || logSubmitting}
          className="w-fit rounded-md border border-gray-300 px-2 py-1 text-xs hover:bg-gray-50 disabled:opacity-50"
        >
          Log time
        </button>
      </div>
    </div>
  );
}
