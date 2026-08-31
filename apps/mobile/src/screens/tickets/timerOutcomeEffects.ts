import type { RunningTimer } from '../../services/timeEntries';
import { isAccountLevelDenial, type TimeEntryDenial } from '../../services/timeEntryAccess';

import type { StartOutcome, StopOutcome } from './timerActions';

/**
 * What a screen must do with a timer outcome.
 *
 * The two surfaces that start and stop timers (TicketDetailScreen and the
 * TimerBar) were making these decisions independently, and drifted: neither
 * cleared the local running timer on a QUEUED stop, and both escalated every
 * classified 403 — including per-row verdicts — into the sticky account-level
 * wall. Deciding once, in a pure module, is also the only way this is testable:
 * the app has no React Native test runtime.
 */
export interface TimerEffects {
  /** Drop the local running timer. */
  clearRunning: boolean;
  /**
   * Adopt this as the running timer. `id === null` means it exists only on this
   * device (started offline) — it still ticks, and stopping it is what turns it
   * into a queued `create` carrying the real span.
   */
  startRunning: RunningTimer | null;
  /** Remember this denial for the session. Only account-level denials qualify. */
  accountDenial: TimeEntryDenial | null;
  /** Re-read the queue depth from storage. */
  refreshQueueDepth: boolean;
  /** Re-read the needs-attention list: something was parked for manual entry. */
  refreshNeedsAttention: boolean;
  /** Re-read the ticket: a completed stop writes a server-side activity comment. */
  reload: boolean;
  toast: { kind: 'success' | 'error'; text: string };
  /** Inline note next to the control, or null to clear it. */
  notice: string | null;
}

const QUEUED_TOAST = 'Saved offline — it will sync when you reconnect.';
const LOCAL_START_TOAST = 'Timer started — it will sync when you reconnect.';

function base(): TimerEffects {
  return {
    clearRunning: false,
    startRunning: null,
    accountDenial: null,
    refreshQueueDepth: false,
    refreshNeedsAttention: false,
    reload: false,
    toast: { kind: 'success', text: '' },
    notice: null,
  };
}

function failure(
  outcome: { reason: string; message: string; denial?: TimeEntryDenial },
  extra: Partial<TimerEffects> = {}
): TimerEffects {
  const denial = outcome.denial;
  return {
    ...base(),
    // A verdict about one entry (approved, billed, owned by someone else) is
    // NOT a reason to withdraw time tracking app-wide until sign-out.
    accountDenial: denial !== undefined && isAccountLevelDenial(denial) ? denial : null,
    toast: { kind: 'error', text: outcome.message },
    notice: outcome.message,
    ...extra,
  };
}

export function startOutcomeEffects(outcome: StartOutcome): TimerEffects {
  if (outcome.ok === true) {
    return {
      ...base(),
      startRunning: {
        id: outcome.entry.id,
        localId: null,
        ticketId: outcome.entry.ticketId,
        startedAt: outcome.entry.startedAt,
        description: outcome.entry.description,
      },
      toast: { kind: 'success', text: 'Timer started' },
    };
  }

  if (outcome.ok === 'local') {
    // A local timer DOES tick. Withholding it was the defect: with no running
    // timer in the store, no surface offered Stop, so a timer started offline
    // could never be stopped offline — and the span the whole offline design
    // exists to record was lost.
    return {
      ...base(),
      startRunning: {
        id: null,
        localId: outcome.timer.localId,
        ticketId: outcome.timer.ticketId,
        startedAt: outcome.timer.startedAtWall,
        description: outcome.timer.description,
      },
      toast: { kind: 'success', text: LOCAL_START_TOAST },
    };
  }

  return failure(outcome);
}

export function stopOutcomeEffects(outcome: StopOutcome): TimerEffects {
  if (outcome.ok === true) {
    return {
      ...base(),
      clearRunning: true,
      reload: true,
      toast: { kind: 'success', text: 'Timer stopped' },
    };
  }

  if (outcome.ok === 'queued') {
    // Unlike a queued start, the local state here is unambiguous: the
    // technician has said the timer is over and the queued write is what makes
    // the server agree. Leaving `running` populated keeps the bar counting past
    // a stop that reported success, and invites a second tap whose duplicate
    // stop replays as a 404 — dropped, and reported as work that "could not be
    // saved" when it was.
    return {
      ...base(),
      clearRunning: true,
      refreshQueueDepth: true,
      toast: { kind: 'success', text: QUEUED_TOAST },
    };
  }

  if (outcome.reason === 'unusable-clock') {
    // The span could not be measured, so nothing was queued. The timer is gone
    // from the bar either way — it has no honest elapsed time left to show —
    // and the work is parked where the technician can re-enter it.
    return failure(outcome, { clearRunning: true, refreshNeedsAttention: true });
  }

  // The server is authoritative: nothing was running, so neither is the bar.
  return failure(outcome, { clearRunning: outcome.reason === 'not-running' });
}
