import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const redisState: {
  store: Map<string, string>;
  client: {
    set: ReturnType<typeof vi.fn>;
    eval: ReturnType<typeof vi.fn>;
    pexpire: ReturnType<typeof vi.fn>;
  } | null;
} = { store: new Map(), client: null };

vi.mock('./redis', () => ({
  getRedis: vi.fn(() => redisState.client),
}));

import {
  claimConsumeOnce,
  consumeDispatchedExpectation,
  recordDispatchedExpectation,
  refreshDispatchedExpectation,
} from './agentWorkExpectation';

function buildRedisClient() {
  redisState.store = new Map();
  return {
    // ioredis-style: set(key, val, 'EX', ttl[, 'NX']) → 'OK' | null
    set: vi.fn(async (key: string, val: string, ..._args: unknown[]) => {
      const nx = _args.includes('NX');
      if (nx && redisState.store.has(key)) {
        return null;
      }
      redisState.store.set(key, val);
      return 'OK';
    }),
    // ioredis-style: eval(lua, numKeys, key, ...) — we only use a GET+DEL atomic check.
    eval: vi.fn(async (_lua: string, _numKeys: number, key: string) => {
      if (redisState.store.has(key)) {
        redisState.store.delete(key);
        return 1;
      }
      return 0;
    }),
    // ioredis-style: pexpire(key, ms) → 1 if the key exists (TTL reset), 0 if it
    // doesn't. The in-memory store carries no TTL, so we only model existence.
    pexpire: vi.fn(async (key: string, _ms: number) => {
      return redisState.store.has(key) ? 1 : 0;
    }),
  };
}

beforeEach(() => {
  redisState.client = buildRedisClient();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('claimConsumeOnce (F5 derived-expectation consume-once)', () => {
  it('first claim succeeds, replay of same tuple fails', async () => {
    const first = await claimConsumeOnce('vault_sync', 'device-1', 'snap-1:vault-1');
    expect(first.ok).toBe(true);

    const replay = await claimConsumeOnce('vault_sync', 'device-1', 'snap-1:vault-1');
    expect(replay.ok).toBe(false);
  });

  it('different tuples are independent', async () => {
    expect((await claimConsumeOnce('vault_sync', 'device-1', 'snap-1:vault-1')).ok).toBe(true);
    expect((await claimConsumeOnce('vault_sync', 'device-1', 'snap-2:vault-1')).ok).toBe(true);
    expect((await claimConsumeOnce('vault_sync', 'device-2', 'snap-1:vault-1')).ok).toBe(true);
  });

  it('fails closed when Redis is unavailable', async () => {
    redisState.client = null;
    const result = await claimConsumeOnce('vault_sync', 'device-1', 'snap-1:vault-1');
    expect(result.ok).toBe(false);
  });

  it('fails closed when Redis throws', async () => {
    redisState.client!.set.mockRejectedValueOnce(new Error('connection reset'));
    const result = await claimConsumeOnce('vault_sync', 'device-1', 'snap-1:vault-1');
    expect(result.ok).toBe(false);
  });
});

describe('record/consume dispatched expectation (F6 dispatch-bound)', () => {
  it('a recorded expectation can be consumed exactly once', async () => {
    await recordDispatchedExpectation('backup', 'device-1', 'job-1');

    const first = await consumeDispatchedExpectation('backup', 'device-1', 'job-1');
    expect(first.ok).toBe(true);

    const replay = await consumeDispatchedExpectation('backup', 'device-1', 'job-1');
    expect(replay.ok).toBe(false);
  });

  it('rejects a never-dispatched expectation', async () => {
    const result = await consumeDispatchedExpectation('backup', 'device-1', 'never-dispatched');
    expect(result.ok).toBe(false);
  });

  it('scopes the expectation to the device that was dispatched', async () => {
    await recordDispatchedExpectation('backup', 'device-1', 'job-1');
    // A different device cannot consume device-1's expectation.
    const wrongDevice = await consumeDispatchedExpectation('backup', 'device-2', 'job-1');
    expect(wrongDevice.ok).toBe(false);
    // The legitimate device still can.
    const rightDevice = await consumeDispatchedExpectation('backup', 'device-1', 'job-1');
    expect(rightDevice.ok).toBe(true);
  });

  it('consume fails closed when Redis is unavailable', async () => {
    redisState.client = null;
    const result = await consumeDispatchedExpectation('backup', 'device-1', 'job-1');
    expect(result.ok).toBe(false);
  });

  it('consume fails closed when Redis throws', async () => {
    await recordDispatchedExpectation('backup', 'device-1', 'job-1');
    redisState.client!.eval.mockRejectedValueOnce(new Error('connection reset'));
    const result = await consumeDispatchedExpectation('backup', 'device-1', 'job-1');
    expect(result.ok).toBe(false);
  });

  it('record is best-effort and does not throw when Redis is unavailable', async () => {
    redisState.client = null;
    await expect(recordDispatchedExpectation('backup', 'device-1', 'job-1')).resolves.toBeUndefined();
  });
});

describe('refreshDispatchedExpectation (non-terminal TTL refresh — progress pings / started-acks)', () => {
  const TTL_SECONDS = 24 * 60 * 60;

  it('refreshes an existing expectation, returning true and calling PEXPIRE with the TTL in MILLISECONDS', async () => {
    await recordDispatchedExpectation('backup', 'device-1', 'job-1');

    const refreshed = await refreshDispatchedExpectation('backup', 'device-1', 'job-1');

    expect(refreshed).toBe(true);
    // A bug converting seconds→ms wrong (or forgetting *1000) would expire a
    // multi-hour backup's dispatch expectation mid-run, so the genuine terminal
    // result is later dropped as a "replay" (data loss). Pin the ms value.
    expect(redisState.client!.pexpire).toHaveBeenCalledWith(
      'agent-work-expect:backup:device-1:job-1',
      TTL_SECONDS * 1000,
    );
  });

  it('does NOT create an expectation and returns false when none exists (iff-exists semantics)', async () => {
    const refreshed = await refreshDispatchedExpectation('backup', 'device-1', 'never-dispatched');
    expect(refreshed).toBe(false);
    // A subsequent consume must still fail-closed: the refresh must not have
    // conjured the key into existence.
    const consumed = await consumeDispatchedExpectation('backup', 'device-1', 'never-dispatched');
    expect(consumed.ok).toBe(false);
  });

  it('returns false (best-effort) when Redis is unavailable', async () => {
    redisState.client = null;
    await expect(refreshDispatchedExpectation('backup', 'device-1', 'job-1')).resolves.toBe(false);
  });

  it('returns false (best-effort) when PEXPIRE throws', async () => {
    await recordDispatchedExpectation('backup', 'device-1', 'job-1');
    redisState.client!.pexpire.mockRejectedValueOnce(new Error('connection reset'));
    await expect(refreshDispatchedExpectation('backup', 'device-1', 'job-1')).resolves.toBe(false);
  });
});
