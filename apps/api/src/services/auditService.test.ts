import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * These tests use `vi.resetModules()` + `vi.doMock(...)` so each test gets a
 * fresh module instance with its own retry queue. Mocks must be set up BEFORE
 * the dynamic `import('./auditService')` call inside each test.
 *
 * We mock:
 *   - `../db` to stub the Drizzle insert chain (`db.insert(...).values(...)`).
 *   - `../db/schema` because the real schema barrel pulls in every table
 *     definition and is slow / unnecessary for these tests.
 *   - `./sentry` (the in-house wrapper) to assert Sentry capture happens on
 *     retry exhaustion and queue-full drops.
 */

function buildDbMock(persistBehavior: () => Promise<unknown>) {
  return {
    db: {
      insert: vi.fn(() => ({
        values: vi.fn(async () => persistBehavior()),
      })),
    },
    withSystemDbAccessContext: (fn: () => Promise<unknown>) => fn(),
    runOutsideDbContext: (fn: () => unknown) => fn(),
  };
}

function mockSchema() {
  vi.doMock('../db/schema', () => ({ auditLogs: {} }));
}

describe('audit write retry queue', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('queues a failed write and drains it successfully on retry', async () => {
    let calls = 0;
    vi.doMock('../db', () =>
      buildDbMock(async () => {
        calls++;
        if (calls === 1) throw new Error('boom');
        return undefined;
      })
    );
    mockSchema();
    vi.doMock('./sentry', () => ({ captureException: vi.fn() }));

    const { createAuditLogAsync, drainAuditRetryQueue, _resetRetryQueueForTest } =
      await import('./auditService');

    _resetRetryQueueForTest();

    await createAuditLogAsync({
      actorType: 'system',
      actorId: '00000000-0000-0000-0000-000000000001',
      action: 'test.retry',
      resourceType: 'test',
      result: 'success',
    });

    // First attempt failed → entry queued. Force-drain with a `nowMs` past
    // the initial 5s backoff window so the retry actually runs.
    const stats = await drainAuditRetryQueue({ nowMs: Date.now() + 60_000 });
    expect(stats.attempted).toBe(1);
    expect(stats.successful).toBe(1);
    expect(stats.dropped).toBe(0);
    expect(calls).toBe(2);
  });

  it('drops entries after MAX_ATTEMPTS and captures via Sentry', async () => {
    vi.doMock('../db', () =>
      buildDbMock(async () => {
        throw new Error('persistent failure');
      })
    );
    mockSchema();
    const sentryCapture = vi.fn();
    vi.doMock('./sentry', () => ({ captureException: sentryCapture }));

    const { createAuditLogAsync, drainAuditRetryQueue, _resetRetryQueueForTest } =
      await import('./auditService');

    _resetRetryQueueForTest();

    await createAuditLogAsync({
      actorType: 'system',
      actorId: '00000000-0000-0000-0000-000000000002',
      action: 'test.persistent',
      resourceType: 'test',
      result: 'success',
    });

    // The initial write failed → queued (attempts=1). MAX_ATTEMPTS=3, so two
    // more failed drains exhaust and drop. Advance `nowMs` past each
    // exponential-backoff window so every drain actually retries instead of
    // skipping on `nextAt > now`. Extra drains past exhaustion are no-ops.
    let t = Date.now() + 60_000; // start well past any initial backoff
    for (let i = 0; i < 5; i++) {
      await drainAuditRetryQueue({ nowMs: t });
      t += 10 * 60 * 1000; // jump 10 minutes per drain — well past 5s*2^n
    }
    expect(sentryCapture).toHaveBeenCalledTimes(1);
  });

  it('does not block the caller when the queue is full', async () => {
    vi.doMock('../db', () =>
      buildDbMock(async () => {
        throw new Error('boom');
      })
    );
    mockSchema();
    vi.doMock('./sentry', () => ({ captureException: vi.fn() }));

    const { createAuditLogAsync, _resetRetryQueueForTest } = await import(
      './auditService'
    );
    _resetRetryQueueForTest();

    const start = Date.now();
    for (let i = 0; i < 10_005; i++) {
      await createAuditLogAsync({
        actorType: 'system',
        actorId: `00000000-0000-0000-0000-${i.toString().padStart(12, '0')}`,
        action: 'test.fill',
        resourceType: 'test',
        result: 'success',
      });
    }
    // Must finish well under 10s even with persistent failures — the queue
    // caps at MAX_QUEUE and we don't await retries inline.
    expect(Date.now() - start).toBeLessThan(10_000);
  });
});
