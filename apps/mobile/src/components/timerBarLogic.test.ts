import { describe, it, expect } from 'vitest';

import { isQueueWedged, isTimerBarVisible, shouldReplayNow, WEDGED_ATTEMPTS } from './timerBarLogic';

describe('isTimerBarVisible', () => {
  it('stays mounted while a toast is pending even with an empty queue and no timer', () => {
    // The replay result toast lives inside the bar. After a drain that empties
    // the queue by DROPPING writes, remaining is 0 and running is null, so a
    // visibility rule of "running || pending" unmounts the bar in the very
    // render that would have shown "N offline time entries could not be saved".
    // Discarded billable work would vanish with no signal anywhere.
    expect(isTimerBarVisible({ hasRunningTimer: false, pendingCount: 0, hasToast: true })).toBe(true);
  });

  it('is hidden only when there is nothing running, nothing queued and nothing to say', () => {
    expect(isTimerBarVisible({ hasRunningTimer: false, pendingCount: 0, hasToast: false })).toBe(false);
  });

  it('is visible for a running timer and for an unsent backlog', () => {
    expect(isTimerBarVisible({ hasRunningTimer: true, pendingCount: 0, hasToast: false })).toBe(true);
    expect(isTimerBarVisible({ hasRunningTimer: false, pendingCount: 2, hasToast: false })).toBe(true);
  });
});

describe('shouldReplayNow', () => {
  it('drains a backlog left by a previous launch when the app starts online', () => {
    // useNetworkConnected seeds `true`, so an app relaunched at the office on
    // strong WiFi never sees a false->true edge. Without a cold-start drain the
    // "2" badge sits there until connectivity happens to drop and return.
    expect(
      shouldReplayNow({ coldStart: true, previousConnected: true, connected: true, pendingCount: 2 })
    ).toBe(true);
  });

  it('does not drain an empty queue on cold start', () => {
    expect(
      shouldReplayNow({ coldStart: true, previousConnected: true, connected: true, pendingCount: 0 })
    ).toBe(false);
  });

  it('does not drain on cold start while offline', () => {
    expect(
      shouldReplayNow({ coldStart: true, previousConnected: true, connected: false, pendingCount: 2 })
    ).toBe(false);
  });

  it('drains on a false -> true reconnection regardless of the known depth', () => {
    // The depth cached in the store can be stale (a storage read failed), and a
    // reconnect is the one moment worth spending a drain on.
    expect(
      shouldReplayNow({ coldStart: false, previousConnected: false, connected: true, pendingCount: 0 })
    ).toBe(true);
  });

  it('does not re-drain on a true -> true report', () => {
    // Replaying on every render would race drain's own serialisation for no gain.
    expect(
      shouldReplayNow({ coldStart: false, previousConnected: true, connected: true, pendingCount: 3 })
    ).toBe(false);
  });

  it('does not drain on losing the connection', () => {
    expect(
      shouldReplayNow({ coldStart: false, previousConnected: true, connected: false, pendingCount: 3 })
    ).toBe(false);
  });
});

describe('isQueueWedged', () => {
  it('is false for a first failed attempt — that is just being offline', () => {
    expect(isQueueWedged({ remaining: 3, headAttempts: 1 })).toBe(false);
  });

  it('is true once the head write has failed repeatedly and is blocking the rest', () => {
    // The state issue #4251 makes ordinary: a default Partner Technician lacks
    // time_entries:write, so every replay 403s. The queue correctly RETAINS
    // those writes, which means nothing behind them can ever move — and before
    // this predicate had a consumer, that happened in total silence.
    expect(isQueueWedged({ remaining: 3, headAttempts: WEDGED_ATTEMPTS })).toBe(true);
    expect(isQueueWedged({ remaining: 1, headAttempts: 50 })).toBe(true);
  });

  it('is false once the queue has drained, however many attempts it took', () => {
    expect(isQueueWedged({ remaining: 0, headAttempts: 99 })).toBe(false);
  });
});
