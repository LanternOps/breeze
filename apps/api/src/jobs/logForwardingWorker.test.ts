import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getWaitingCountMock, addMock, closeMock } = vi.hoisted(() => ({
  getWaitingCountMock: vi.fn(),
  addMock: vi.fn(),
  closeMock: vi.fn(),
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
  },
  Job: class {},
  UnrecoverableError: class UnrecoverableError extends Error {},
}));

vi.mock('../services/redis', () => ({
  getRedisConnection: vi.fn(() => ({})),
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
  isBullMQAvailable: vi.fn(() => true),
}));

vi.mock('../services/logForwarding', () => ({
  bulkIndexEvents: vi.fn(),
  clearClientCache: vi.fn(),
}));

import { UnrecoverableError } from 'bullmq';
import {
  assertBulkDelivered,
  enqueueLogForwarding,
  shutdownLogForwardingWorker,
} from './logForwardingWorker';

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
    getWaitingCountMock.mockResolvedValue(0);
    addMock.mockResolvedValue({ id: 'queue-job-1' });
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
        rawData: { big: 'x'.repeat(20 * 1024) },
      })),
    });

    expect(addMock).toHaveBeenCalledTimes(1);
    const queued = addMock.mock.calls[0]?.[1];
    expect(queued.hostname).toHaveLength(255);
    expect(queued.events).toHaveLength(500);
    expect(queued.events[0]?.category).toHaveLength(256);
    expect(queued.events[0]?.level).toHaveLength(256);
    expect(queued.events[0]?.source).toHaveLength(256);
    expect(queued.events[0]?.message).toHaveLength(4096);
    expect(queued.events[0]?.rawData).toBeUndefined();
  });
});
