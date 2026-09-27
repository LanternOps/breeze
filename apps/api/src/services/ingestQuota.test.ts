import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Redis } from 'ioredis';
import { checkAndConsumeIngestQuota } from './ingestQuota';

describe('checkAndConsumeIngestQuota', () => {
  let mockRedis: Partial<Redis>;
  let mockMulti: {
    incrby: ReturnType<typeof vi.fn>;
    expire: ReturnType<typeof vi.fn>;
    exec: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockMulti = {
      incrby: vi.fn().mockReturnThis(),
      expire: vi.fn().mockReturnThis(),
      exec: vi.fn(),
    };
    mockRedis = {
      multi: vi.fn(() => mockMulti),
    } as unknown as Partial<Redis>;
  });

  it('allows a batch under both the row and byte budget', async () => {
    mockMulti.exec.mockResolvedValue([
      [null, 100], // rows incrby
      [null, 1],   // rows expire
      [null, 5000], // bytes incrby
      [null, 1],   // bytes expire
    ]);

    const result = await checkAndConsumeIngestQuota({
      redis: mockRedis as Redis,
      prefix: 'agent_logs',
      scope: 'device',
      id: 'device-1',
      rows: 100,
      bytes: 5000,
      maxRows: 1000,
      maxBytes: 100_000,
    });

    expect(result).toEqual({ allowed: true, rowsUsed: 100, bytesUsed: 5000 });
  });

  it('refuses once the row budget is exceeded even if bytes are fine', async () => {
    mockMulti.exec.mockResolvedValue([
      [null, 1200], // over the 1000 row cap
      [null, 1],
      [null, 5000],
      [null, 1],
    ]);

    const result = await checkAndConsumeIngestQuota({
      redis: mockRedis as Redis,
      prefix: 'agent_logs',
      scope: 'device',
      id: 'device-1',
      rows: 200,
      bytes: 100,
      maxRows: 1000,
      maxBytes: 100_000,
    });

    expect(result.allowed).toBe(false);
    expect(result.rowsUsed).toBe(1200);
  });

  it('refuses once the byte budget is exceeded even if rows are fine', async () => {
    mockMulti.exec.mockResolvedValue([
      [null, 100],
      [null, 1],
      [null, 150_000], // over the 100,000 byte cap
      [null, 1],
    ]);

    const result = await checkAndConsumeIngestQuota({
      redis: mockRedis as Redis,
      prefix: 'agent_logs',
      scope: 'device',
      id: 'device-1',
      rows: 10,
      bytes: 50_000,
      maxRows: 1000,
      maxBytes: 100_000,
    });

    expect(result.allowed).toBe(false);
    expect(result.bytesUsed).toBe(150_000);
  });

  it('still consumes (increments) the counters on the overflowing request', async () => {
    mockMulti.exec.mockResolvedValue([
      [null, 1500],
      [null, 1],
      [null, 5000],
      [null, 1],
    ]);

    await checkAndConsumeIngestQuota({
      redis: mockRedis as Redis,
      prefix: 'agent_logs',
      scope: 'device',
      id: 'device-1',
      rows: 500,
      bytes: 1000,
      maxRows: 1000,
      maxBytes: 100_000,
    });

    expect(mockMulti.incrby).toHaveBeenCalledWith(expect.stringContaining('device-1'), 500);
  });

  it('fails open (allows, no throw) when Redis is unavailable', async () => {
    const result = await checkAndConsumeIngestQuota({
      redis: null,
      prefix: 'agent_logs',
      scope: 'device',
      id: 'device-1',
      rows: 1_000_000,
      bytes: 1_000_000_000,
      maxRows: 1000,
      maxBytes: 100_000,
    });

    expect(result.allowed).toBe(true);
  });

  it('fails open when the Redis call itself throws', async () => {
    mockMulti.exec.mockRejectedValue(new Error('connection reset'));

    const result = await checkAndConsumeIngestQuota({
      redis: mockRedis as Redis,
      prefix: 'agent_logs',
      scope: 'device',
      id: 'device-1',
      rows: 100,
      bytes: 100,
      maxRows: 1000,
      maxBytes: 100_000,
    });

    expect(result.allowed).toBe(true);
  });

  it('scopes the key to org vs device so the two never collide', async () => {
    mockMulti.exec.mockResolvedValue([[null, 1], [null, 1], [null, 1], [null, 1]]);

    await checkAndConsumeIngestQuota({
      redis: mockRedis as Redis,
      prefix: 'agent_logs',
      scope: 'org',
      id: 'same-id',
      rows: 1,
      bytes: 1,
      maxRows: 1000,
      maxBytes: 100_000,
    });

    expect(mockMulti.incrby).toHaveBeenCalledWith(expect.stringContaining(':org:same-id:'), 1);
  });
});
