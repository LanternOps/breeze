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

// Real AsyncLocalStorage-backed context tracking — NOT a bare identity
// pass-through. This is the #1105 regression the new test below exists to
// catch: an identity `withSystemDbAccessContext: fn => fn()` mock would make
// `hasDbAccessContext()` always report false and could never prove the
// enqueue loop runs outside a held DB context. Self-contained inside the
// factory (no outer-scope references) so vi.mock hoisting can't reorder it
// ahead of its dependencies.
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
import * as dbModule from '../db';

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

  // #1105 regression: publishOutboxRows must release its DB access context
  // before calling queue.add(). Previously the whole function (claim +
  // enqueue + mark-published) ran inside a single caller-provided
  // withSystemDbAccessContext, so this Redis round-trip pinned a pooled
  // Postgres connection idle-in-transaction on every claimed row, every 5s.
  // The `../db` mock above is a REAL AsyncLocalStorage-backed context
  // tracker (not an identity pass-through), so `hasDbAccessContext()` here
  // reflects the actual context boundary `publishOutboxRows` establishes —
  // a mock that stubbed `withSystemDbAccessContext` as `fn => fn()` could
  // never have caught this, because `hasDbAccessContext()` would report
  // false unconditionally regardless of where the enqueue actually ran.
  it('releases the DB access context before enqueueing — #1105', async () => {
    executeMock.mockResolvedValueOnce({ rows: [] });
    executeMock.mockResolvedValueOnce({
      rows: [
        {
          id: 5,
          intent_id: 'intent-5',
          event_type: 'intent_created',
          publish_attempts: 1,
        },
      ],
    });
    const chain = makeUpdateChain();
    updateMock.mockReturnValue({ set: chain.set });

    let sawContextDuringEnqueue: boolean | undefined;
    addMock.mockImplementation(async () => {
      sawContextDuringEnqueue = dbModule.hasDbAccessContext();
      return { id: 'bullmq-job-5' };
    });

    const result = await publishOutboxRows();

    expect(result).toEqual({ published: 1, skipped: 0 });
    expect(addMock).toHaveBeenCalledTimes(1);
    // The load-bearing assertion: queue.add() ran with NO DB access context
    // held. `false` here (not `undefined`) also proves the callback actually
    // ran and made the check, not just that it was skipped.
    expect(sawContextDuringEnqueue).toBe(false);
    // Sanity: the DB context helper itself is not held after the full pass
    // either — the claim and mark-published contexts both closed cleanly.
    expect(dbModule.hasDbAccessContext()).toBe(false);
  });
});
