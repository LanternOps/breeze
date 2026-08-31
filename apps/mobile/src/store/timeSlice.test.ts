import { describe, it, expect } from 'vitest';
import timeReducer, {
  elapsedSeconds,
  initialTimeState,
  pendingWritesChanged,
  needsAttentionChanged,
  queueDepthChanged,
  runningTimerAdopted,
  startedTimer,
  stoppedTimer,
  timeAccessDenied,
  timeErrorRaised,
  timerErrored,
  timerStarted,
  timerStopped,
  type TimeState,
} from './timeSlice';

const ENTRY = {
  id: 'e1', ticketId: 'k1', startedAt: '2026-08-23T10:00:00Z', endedAt: null,
  durationMinutes: null, isBillable: true, billingStatus: 'not_billed' as const, isApproved: false, description: null,
};

const RUNNING = {
  id: 'e9', localId: null, ticketId: 'k9', startedAt: '2026-08-23T09:00:00Z', description: 'onsite',
};

/** A timer that exists only on this device, started while offline. */
const LOCAL_RUNNING = {
  id: null, localId: 'l1', ticketId: 'k9', startedAt: '2026-08-30T09:00:00.000Z', description: null,
};

describe('elapsedSeconds', () => {
  it('is zero when nothing is running', () => {
    expect(elapsedSeconds(null, new Date('2026-08-23T10:00:00Z'))).toBe(0);
  });

  it('counts from startedAt', () => {
    const running = { id: 't1', localId: null, ticketId: null, startedAt: '2026-08-23T10:00:00Z', description: null };
    expect(elapsedSeconds(running, new Date('2026-08-23T10:02:30Z'))).toBe(150);
  });

  it('clamps a future startedAt to zero rather than showing a negative timer', () => {
    // Phone clocks drift; the server accepts up to 5 minutes of skew, so a
    // startedAt slightly ahead of local time is normal, not corrupt.
    const running = { id: 't1', localId: null, ticketId: null, startedAt: '2026-08-23T10:05:00Z', description: null };
    expect(elapsedSeconds(running, new Date('2026-08-23T10:00:00Z'))).toBe(0);
  });

  it('treats an unparseable startedAt as zero instead of NaN', () => {
    const running = { id: 't1', localId: null, ticketId: null, startedAt: 'not-a-date', description: null };
    expect(elapsedSeconds(running, new Date('2026-08-23T10:00:00Z'))).toBe(0);
  });
});

describe('reducers', () => {
  it('starts from an empty state', () => {
    expect(initialTimeState).toEqual({
      running: null,
      pendingCount: 0,
      needsAttentionCount: 0,
      lastError: null,
    });
  });

  it('records the running timer on start and clears a stale error', () => {
    const errored: TimeState = { ...initialTimeState, lastError: 'boom' };
    const next = timerStarted(errored, ENTRY);
    expect(next.running).toEqual({ id: 'e1', localId: null, ticketId: 'k1', startedAt: '2026-08-23T10:00:00Z', description: null });
    expect(next.lastError).toBeNull();
    expect(next).not.toBe(errored);
    expect(errored.running).toBeNull();
  });

  it('clears the running timer on stop', () => {
    const started = timerStarted(initialTimeState, ENTRY);
    expect(timerStopped(started).running).toBeNull();
  });

  it('tracks queue depth as a plain number without touching the timer', () => {
    const started = timerStarted(initialTimeState, ENTRY);
    const next = queueDepthChanged(started, 3);
    expect(next.pendingCount).toBe(3);
    expect(next.running).toEqual(started.running);
  });

  it('records the last error message without clearing the running timer', () => {
    const started = timerStarted(initialTimeState, ENTRY);
    const next = timerErrored(started, 'A timer is already running');
    expect(next.lastError).toBe('A timer is already running');
    expect(next.running).toEqual(started.running);
  });
});

describe('time reducer (redux binding)', () => {
  it('starts from the pure initial state with no recorded denial', () => {
    const state = timeReducer(undefined, { type: '@@INIT' });
    expect(state).toEqual({ ...initialTimeState, denial: null });
  });

  it('adopts a timer the server reports as already running', () => {
    // Cold start and reinstall both land here: the phone has no local timer but
    // the user may have started one from the web dashboard.
    const state = timeReducer(undefined, runningTimerAdopted(RUNNING));
    expect(state.running).toEqual(RUNNING);
  });

  it('holds a device-only timer, which is what lets the bar tick offline', () => {
    const state = timeReducer(undefined, runningTimerAdopted(LOCAL_RUNNING));
    expect(state.running).toEqual(LOCAL_RUNNING);
    expect(state.running?.id).toBeNull();
    expect(elapsedSeconds(state.running, new Date('2026-08-30T09:40:00.000Z'))).toBe(2400);
  });

  it('clears a stale local timer when the server reports none running', () => {
    const started = timeReducer(undefined, startedTimer(ENTRY));
    expect(timeReducer(started, runningTimerAdopted(null)).running).toBeNull();
  });

  it('records and clears the running timer through the pure reducers', () => {
    const started = timeReducer(undefined, startedTimer(ENTRY));
    expect(started.running).toMatchObject({ id: 'e1', ticketId: 'k1' });
    expect(timeReducer(started, stoppedTimer()).running).toBeNull();
  });

  it('keeps a denial for the rest of the session so the control is not re-offered', () => {
    // A 403 is a wall, not a hiccup: re-rendering a Start button that always
    // fails is how the W02 scope gap reaches a technician as "the app is broken".
    const denied = timeReducer(undefined, timeAccessDenied({ reason: 'scope', message: 'nope' }));
    expect(denied.denial).toEqual({ reason: 'scope', message: 'nope' });
    // A later success does not un-deny; only a fresh sign-in (which resets the
    // whole store) clears it.
    expect(timeReducer(denied, pendingWritesChanged(2)).denial).not.toBeNull();
  });

  it('tracks parked work independently of the queue depth', () => {
    // The two counts mean different things and are reported separately: a
    // pending write will still be sent, a parked one never will. Collapsing
    // them is how "N entries need attention" turns back into a badge that
    // looks like it is about to clear itself.
    const state = timeReducer(undefined, needsAttentionChanged(2));
    expect(state.needsAttentionCount).toBe(2);
    expect(state.pendingCount).toBe(0);
    expect(timeReducer(state, pendingWritesChanged(5)).needsAttentionCount).toBe(2);
    expect(timeReducer(state, needsAttentionChanged(0)).needsAttentionCount).toBe(0);
  });

  it('tracks queue depth independently of the running timer', () => {
    const started = timeReducer(undefined, startedTimer(ENTRY));
    const next = timeReducer(started, pendingWritesChanged(4));
    expect(next.pendingCount).toBe(4);
    expect(next.running).toEqual(started.running);
  });

  it('raises and clears the last error', () => {
    const raised = timeReducer(undefined, timeErrorRaised('offline'));
    expect(raised.lastError).toBe('offline');
    expect(timeReducer(raised, timeErrorRaised(null)).lastError).toBeNull();
  });
});
