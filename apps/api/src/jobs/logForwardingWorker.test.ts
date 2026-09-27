import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { processorRef, callOrder, dbDepth } = vi.hoisted(() => ({
  processorRef: { current: null as null | ((job: any) => Promise<unknown>) },
  callOrder: [] as string[],
  dbDepth: { value: 0 },
}));

const { getWaitingCountMock, addMock, closeMock, redisIncrMock, redisDecrMock, redisExpireMock, redisSetMock } = vi.hoisted(() => ({
  getWaitingCountMock: vi.fn(),
  addMock: vi.fn(),
  closeMock: vi.fn(),
  redisIncrMock: vi.fn(),
  redisDecrMock: vi.fn(),
  redisExpireMock: vi.fn(),
  redisSetMock: vi.fn(),
}));

vi.mock('bullmq', () => ({
  Queue: class {
    getWaitingCount = getWaitingCountMock;
    add = addMock;
    close = closeMock;
  },
  Worker: class {
    close = closeMock;
    on = vi.fn();
    constructor(_name: string, processor: (job: any) => Promise<unknown>) {
      processorRef.current = processor;
    }
  },
  Job: class {},
  UnrecoverableError: class UnrecoverableError extends Error {},
}));

vi.mock('../services/redis', () => ({
  getRedisConnection: vi.fn(() => ({})),
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
  isBullMQAvailable: vi.fn(() => true),
  // Per-org pending counter, mocked to a permissive default (org gate never
  // fires) so existing behavioral tests are unaffected; dedicated tests below
  // override these to exercise the gate itself.
  getRedis: vi.fn(() => ({
    incr: redisIncrMock,
    decr: redisDecrMock,
    expire: redisExpireMock,
    set: redisSetMock,
  })),
}));

// Records whether a DB context is open at the moment each step runs, so the
// processor tests can assert the outbound send never happens inside one.
vi.mock('../db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db')>()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => {
    dbDepth.value += 1;
    callOrder.push('db:enter');
    try {
      return await fn();
    } finally {
      dbDepth.value -= 1;
      callOrder.push('db:exit');
    }
  }),
}));

vi.mock('../services/logForwarding', () => {
  const config = { enabled: true, elasticsearchUrl: 'https://sink.example', indexPrefix: 'breeze-logs' };
  const readConfig = vi.fn(async (_orgId: string) => {
    callOrder.push(`config:read@depth${dbDepth.value}`);
    return config;
  });
  const send = vi.fn(async (_config: unknown, docs: unknown[]) => {
    callOrder.push(`network:send@depth${dbDepth.value}`);
    return { indexed: docs.length, errors: 0 };
  });
  return {
    getOrgForwardingConfig: readConfig,
    bulkIndexToEndpoint: send,
    // Combined read-then-send helper, same observable steps as the two above.
    bulkIndexEvents: vi.fn(async (orgId: string, docs: unknown[]) => {
      const cfg = await readConfig(orgId);
      if (!cfg) return { indexed: 0, errors: 0 };
      return send(cfg, docs);
    }),
    clearClientCache: vi.fn(),
  };
});

import { UnrecoverableError } from 'bullmq';
import {
  assertBulkDelivered,
  enqueueLogForwarding,
  initializeLogForwardingWorker,
  shutdownLogForwardingWorker,
} from './logForwardingWorker';
import { bulkIndexToEndpoint, getOrgForwardingConfig } from '../services/logForwarding';

const ctx = { deviceId: 'd1', orgId: 'o1' };

describe('assertBulkDelivered', () => {
  it('throws UnrecoverableError when the whole batch was dropped (terminal, no retry)', () => {
    expect(() => assertBulkDelivered({ indexed: 0, errors: 5 }, ctx)).toThrow(UnrecoverableError);
  });

  it('does not throw on full success', () => {
    expect(() => assertBulkDelivered({ indexed: 5, errors: 0 }, ctx)).not.toThrow();
  });

  it('does not throw on partial success (some indexed, some poison)', () => {
    expect(() => assertBulkDelivered({ indexed: 3, errors: 2 }, ctx)).not.toThrow();
  });

  it('does not throw on an empty/no-op result', () => {
    expect(() => assertBulkDelivered({ indexed: 0, errors: 0 }, ctx)).not.toThrow();
  });
});

