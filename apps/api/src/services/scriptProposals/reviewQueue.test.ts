import { afterEach, describe, expect, it, vi } from 'vitest';

const addMock = vi.fn(async () => undefined);
vi.mock('bullmq', () => ({ Queue: class { add = addMock; } }));
vi.mock('../redis', () => ({ getBullMQConnection: () => ({}) }));
const { captureMock } = vi.hoisted(() => ({ captureMock: vi.fn() }));
vi.mock('../sentry', () => ({ captureException: captureMock }));

let selectImpl: () => Promise<Record<string, unknown>[]> = async () => [];
vi.mock('../../db', () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: () => selectImpl() }) }) }) }) },
  withSystemDbAccessContext: <T,>(fn: () => Promise<T>) => fn(),
  runOutsideDbContext: <T,>(fn: () => T) => fn(),
}));

import { SCRIPT_REVIEW_QUEUE, enqueueScriptReview, waitForReviewCompletion } from './reviewQueue';

afterEach(() => { vi.useRealTimers(); addMock.mockClear(); });

describe('script review queue', () => {
  it('names the queue script-review', () => {
    expect(SCRIPT_REVIEW_QUEUE).toBe('script-review');
  });

  it('enqueues with an attempt-scoped, colon-free job id so a retry is not a silent no-op', async () => {
    await enqueueScriptReview({ proposalId: 'p1', orgId: 'o1', attempt: 2 });
    const [, , options] = addMock.mock.calls[0]! as unknown as [string, unknown, { jobId: string }];
    expect(options.jobId).toBe('script-review-p1-2');
    expect(options.jobId).not.toContain(':');
  });

  it('returns the completed review as soon as one exists', async () => {
    selectImpl = async () => [{ id: 'r1', status: 'completed' }];
    await expect(waitForReviewCompletion('p1', 5_000)).resolves.toMatchObject({ id: 'r1' });
  });

  it('returns a failed review too — the caller reports it, it is not an absence', async () => {
    selectImpl = async () => [{ id: 'r1', status: 'failed' }];
    await expect(waitForReviewCompletion('p1', 5_000)).resolves.toMatchObject({ status: 'failed' });
  });

  it('returns null after five consecutive DB errors without waiting out the timeout', async () => {
    selectImpl = async () => { throw new Error('boom'); };
    const started = Date.now();
    await expect(waitForReviewCompletion('p1', 600_000)).resolves.toBeNull();
    expect(Date.now() - started).toBeLessThan(30_000);
    // The breaker is an infra fault and must reach Sentry — the caller only
    // ever sees `pending`.
    expect(captureMock).toHaveBeenCalledTimes(1);
    // Five errors with a 2 s poll interval is ~8 s of real time, past vitest's
    // 5 s default — the assertion above is what proves the breaker fires.
  }, 20_000);
});
