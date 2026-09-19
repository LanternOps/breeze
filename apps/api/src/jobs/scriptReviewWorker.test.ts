// apps/api/src/jobs/scriptReviewWorker.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const PROPOSAL_ID = '00000000-0000-4000-8000-0000000000d1';
const ORG_ID = '00000000-0000-4000-8000-0000000000d2';

const shared = vi.hoisted(() => ({
  workerOnMock: vi.fn(),
  workerCloseMock: vi.fn(async () => undefined),
  workerCtorArgs: [] as unknown[][],
  attachWorkerObservabilityMock: vi.fn(),
  runScriptReviewMock: vi.fn(),
  tryAcquireOrgReviewSlotMock: vi.fn(),
  releaseOrgReviewSlotMock: vi.fn(async () => undefined),
  captureExceptionMock: vi.fn(),
}));

vi.mock('bullmq', () => ({
  Worker: class {
    constructor(...args: unknown[]) {
      shared.workerCtorArgs.push(args);
    }
    on = shared.workerOnMock;
    close = shared.workerCloseMock;
  },
  DelayedError: class DelayedError extends Error {
    constructor() {
      super('bullmq:movedToDelayed');
      this.name = 'DelayedError';
    }
  },
  UnrecoverableError: class UnrecoverableError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'UnrecoverableError';
    }
  },
}));

vi.mock('../services/scriptProposals/reviewQueue', () => ({
  SCRIPT_REVIEW_QUEUE: 'script-review',
  SCRIPT_REVIEW_JOB_NAME: 'review',
}));
vi.mock('../services/scriptProposals/reviewer', () => ({
  runScriptReview: shared.runScriptReviewMock,
  ProposalNotReviewableError: class ProposalNotReviewableError extends Error {
    constructor(message = 'not reviewable') {
      super(message);
      this.name = 'ProposalNotReviewableError';
    }
  },
}));
vi.mock('../services/scriptProposals/reviewConcurrency', () => ({
  tryAcquireOrgReviewSlot: shared.tryAcquireOrgReviewSlotMock,
  releaseOrgReviewSlot: shared.releaseOrgReviewSlotMock,
}));
vi.mock('../services/redis', () => ({ getBullMQConnection: () => ({ host: 'mock' }) }));
vi.mock('../services/sentry', () => ({ captureException: shared.captureExceptionMock }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: shared.attachWorkerObservabilityMock }));

import { ProposalNotReviewableError } from '../services/scriptProposals/reviewer';
import { initializeScriptReviewWorker, processScriptReviewJob, shutdownScriptReviewWorker } from './scriptReviewWorker';

function job(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-1',
    name: 'review',
    data: { proposalId: PROPOSAL_ID, orgId: ORG_ID, attempt: 1 },
    moveToDelayed: vi.fn<(timestamp: number, token: string) => Promise<void>>(async () => undefined),
    ...overrides,
  };
}

