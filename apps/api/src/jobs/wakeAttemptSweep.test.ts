import { beforeEach, describe, expect, it, vi } from 'vitest';
const { schedule, attach, closeWorker, closeQueue } = vi.hoisted(() => ({
  schedule: vi.fn(), attach: vi.fn(), closeWorker: vi.fn(), closeQueue: vi.fn(),
}));
vi.mock('bullmq', () => ({
  Queue: class { upsertJobScheduler = schedule; close = closeQueue; },
  Worker: class { on = vi.fn(); close = closeWorker; },
}));
vi.mock('../db', () => ({ db: {}, runOutsideDbContext: vi.fn(), withSystemDbAccessContext: vi.fn() }));
vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn() }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: attach }));
import { runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { captureException } from '../services/sentry';
import { classifyWakeAttempt, resolveOpenWakeAttempts, WAKE_ATTEMPT_GRACE_MS, initializeWakeAttemptSweep, shutdownWakeAttemptSweep } from './wakeAttemptSweep';
import { WAKE_OUTCOME_WINDOW_MS } from '../services/wakeAttempts';
import type { WakeAttemptOutcome } from '../db/schema/deviceWake';

const requestedAt = new Date('2026-10-01T12:00:00Z');
const deadlineAt = new Date(+requestedAt + WAKE_OUTCOME_WINDOW_MS);
describe('classifyWakeAttempt', () => {
  it.each<[string, WakeAttemptOutcome, number | null, number, WakeAttemptOutcome | null]>([
    ['seen before deadline', 'sent', 0, -1, 'came_online'],
    ['pending seen', 'pending', 1, -1, 'came_online'],
    ['seen at grace boundary', 'sent', 1, 120_000, 'came_online'],
    ['seen beyond grace', 'sent', 1, 120_001, 'unknown'],
    ['unseen before deadline', 'sent', null, -1, null],
    ['old heartbeat', 'sent', -1, -1, null],
    ['sent at deadline', 'sent', null, 0, 'timed_out'],
    ['sent past deadline', 'sent', null, 1, 'timed_out'],
    ['pending past deadline', 'pending', null, 1, 'send_failed'],
    ['refused stays closed', 'refused', 1, 1, null],
    ['send_failed stays closed', 'send_failed', 1, 1, null],
    ['came_online stays closed', 'came_online', 1, 1, null],
    ['timed_out stays closed', 'timed_out', 1, 1, null],
    ['unknown stays closed', 'unknown', 1, 1, null],
  ])('%s', (_label, outcome, seenOffset, nowOffset, expected) => {
    expect(classifyWakeAttempt({ requestedAt, deadlineAt, outcome }, {
      lastSeenAt: seenOffset === null ? null : new Date(+requestedAt + seenOffset),
    }, new Date(+deadlineAt + nowOffset))).toBe(expected);
  });
  it('uses the outcome window for an open attempt without a deadline', () => {
    expect(classifyWakeAttempt({ requestedAt, deadlineAt: null, outcome: 'sent' },
      { lastSeenAt: null }, deadlineAt)).toBe('timed_out');
    expect(WAKE_ATTEMPT_GRACE_MS).toBe(120_000);
  });
});

describe('wake sweep worker lifecycle', () => {
  beforeEach(() => vi.clearAllMocks());
  it('registers the required minute scheduler and readiness consumer, and closes resources', async () => {
    await initializeWakeAttemptSweep();
    expect(schedule).toHaveBeenCalledWith('wake-attempt-sweep', { every: 60_000 }, expect.objectContaining({ name: 'sweep' }));
    expect(attach).toHaveBeenCalledWith(expect.anything(), 'wakeAttemptSweep');
    await shutdownWakeAttemptSweep();
    await shutdownWakeAttemptSweep();
    expect(closeWorker).toHaveBeenCalledTimes(1);
    expect(closeQueue).toHaveBeenCalledTimes(1);
  });
});


describe('per-attempt failure observability', () => {
  it('reports a failed attempt and continues resolving the batch', async () => {
    const error = new Error('attempt update failed');
    vi.mocked(runOutsideDbContext).mockImplementation(fn => fn());
    vi.mocked(withSystemDbAccessContext)
      .mockResolvedValueOnce([{ id: 'failed' }, { id: 'healthy' }])
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(true);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await resolveOpenWakeAttempts()).toEqual({ resolved: 1 });
    expect(captureException).toHaveBeenCalledWith(error);
    log.mockRestore();
  });
});
