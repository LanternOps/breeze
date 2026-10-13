import { describe, expect, it } from 'vitest';
import { makeRealJob } from './__helpers__/realBullJob';
import { isFinalSyncAttempt } from './syncAttempt';

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