describe('processScriptReviewJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    shared.tryAcquireOrgReviewSlotMock.mockResolvedValue(true);
  });

  it('runs the review when a concurrency slot is available, then releases it', async () => {
    shared.runScriptReviewMock.mockResolvedValueOnce({ id: 'review-1' });

    await processScriptReviewJob(job() as never, 'lock-token-1');

    expect(shared.tryAcquireOrgReviewSlotMock).toHaveBeenCalledWith(ORG_ID);
    expect(shared.runScriptReviewMock).toHaveBeenCalledWith({ proposalId: PROPOSAL_ID, orgId: ORG_ID, attempt: 1 });
    expect(shared.releaseOrgReviewSlotMock).toHaveBeenCalledWith(ORG_ID);
    expect(shared.tryAcquireOrgReviewSlotMock.mock.invocationCallOrder[0]!).toBeLessThan(
      shared.runScriptReviewMock.mock.invocationCallOrder[0]!,
    );
  });

  it('releases the slot even when runScriptReview throws (and the error propagates for BullMQ retry)', async () => {
    shared.runScriptReviewMock.mockRejectedValueOnce(new Error('db down'));

    await expect(processScriptReviewJob(job() as never, 'lock-token-1')).rejects.toThrow('db down');

    expect(shared.releaseOrgReviewSlotMock).toHaveBeenCalledWith(ORG_ID);
  });

  it('maps ProposalNotReviewableError to UnrecoverableError so BullMQ does not retry it', async () => {
    shared.runScriptReviewMock.mockRejectedValueOnce(new ProposalNotReviewableError('p', 'superseded'));

    await expect(processScriptReviewJob(job() as never, 'lock-token-1')).rejects.toMatchObject({ name: 'UnrecoverableError' });
    expect(shared.releaseOrgReviewSlotMock).toHaveBeenCalledWith(ORG_ID);
  });

  it('a release failure in finally never masks the try-block outcome (UnrecoverableError stays unrecoverable; success stays success)', async () => {
    shared.releaseOrgReviewSlotMock.mockRejectedValueOnce(new Error('redis reset'));
    shared.runScriptReviewMock.mockRejectedValueOnce(new ProposalNotReviewableError('p', 'expired'));
    await expect(processScriptReviewJob(job() as never, 'tok')).rejects.toMatchObject({ name: 'UnrecoverableError' });
    expect(shared.captureExceptionMock).toHaveBeenCalledWith(expect.objectContaining({ message: 'redis reset' }), undefined, expect.objectContaining({ service: 'scriptReviewWorker' }));

    shared.releaseOrgReviewSlotMock.mockRejectedValueOnce(new Error('redis reset'));
    shared.runScriptReviewMock.mockResolvedValueOnce({ id: 'review-2' });
    await expect(processScriptReviewJob(job() as never, 'tok')).resolves.toBeUndefined();
  });

  it('re-delays itself under its own lock token when the org is at its concurrency cap', async () => {
    shared.tryAcquireOrgReviewSlotMock.mockResolvedValueOnce(false);
    const theJob = job();
    const before = Date.now();

    await expect(processScriptReviewJob(theJob as never, 'lock-token-2')).rejects.toMatchObject({ name: 'DelayedError' });

    expect(theJob.moveToDelayed).toHaveBeenCalledTimes(1);
    const [timestamp, token] = theJob.moveToDelayed.mock.calls[0]!;
    expect(token).toBe('lock-token-2');
    expect(timestamp).toBeGreaterThanOrEqual(before);
    expect(shared.runScriptReviewMock).not.toHaveBeenCalled();
    // A slot that was never acquired is never released — otherwise the
    // counter would be manufactured downward and the cap would leak.
    expect(shared.releaseOrgReviewSlotMock).not.toHaveBeenCalled();
  });

  it('at the cap with no lock token: logs and does nothing further (only reachable via a direct test-harness call)', async () => {
    shared.tryAcquireOrgReviewSlotMock.mockResolvedValueOnce(false);
    const theJob = job();

    await expect(processScriptReviewJob(theJob as never)).resolves.toBeUndefined();

    expect(theJob.moveToDelayed).not.toHaveBeenCalled();
    expect(shared.runScriptReviewMock).not.toHaveBeenCalled();
  });

  it('rejects a job under the wrong name before touching the concurrency gate', async () => {
    await expect(processScriptReviewJob(job({ name: 'something-else' }) as never, 'tok')).rejects.toMatchObject({ name: 'UnrecoverableError' });
    expect(shared.tryAcquireOrgReviewSlotMock).not.toHaveBeenCalled();
  });

  it('rejects malformed job data before touching the concurrency gate', async () => {
    await expect(processScriptReviewJob(job({ data: { proposalId: 'not-a-uuid' } }) as never, 'tok')).rejects.toMatchObject({ name: 'UnrecoverableError' });
    expect(shared.tryAcquireOrgReviewSlotMock).not.toHaveBeenCalled();
  });
});

describe('initializeScriptReviewWorker / shutdownScriptReviewWorker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    shared.workerCtorArgs.length = 0;
  });

  it('constructs one Worker on the script-review queue with a lock longer than the 60 s model timeout, and attaches observability once', async () => {
    await initializeScriptReviewWorker();
    await initializeScriptReviewWorker(); // idempotent

    expect(shared.workerCtorArgs).toHaveLength(1);
    const [queueName, , opts] = shared.workerCtorArgs[0]! as [string, unknown, { concurrency: number; lockDuration: number }];
    expect(queueName).toBe('script-review');
    expect(opts.lockDuration).toBeGreaterThan(60_000);
    expect(opts.concurrency).toBeGreaterThanOrEqual(3);
    expect(shared.attachWorkerObservabilityMock).toHaveBeenCalledTimes(1);
    expect(shared.attachWorkerObservabilityMock).toHaveBeenCalledWith(expect.anything(), 'scriptReviewWorker');

    await shutdownScriptReviewWorker();
    expect(shared.workerCloseMock).toHaveBeenCalledTimes(1);

    // After shutdown a fresh init constructs a new Worker.
    await initializeScriptReviewWorker();
    expect(shared.workerCtorArgs).toHaveLength(2);
    await shutdownScriptReviewWorker();
  });
});
