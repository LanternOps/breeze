import { beforeEach, describe, expect, it, vi } from 'vitest';

const { executeMock, updateMock, addMock, closeMock, recordBacklogMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  updateMock: vi.fn(),
  addMock: vi.fn(),
  closeMock: vi.fn(),
  recordBacklogMock: vi.fn(),
}));

vi.mock('bullmq', () => ({
  Queue: class {},
  Worker: class {},
  Job: class {},
}));

// Real AsyncLocalStorage-backed context tracking — same #1105 regression
// guard as intentOutboxPublisher.test.ts: an identity-passthrough mock could
// never prove the enqueue loop runs outside a held DB context.
vi.mock('../db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db')>();
  const { AsyncLocalStorage } = await import('node:async_hooks');
  const contextStorage = new AsyncLocalStorage<true>();

  const hasDbAccessContext = (): boolean => contextStorage.getStore() !== undefined;

  const withSystemDbAccessContext = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (contextStorage.getStore()) return fn();
    return contextStorage.run(true, fn);
  };

  const runOutsideDbContext = <T>(fn: () => T): T => contextStorage.exit(fn);

  return {
    ...actual,
    db: {
      ...actual.db,
      execute: (...args: unknown[]) => executeMock(...(args as [])),
      update: (...args: unknown[]) => updateMock(...(args as [])),
    },
    hasDbAccessContext,
    withSystemDbAccessContext,
    runOutsideDbContext,
  };
});

vi.mock('../services/redis', () => ({
  getRedisConnection: vi.fn(() => ({})),
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
  isBullMQAvailable: vi.fn(() => true),
}));

vi.mock('../services/bullmqQueue', () => ({
  createInstrumentedQueue: vi.fn(() => ({ add: addMock, close: closeMock })),
}));

vi.mock('../services/sentry', () => ({
  captureException: vi.fn(),
}));

vi.mock('../services/aiOperatorOutboxMetrics', () => ({
  recordAiOperatorOutboxBacklog: recordBacklogMock,
}));

import { publishAiOperatorTaskOutbox } from './aiOperatorTaskOutboxPublisher';
import { captureException } from '../services/sentry';
import * as dbModule from '../db';

function makeUpdateChain(returningValue: unknown = undefined) {
  const where = vi.fn(() => Promise.resolve(returningValue));
  const set = vi.fn(() => ({ where }));
  return { set, where };
}

describe('aiOperatorTaskOutboxPublisher.publishAiOperatorTaskOutbox', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    addMock.mockResolvedValue({ id: 'bullmq-job-1' });
  });

  it('enqueues claimed rows with a hyphenated jobId, marks published, and records the backlog gauge', async () => {
    // Call 1: backlog scan.
    executeMock.mockResolvedValueOnce({ rows: [{ unpublished_count: 3, oldest_age_seconds: 42 }] });
    // Call 2: claim query.
    executeMock.mockResolvedValueOnce({
      rows: [
        {
          id: 1,
          org_id: 'org-1',
          task_id: 'task-1',
          source_kind: 'intent',
          source_id: 'intent-1',
          transition_seq: 1,
        },
      ],
    });

    const chain = makeUpdateChain();
    updateMock.mockReturnValue({ set: chain.set });

    const result = await publishAiOperatorTaskOutbox();

    expect(result).toEqual({ published: 1 });
    expect(recordBacklogMock).toHaveBeenCalledWith(3, 42);
    expect(addMock).toHaveBeenCalledTimes(1);
    expect(addMock).toHaveBeenCalledWith(
      'task-wake',
      { v: 1, orgId: 'org-1', taskId: 'task-1', sourceKind: 'intent', sourceId: 'intent-1', transitionSeq: 1 },
      expect.objectContaining({ jobId: 'task-wake-org-1-task-1-intent-intent-1-1' }),
    );
    const jobId = (addMock.mock.calls[0] as unknown[])[2] as { jobId: string };
    expect(jobId.jobId).not.toContain(':');

    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(chain.set).toHaveBeenCalledTimes(1);
    expect(chain.where).toHaveBeenCalledTimes(1);
  });

  it('an empty backlog records zero/zero and enqueues nothing', async () => {
    executeMock.mockResolvedValueOnce({ rows: [{ unpublished_count: 0, oldest_age_seconds: 0 }] });
    executeMock.mockResolvedValueOnce({ rows: [] });

    const result = await publishAiOperatorTaskOutbox();

    expect(result).toEqual({ published: 0 });
    expect(recordBacklogMock).toHaveBeenCalledWith(0, 0);
    expect(addMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('leaves published_at unset and does not crash when enqueue fails (retried next tick)', async () => {
    executeMock.mockResolvedValueOnce({ rows: [{ unpublished_count: 1, oldest_age_seconds: 5 }] });
    executeMock.mockResolvedValueOnce({
      rows: [
        {
          id: 2,
          org_id: 'org-1',
          task_id: 'task-2',
          source_kind: 'intent',
          source_id: 'intent-2',
          transition_seq: 2,
        },
      ],
    });
    addMock.mockRejectedValueOnce(new Error('redis unavailable'));

    const result = await publishAiOperatorTaskOutbox();

    expect(result).toEqual({ published: 0 });
    expect(updateMock).not.toHaveBeenCalled();
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  // #1105 regression: the enqueue loop must run OUTSIDE any DB access
  // context — the claim transaction must close before queue.add() runs.
  it('releases the DB access context before enqueueing — #1105', async () => {
    executeMock.mockResolvedValueOnce({ rows: [{ unpublished_count: 1, oldest_age_seconds: 1 }] });
    executeMock.mockResolvedValueOnce({
      rows: [
        {
          id: 3,
          org_id: 'org-1',
          task_id: 'task-3',
          source_kind: 'intent',
          source_id: 'intent-3',
          transition_seq: 1,
        },
      ],
    });
    const chain = makeUpdateChain();
    updateMock.mockReturnValue({ set: chain.set });

    let sawContextDuringEnqueue: boolean | undefined;
    addMock.mockImplementation(async () => {
      sawContextDuringEnqueue = dbModule.hasDbAccessContext();
      return { id: 'bullmq-job-3' };
    });

    const result = await publishAiOperatorTaskOutbox();

    expect(result).toEqual({ published: 1 });
    expect(sawContextDuringEnqueue).toBe(false);
    expect(dbModule.hasDbAccessContext()).toBe(false);
  });
});
