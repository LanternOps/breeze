import { beforeEach, describe, expect, it, vi } from 'vitest';

const redis = {
  incr: vi.fn(async (_k: string) => 1),
  expire: vi.fn(async (_k: string, _s: number) => 1),
  mget: vi.fn(async (..._k: string[]) => [] as Array<string | null>),
};
let redisAvailable: 'ok' | 'null' | 'throws' = 'ok';
vi.mock('../redis', () => ({
  getRedis: vi.fn(() => {
    if (redisAvailable === 'throws') throw new Error('redis not configured');
    return redisAvailable === 'null' ? null : redis;
  }),
}));

import {
  readRefreshRetryCounts,
  recordRefreshRetry,
  retryCounterKey,
  retryingDetail,
  RETRY_COUNTER_TTL_S,
} from './oauthRetryCounter';

const NOW = new Date('2026-10-17T23:59:00Z');
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.clearAllMocks();
  redisAvailable = 'ok';
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('oauth retry counter', () => {
  it('keys by client and UTC day', () => {
    expect(retryCounterKey('client-a', NOW)).toBe('connection-health:oauth-retry:client-a:2026-10-17');
  });

  it('increments and (re)sets the TTL on every hit, so one lost EXPIRE cannot leave a key without one', async () => {
    recordRefreshRetry('client-a', NOW);
    await flush();
    expect(redis.incr).toHaveBeenCalledWith('connection-health:oauth-retry:client-a:2026-10-17');
    expect(redis.expire).toHaveBeenCalledWith('connection-health:oauth-retry:client-a:2026-10-17', RETRY_COUNTER_TTL_S);
    redis.incr.mockResolvedValueOnce(7);
    recordRefreshRetry('client-a', NOW);
    await flush();
    expect(redis.expire).toHaveBeenCalledTimes(2);
  });

  it('throttles warnings per operation, so an incr failure does not hide an mget failure', async () => {
    const warn = vi.mocked(console.warn);
    warn.mockClear();
    redis.incr.mockRejectedValueOnce(new Error('incr down'));
    recordRefreshRetry('c', NOW);
    await flush();
    redis.mget.mockRejectedValueOnce(new Error('mget down'));
    await readRefreshRetryCounts(['c'], NOW);
    const text = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(text).toContain('incr down');
    expect(text).toContain('mget down');
  });

  it('returns synchronously and never throws, whatever Redis does', async () => {
    redisAvailable = 'throws';
    expect(recordRefreshRetry('c', NOW)).toBeUndefined();
    redisAvailable = 'null';
    expect(recordRefreshRetry('c', NOW)).toBeUndefined();
    redisAvailable = 'ok';
    redis.incr.mockRejectedValueOnce(new Error('connection reset'));
    expect(recordRefreshRetry('c', NOW)).toBeUndefined();
    await flush();
  });

  it('reads today\'s counts for the given clients in one MGET', async () => {
    redis.mget.mockResolvedValueOnce(['12', null]);
    const counts = await readRefreshRetryCounts(['client-a', 'client-b', 'client-a'], NOW);
    expect(redis.mget).toHaveBeenCalledWith(
      'connection-health:oauth-retry:client-a:2026-10-17',
      'connection-health:oauth-retry:client-b:2026-10-17',
    );
    expect([...counts]).toEqual([['client-a', 12]]);
  });

  it('degrades to no counts when Redis is missing, failing, or slow', async () => {
    redisAvailable = 'null';
    expect((await readRefreshRetryCounts(['a'], NOW)).size).toBe(0);
    redisAvailable = 'ok';
    redis.mget.mockRejectedValueOnce(new Error('down'));
    expect((await readRefreshRetryCounts(['a'], NOW)).size).toBe(0);
    redis.mget.mockImplementationOnce(() => new Promise(() => {}));
    expect((await readRefreshRetryCounts(['a'], NOW, 10)).size).toBe(0);
    expect((await readRefreshRetryCounts([], NOW)).size).toBe(0);
  });

  it('formats the detail, and none for zero', () => {
    expect(retryingDetail(1)).toBe('The app keeps retrying its revoked token (1 failed refresh today, UTC).');
    expect(retryingDetail(740)).toBe('The app keeps retrying its revoked token (740 failed refreshes today, UTC).');
    expect(retryingDetail(0)).toBeNull();
  });
});
