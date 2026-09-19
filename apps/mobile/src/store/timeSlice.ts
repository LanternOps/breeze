import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

import type { RunningTimer, TimeEntry } from '../services/timeEntries';
import type { TimeEntryDenial } from '../services/timeEntryAccess';

export interface TimeState {
  running: RunningTimer | null;
  pendingCount: number;
  /**
   * Writes the server refused for good, parked rather than deleted. It lives in
   * the store, not in the TimerBar, because the bar is not the only surface
   * that can park one: a stop whose device clock ran backwards is parked from
   * the ticket screen, and the standing "N need attention" row has to appear
   * then — not at the next reconnect.
   */
  needsAttentionCount: number;
  lastError: string | null;
}

export const initialTimeState: TimeState = {
  running: null,
  pendingCount: 0,
  needsAttentionCount: 0,
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
      localId: null,
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

export function needsAttentionChangedState(
  state: TimeState,
  needsAttentionCount: number
): TimeState {
  return { ...state, needsAttentionCount };
}

export function timerErrored(state: TimeState, message: string): TimeState {
  return { ...state, lastError: message };
}

/**
 * Redux binding over the pure reducers above.
 *
 * The running timer lives in the Redux store rather than a module-level
 * singleton for one reason: `withLogoutReset` (store/resettable.ts) wipes every
 * registered slice on sign-out. A timer left behind by the previous account
 * would keep ticking in the bar for the next one — the same cross-session leak
 * the wrapper exists to prevent.
 */
export interface TimeSliceState extends TimeState {
  /**
   * Sticky for the session. A 403 from `/time-entries` is a wall, not a
   * hiccup — an organization-scoped token can never read the table, and a
   * missing `time_entries:write` grant needs an admin. Re-offering a Start
   * button that always fails is how that reaches a technician as "the app is
   * broken", so the denial is remembered and the control is withdrawn until
   * the next sign-in clears the whole store.
   */
  denial: TimeEntryDenial | null;
}

const initialState: TimeSliceState = { ...initialTimeState, denial: null };

const timeSlice = createSlice({
  name: 'time',
  initialState,
  reducers: {
    /**
     * The running timer, from any authority: the server's answer to
     * GET /time-entries/running, or a timer that exists only on this device
     * (`id === null`) because it was started offline.
     */
    runningTimerAdopted(state, action: PayloadAction<RunningTimer | null>) {
      state.running = action.payload;
      state.lastError = null;
    },
    startedTimer(state, action: PayloadAction<TimeEntry>) {
      return { ...state, ...timerStarted(state, action.payload) };
    },
    stoppedTimer(state) {
      return { ...state, ...timerStopped(state) };
    },
    pendingWritesChanged(state, action: PayloadAction<number>) {
      return { ...state, ...queueDepthChanged(state, action.payload) };
    },
    needsAttentionChanged(state, action: PayloadAction<number>) {
      return { ...state, ...needsAttentionChangedState(state, action.payload) };
    },
    timeErrorRaised(state, action: PayloadAction<string | null>) {
      state.lastError = action.payload;
    },
    timeAccessDenied(state, action: PayloadAction<TimeEntryDenial>) {
      state.denial = action.payload;
      state.lastError = action.payload.message;
    },
  },
});

export const {
  runningTimerAdopted,
  startedTimer,
  stoppedTimer,
  pendingWritesChanged,
  needsAttentionChanged,
  timeErrorRaised,
  timeAccessDenied,
} = timeSlice.actions;

export default timeSlice.reducer;
