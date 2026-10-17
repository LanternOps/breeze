import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DIGEST_HEARTBEAT_KEY,
  DIGEST_HEARTBEAT_TTL_S,
  kindStateKey,
  readConnectionHealthJobStatus,
  RECONCILE_HEARTBEAT_KEY,
  RECONCILE_HEARTBEAT_TTL_S,
  writeDigestHeartbeat,
  type HeartbeatRedis,
} from './heartbeat';

const NOW = new Date('2026-10-17T12:00:00.000Z');
const minAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

function fakeRedis(values: Record<string, string> = {}): HeartbeatRedis & { set: ReturnType<typeof vi.fn> } {
  return {
    mget: vi.fn(async (...keys: string[]) => keys.map((k) => values[k] ?? null)),
    set: vi.fn(async () => 'OK'),
  };
}

const kinds = [{ kind: 'oauth_grant', intervalMinutes: 15 }, { kind: 'pax8', intervalMinutes: 60 }] as const;

beforeEach(() => vi.spyOn(console, 'warn').mockImplementation(() => {}));

describe('connection health heartbeats', () => {
  it('keeps the key names the reconciler has always written', () => {
    expect(RECONCILE_HEARTBEAT_KEY).toBe('connection-health:reconcile:heartbeat');
    expect(RECONCILE_HEARTBEAT_TTL_S).toBe(3600);
    expect(kindStateKey('pax8', 'last-ok')).toBe('connection-health:kind:pax8:last-ok');
    expect(DIGEST_HEARTBEAT_KEY).toBe('connection-health:digest:heartbeat');
  });

  it('reports ok, stale and missing from the stored times', async () => {
    const redis = fakeRedis({
      [RECONCILE_HEARTBEAT_KEY]: minAgo(10).toISOString(),
      [DIGEST_HEARTBEAT_KEY]: minAgo(200).toISOString(),
      [kindStateKey('oauth_grant', 'last-ok')]: String(minAgo(5).getTime()),
      [kindStateKey('oauth_grant', 'failures')]: '2',
      [kindStateKey('pax8', 'last-ok')]: String(minAgo(400).getTime()),
    });
    const s = await readConnectionHealthJobStatus(redis, kinds, NOW);
    expect(s).toEqual({
      redis: 'ok',
      reconcile: { lastRunAt: minAgo(10).toISOString(), state: 'ok' },
      digest: { lastRunAt: minAgo(200).toISOString(), state: 'stale' },
      kinds: [
        { kind: 'oauth_grant', intervalMinutes: 15, lastOkAt: minAgo(5).toISOString(), failureStreak: 2, state: 'failing' },
        { kind: 'pax8', intervalMinutes: 60, lastOkAt: minAgo(400).toISOString(), failureStreak: 0, state: 'stale' },
      ],
    });
  });

  it('a reconciler that missed two ticks is stale; no key at all is missing', async () => {
    const s1 = await readConnectionHealthJobStatus(fakeRedis({ [RECONCILE_HEARTBEAT_KEY]: minAgo(40).toISOString() }), [], NOW);
    expect(s1.reconcile.state).toBe('stale');
    const s2 = await readConnectionHealthJobStatus(fakeRedis(), kinds, NOW);
    expect(s2.reconcile).toEqual({ lastRunAt: null, state: 'missing' });
    expect(s2.digest.state).toBe('missing');
    expect(s2.kinds[0]).toMatchObject({ lastOkAt: null, state: 'missing' });
  });

  it('Redis missing or failing is reported, never thrown', async () => {
    expect((await readConnectionHealthJobStatus(null, kinds, NOW)).redis).toBe('unavailable');
    const broken = fakeRedis();
    broken.mget = vi.fn(async () => { throw new Error('ECONNRESET'); });
    const s = await readConnectionHealthJobStatus(broken, kinds, NOW);
    expect(s.redis).toBe('unavailable');
    expect(s.kinds.map((k) => k.state)).toEqual(['missing', 'missing']);
  });

  it('writes the digest heartbeat with a TTL and never throws', async () => {
    const redis = fakeRedis();
    await writeDigestHeartbeat(redis, NOW);
    expect(redis.set).toHaveBeenCalledWith(DIGEST_HEARTBEAT_KEY, NOW.toISOString(), 'EX', DIGEST_HEARTBEAT_TTL_S);
    redis.set.mockRejectedValueOnce(new Error('down'));
    await expect(writeDigestHeartbeat(redis, NOW)).resolves.toBeUndefined();
    await expect(writeDigestHeartbeat(null, NOW)).resolves.toBeUndefined();
  });
});
