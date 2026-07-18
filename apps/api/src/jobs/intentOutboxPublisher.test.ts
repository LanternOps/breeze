import { beforeEach, describe, expect, it, vi } from 'vitest';

const { executeMock, updateMock, addMock, closeMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  updateMock: vi.fn(),
  addMock: vi.fn(),
  closeMock: vi.fn(),
}));

vi.mock('bullmq', () => ({
  Queue: class {},
  Worker: class {},
  Job: class {},
}));

vi.mock('../db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db')>();
  return {
    ...actual,
    db: {
      ...actual.db,
      execute: (...args: unknown[]) => executeMock(...(args as [])),
      update: (...args: unknown[]) => updateMock(...(args as [])),
    },
    withSystemDbAccessContext: async <T>(fn: () => Promise<T>) => fn(),
  };
});

vi.mock('../services/redis', () => ({
  getRedisConnection: vi.fn(() => ({})),
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
  isBullMQAvailable: vi.fn(() => true),
}));

vi.mock('../services/bullmqQueue', () => ({
  createInstrumentedQueue: vi.fn(() => ({
    add: addMock,
    close: closeMock,
  })),
}));

vi.mock('../services/sentry', () => ({
  captureException: vi.fn(),
}));

import { publishOutboxRows } from './intentOutboxPublisher';
import { captureException } from '../services/sentry';

function makeUpdateChain(returningValue: unknown = undefined) {
  const where = vi.fn(() => Promise.resolve(returningValue));
  const set = vi.fn(() => ({ where }));
  return { set, where };
}

describe('intentOutboxPublisher.publishOutboxRows', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    addMock.mockResolvedValue({ id: 'bullmq-job-1' });
  });

  it('enqueues claimed rows with hyphenated jobId, marks published, and increments attempts', async () => {
    // Call 1: stuck-row alarm scan — nothing stuck.
    executeMock.mockResolvedValueOnce({ rows: [] });
    // Call 2: claim query — one live row, attempts already bumped to 1 by the SQL.
    executeMock.mockResolvedValueOnce({
      rows: [
        {
          id: 1,
          intent_id: 'intent-1',
          event_type: 'intent_created',
          publish_attempts: 1,
        },
      ],
    });

    const chain = makeUpdateChain();
    updateMock.mockReturnValue({ set: chain.set });

    const result = await publishOutboxRows();

    expect(result).toEqual({ published: 1, skipped: 0 });
    expect(addMock).toHaveBeenCalledTimes(1);
    expect(addMock).toHaveBeenCalledWith(
      'intent_created',
      { intentId: 'intent-1', eventType: 'intent_created' },
      expect.objectContaining({ jobId: 'intent-intent_created-intent-1' }),
    );
    // jobId has no colons — BullMQ jobId rule.
    const jobId = (addMock.mock.calls[0] as unknown[])[2] as { jobId: string };
    expect(jobId.jobId).not.toContain(':');

    // published_at marked for the enqueued row.
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(chain.set).toHaveBeenCalledTimes(1);
    expect(chain.where).toHaveBeenCalledTimes(1);
  });

  it('skips rows with publish_attempts > 5: logs, captures, does not enqueue', async () => {
    // Call 1: stuck-row alarm scan finds one poisoned row.
    executeMock.mockResolvedValueOnce({
      rows: [
        {
          id: 2,
          intent_id: 'intent-2',
          event_type: 'intent_approved',
          publish_attempts: 6,
        },
      ],
    });
    // Call 2: claim query — nothing else live.
    executeMock.mockResolvedValueOnce({ rows: [] });

    const result = await publishOutboxRows();

    expect(result).toEqual({ published: 0, skipped: 1 });
    expect(addMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
    expect(captureException).toHaveBeenCalledTimes(1);
    const captured = (captureException as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Error;
    expect(captured.message).toContain('intent-2');
    expect(captured.message).toContain('6 publish attempts');
  });

  it('re-run does not double-enqueue already-published rows', async () => {
    // First run: one row claimed and published.
    executeMock.mockResolvedValueOnce({ rows: [] });
    executeMock.mockResolvedValueOnce({
      rows: [
        {
          id: 3,
          intent_id: 'intent-3',
          event_type: 'intent_created',
          publish_attempts: 1,
        },
      ],
    });
    const chain = makeUpdateChain();
    updateMock.mockReturnValue({ set: chain.set });

    const first = await publishOutboxRows();
    expect(first.published).toBe(1);
    expect(addMock).toHaveBeenCalledTimes(1);

    // Second run: the DB-level `published_at IS NULL` filter now excludes the
    // row, so both queries come back empty.
    executeMock.mockResolvedValueOnce({ rows: [] });
    executeMock.mockResolvedValueOnce({ rows: [] });

    const second = await publishOutboxRows();
    expect(second).toEqual({ published: 0, skipped: 0 });
    // Still only the one call from the first run.
    expect(addMock).toHaveBeenCalledTimes(1);
  });

  it('leaves published_at unset and does not crash when enqueue fails', async () => {
    executeMock.mockResolvedValueOnce({ rows: [] });
    executeMock.mockResolvedValueOnce({
      rows: [
        {
          id: 4,
          intent_id: 'intent-4',
          event_type: 'intent_created',
          publish_attempts: 2,
        },
      ],
    });
    addMock.mockRejectedValueOnce(new Error('redis unavailable'));

    const result = await publishOutboxRows();

    expect(result).toEqual({ published: 0, skipped: 0 });
    expect(updateMock).not.toHaveBeenCalled();
    expect(captureException).toHaveBeenCalledTimes(1);
  });
});