describe('enqueueLogForwarding', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-31T12:00:00.000Z'));
    getWaitingCountMock.mockReset();
    addMock.mockReset();
    closeMock.mockReset();
    redisIncrMock.mockReset();
    redisDecrMock.mockReset();
    redisExpireMock.mockReset();
    redisSetMock.mockReset();
    getWaitingCountMock.mockResolvedValue(0);
    addMock.mockResolvedValue({ id: 'queue-job-1' });
    // Default: well under the per-org cap, so the gate never fires unless a
    // test explicitly arms a higher value.
    redisIncrMock.mockResolvedValue(1);
    redisDecrMock.mockResolvedValue(0);
    redisExpireMock.mockResolvedValue(1);
    redisSetMock.mockResolvedValue('OK');
    await shutdownLogForwardingWorker();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('caps forwarded event count and trims oversized fields', async () => {
    await enqueueLogForwarding({
      orgId: 'org-1',
      deviceId: 'device-1',
      hostname: 'h'.repeat(400),
      events: Array.from({ length: 600 }, () => ({
        category: 'c'.repeat(400),
        level: 'l'.repeat(400),
        source: 's'.repeat(400),
        message: 'm'.repeat(5000),
        timestamp: '2026-03-31T12:00:00.000Z',
        details: { big: 'x'.repeat(20 * 1024) },
      })),
    });

    expect(addMock).toHaveBeenCalledTimes(1);
    const queued = addMock.mock.calls[0]?.[1];
    expect(queued.hostname).toHaveLength(255);
    // The per-field caps alone still allow ~5KB/event even after truncation
    // (256*3 + 4096 + timestamp), so the total-job-byte cap
    // (MAX_LOG_FORWARDING_JOB_BYTES, 1MB default) truncates the 500-event
    // batch well before the per-count cap does.
    expect(queued.events.length).toBeGreaterThan(0);
    expect(queued.events.length).toBeLessThan(500);
    const totalBytes = queued.events.reduce(
      (sum: number, event: unknown) => sum + Buffer.byteLength(JSON.stringify(event), 'utf-8'),
      0,
    );
    expect(totalBytes).toBeLessThanOrEqual(1_048_576);
    expect(queued.events[0]?.category).toHaveLength(256);
    expect(queued.events[0]?.level).toHaveLength(256);
    expect(queued.events[0]?.source).toHaveLength(256);
    expect(queued.events[0]?.message).toHaveLength(4096);
    // Oversized details (>16KB serialized) is dropped rather than forwarded.
    expect(queued.events[0]?.details).toBeUndefined();
  });

  it('always keeps at least one event even when a single event alone exceeds the job-byte cap', async () => {
    await enqueueLogForwarding({
      orgId: 'org-1',
      deviceId: 'device-1',
      hostname: 'host-1',
      events: [{
        category: 'c',
        level: 'l',
        source: 's',
        message: 'm'.repeat(4096),
        timestamp: '2026-03-31T12:00:00.000Z',
      }],
    });

    const queued = addMock.mock.calls[0]?.[1];
    expect(queued.events).toHaveLength(1);
  });

  it('forwards in-bound details unchanged', async () => {
    await enqueueLogForwarding({
      orgId: 'org-1',
      deviceId: 'device-1',
      hostname: 'host-1',
      events: [
        {
          category: 'security',
          level: 'warning',
          source: 'auth',
          message: 'failed logon',
          timestamp: '2026-03-31T12:00:00.000Z',
          details: { user: 'alice', attempts: 3 },
        },
      ],
    });

    expect(addMock).toHaveBeenCalledTimes(1);
    const queued = addMock.mock.calls[0]?.[1];
    expect(queued.events[0]?.details).toEqual({ user: 'alice', attempts: 3 });
  });

  function makeEvent() {
    return {
      category: 'security',
      level: 'warning',
      source: 'auth',
      message: 'failed logon',
      timestamp: '2026-03-31T12:00:00.000Z',
    };
  }

  it('skips enqueue for ONE over-budget org while the queue is otherwise healthy', async () => {
    redisIncrMock.mockResolvedValue(2001); // over the 2000 default per-org cap

    await enqueueLogForwarding({ orgId: 'org-noisy', deviceId: 'device-1', hostname: 'h', events: [makeEvent()] });

    expect(addMock).not.toHaveBeenCalled();
    // The over-cap slot is released so a rejected request doesn't hold budget.
    expect(redisDecrMock).toHaveBeenCalled();
    // The global waiting-count circuit breaker is a SEPARATE, lower-priority
    // check — an org-gated request never needs to reach it.
    expect(getWaitingCountMock).not.toHaveBeenCalled();
  });

  it('still enqueues for a healthy org even when the global queue depth is high but under the breaker', async () => {
    redisIncrMock.mockResolvedValue(5); // this org is nowhere near its own cap
    getWaitingCountMock.mockResolvedValue(9000); // busy, but under the 10k global breaker

    await enqueueLogForwarding({ orgId: 'org-quiet', deviceId: 'device-1', hostname: 'h', events: [makeEvent()] });

    expect(addMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to the global circuit breaker when genuinely saturated instance-wide', async () => {
    redisIncrMock.mockResolvedValue(5); // this org itself is fine
    getWaitingCountMock.mockResolvedValue(10001);

    await enqueueLogForwarding({ orgId: 'org-quiet', deviceId: 'device-1', hostname: 'h', events: [makeEvent()] });

    expect(addMock).not.toHaveBeenCalled();
    expect(redisDecrMock).toHaveBeenCalled(); // releases the slot it had provisionally taken
  });

  it('does not block enqueue when Redis is unavailable (fails open on the org gate)', async () => {
    const { getRedis } = await import('../services/redis');
    vi.mocked(getRedis).mockReturnValueOnce(null as never);

    await enqueueLogForwarding({ orgId: 'org-1', deviceId: 'device-1', hostname: 'h', events: [makeEvent()] });

    expect(addMock).toHaveBeenCalledTimes(1);
  });
});

