import { describe, expect, it, vi } from 'vitest';
import { makeRealJob } from './__helpers__/realBullJob';
import { isFinalSyncAttempt, reportTerminalSyncFailure } from './syncAttempt';
// Globally mocked in src/__tests__/setup.ts.
import { nudgeConnectionHealth } from '../services/connectionHealth/nudge';

describe('isFinalSyncAttempt with a real BullMQ Job (#8351)', () => {
  it('is false on the first and second of three attempts, true on the third', () => {
    expect(isFinalSyncAttempt(makeRealJob({}, { attemptsMade: 0, attempts: 3 }))).toBe(false);
    expect(isFinalSyncAttempt(makeRealJob({}, { attemptsMade: 1, attempts: 3 }))).toBe(false);
    expect(isFinalSyncAttempt(makeRealJob({}, { attemptsMade: 2, attempts: 3 }))).toBe(true);
  });

  it('treats a job without opts.attempts as single-attempt', () => {
    expect(isFinalSyncAttempt(makeRealJob({}, { attemptsMade: 0 }))).toBe(true);
  });
});

describe('reportTerminalSyncFailure (connection health W4)', () => {
  it('nudges the matching health kind', () => {
    const nudge = vi.mocked(nudgeConnectionHealth);
    nudge.mockClear();
    reportTerminalSyncFailure('huntress');
    reportTerminalSyncFailure('m365_sync');
    expect(nudge.mock.calls).toEqual([['huntress'], ['m365_sync']]);
  });

  it('never throws into the sync worker', () => {
    vi.mocked(nudgeConnectionHealth).mockImplementationOnce(() => { throw new Error('boom'); });
    expect(() => reportTerminalSyncFailure('edr')).not.toThrow();
  });
});
