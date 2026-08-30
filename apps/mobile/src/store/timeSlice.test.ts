import { describe, it, expect } from 'vitest';
import {
  elapsedSeconds,
  initialTimeState,
  queueDepthChanged,
  timerErrored,
  timerStarted,
  timerStopped,
  type TimeState,
} from './timeSlice';

const ENTRY = {
  id: 'e1', ticketId: 'k1', startedAt: '2026-08-23T10:00:00Z', endedAt: null,
  durationMinutes: null, isBillable: true, billingStatus: 'not_billed' as const, isApproved: false, description: null,
};

describe('elapsedSeconds', () => {
  it('is zero when nothing is running', () => {
    expect(elapsedSeconds(null, new Date('2026-08-23T10:00:00Z'))).toBe(0);
  });

  it('counts from startedAt', () => {
    const running = { id: 't1', ticketId: null, startedAt: '2026-08-23T10:00:00Z', description: null };
    expect(elapsedSeconds(running, new Date('2026-08-23T10:02:30Z'))).toBe(150);
  });

  it('clamps a future startedAt to zero rather than showing a negative timer', () => {
    // Phone clocks drift; the server accepts up to 5 minutes of skew, so a
    // startedAt slightly ahead of local time is normal, not corrupt.
    const running = { id: 't1', ticketId: null, startedAt: '2026-08-23T10:05:00Z', description: null };
    expect(elapsedSeconds(running, new Date('2026-08-23T10:00:00Z'))).toBe(0);
  });

  it('treats an unparseable startedAt as zero instead of NaN', () => {
    const running = { id: 't1', ticketId: null, startedAt: 'not-a-date', description: null };
    expect(elapsedSeconds(running, new Date('2026-08-23T10:00:00Z'))).toBe(0);
  });
});

describe('reducers', () => {
  it('starts from an empty state', () => {
    expect(initialTimeState).toEqual({ running: null, pendingCount: 0, lastError: null });
  });

  it('records the running timer on start and clears a stale error', () => {
    const errored: TimeState = { ...initialTimeState, lastError: 'boom' };
    const next = timerStarted(errored, ENTRY);
    expect(next.running).toEqual({ id: 'e1', ticketId: 'k1', startedAt: '2026-08-23T10:00:00Z', description: null });
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