describe('log forwarding worker processor', () => {
  const event = (i: number) => ({
    category: 'system',
    level: 'error',
    source: 'svc',
    message: `m${i}`,
    timestamp: '2026-01-01T00:00:00.000Z',
  });

  beforeEach(async () => {
    callOrder.length = 0;
    dbDepth.value = 0;
    processorRef.current = null;
    await initializeLogForwardingWorker();
  });

  afterEach(async () => {
    await shutdownLogForwardingWorker();
  });

  it('reads the forwarding config in a DB context and sends with no DB context held', async () => {
    const result = await processorRef.current!({
      data: { orgId: 'org-1', deviceId: 'device-1', hostname: 'h', events: [event(1)] },
    });

    expect(result).toEqual({ indexed: 1, errors: 0 });
    expect(callOrder).toContain('config:read@depth1');
    const sends = callOrder.filter((e) => e.startsWith('network:send'));
    expect(sends).toEqual(['network:send@depth0']);
    expect(callOrder.indexOf('network:send@depth0')).toBeGreaterThan(callOrder.lastIndexOf('db:exit'));
  });

  it('sends nothing when forwarding is not configured', async () => {
    vi.mocked(getOrgForwardingConfig).mockResolvedValueOnce(null);

    const result = await processorRef.current!({
      data: { orgId: 'org-1', deviceId: 'device-1', hostname: 'h', events: [event(1)] },
    });

    expect(result).toEqual({ indexed: 0, errors: 0 });
    expect(callOrder.filter((e) => e.startsWith('network:send'))).toEqual([]);
  });

  it('bounds the documents sent per job even when the stored job is larger', async () => {
    const events = Array.from({ length: 800 }, (_, i) => event(i));

    await processorRef.current!({
      data: { orgId: 'org-1', deviceId: 'device-1', hostname: 'h', events },
    });

    const sent = vi.mocked(bulkIndexToEndpoint).mock.calls.at(-1)?.[1] as unknown[];
    expect(sent).toHaveLength(500);
  });

  it('still fails the job without retry when the whole batch is dropped', async () => {
    vi.mocked(bulkIndexToEndpoint).mockImplementationOnce(async () => {
      callOrder.push(`network:send@depth${dbDepth.value}`);
      return { indexed: 0, errors: 1 };
    });

    await expect(processorRef.current!({
      data: { orgId: 'org-1', deviceId: 'device-1', hostname: 'h', events: [event(1)] },
    })).rejects.toBeInstanceOf(UnrecoverableError);
  });
});
