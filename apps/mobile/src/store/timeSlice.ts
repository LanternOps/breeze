import type { RunningTimer, TimeEntry } from '../services/timeEntries';

export interface TimeState {
  running: RunningTimer | null;
  pendingCount: number;
  lastError: string | null;
}

export const initialTimeState: TimeState = {
  running: null,
  pendingCount: 0,
  lastError: null,
};

export function elapsedSeconds(running: RunningTimer | null, now: Date): number {
  if (running === null) return 0;

  const elapsed = Math.floor((now.getTime() - new Date(running.startedAt).getTime()) / 1000);
  if (!Number.isFinite(elapsed)) return 0;

  // The server tolerates 5 minutes of clock skew, so a future startedAt is
  // legitimate; never show a negative timer.
  return Math.max(0, elapsed);
}

export function timerStarted(state: TimeState, entry: TimeEntry): TimeState {
  return {
    ...state,
    running: {
      id: entry.id,
      ticketId: entry.ticketId,
      startedAt: entry.startedAt,
      description: entry.description,
    },
    lastError: null,
  };
}

export function timerStopped(state: TimeState): TimeState {
  return { ...state, running: null, lastError: null };
}

export function queueDepthChanged(state: TimeState, pendingCount: number): TimeState {
  return { ...state, pendingCount };
}

export function timerErrored(state: TimeState, message: string): TimeState {
  return { ...state, lastError: message };
}
