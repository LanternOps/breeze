import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getRedis } from './redis';
import { metricsRegistry } from './metricsRegistry';
import {
  AGENT_CREDENTIAL_USE_TTL_SECONDS,
  AGENT_CREDENTIAL_USE_WARN_INTERVAL_MS,
  AGENT_CREDENTIAL_USE_WRITES_METRIC,
  AGENT_CREDENTIAL_USE_WRITE_INTERVAL_MS,
  __resetAgentCredentialUseThrottleForTests,
  agentCredentialUseKey,
  agentCredentialUseThrottleSizeForTests,
  readAgentCredentialUse,
  recordAgentCredentialUse,
} from './agentCredentialUse';

// `../services/redis` is mocked globally in src/__tests__/setup.ts.
const redis = getRedis()!;
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

async function writeCounts(): Promise<Record<string, number>> {
  const metric = metricsRegistry.getSingleMetric(AGENT_CREDENTIAL_USE_WRITES_METRIC);
  const { values } = await metric!.get();
  return Object.fromEntries(values.map((v) => [String(v.labels.outcome), v.value]));
}

async function writeDeltas<T>(fn: () => Promise<T>): Promise<Record<string, number>> {
  const before = await writeCounts();
  await fn();
  const after = await writeCounts();
  return Object.fromEntries(Object.keys(after).map((k) => [k, after[k]! - (before[k] ?? 0)]));
}

describe('recordAgentCredentialUse (#8318 §6.5)', () => {
  beforeEach(() => {
    __resetAgentCredentialUseThrottleForTests();
    vi.mocked(redis.set).mockClear();
    vi.mocked(redis.set).mockResolvedValue('OK');
    vi.mocked(getRedis).mockReturnValue(redis);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes agent-cred-use:<deviceId> = <epoch ms> with a 24 h TTL', async () => {
    const at = new Date('2026-10-21T10:00:00.000Z');
    recordAgentCredentialUse('dev-1', at);
    await flush();
    expect(redis.set).toHaveBeenCalledWith(
      'agent-cred-use:dev-1',
      String(at.getTime()),
      'EX',
      AGENT_CREDENTIAL_USE_TTL_SECONDS,
    );
    expect(AGENT_CREDENTIAL_USE_TTL_SECONDS).toBe(24 * 60 * 60);
    expect(agentCredentialUseKey('dev-1')).toBe('agent-cred-use:dev-1');
  });

  it('writes at most once per 30 s per device per process, and again after the window', async () => {
    const t0 = new Date('2026-10-21T10:00:00.000Z');
    recordAgentCredentialUse('dev-1', t0);
    recordAgentCredentialUse('dev-1', new Date(t0.getTime() + 1_000));
    recordAgentCredentialUse('dev-1', new Date(t0.getTime() + AGENT_CREDENTIAL_USE_WRITE_INTERVAL_MS - 1));
    recordAgentCredentialUse('dev-2', new Date(t0.getTime() + 1_000));
    await flush();
    expect(redis.set).toHaveBeenCalledTimes(2);

    recordAgentCredentialUse('dev-1', new Date(t0.getTime() + AGENT_CREDENTIAL_USE_WRITE_INTERVAL_MS));
    await flush();
    expect(redis.set).toHaveBeenCalledTimes(3);
  });

  it('never throws into the request: a Redis failure is counted, warned and the throttle entry released', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(redis.set).mockRejectedValueOnce(new Error('redis down'));
    const deltas = await writeDeltas(async () => {
      expect(() => recordAgentCredentialUse('dev-1')).not.toThrow();
      await flush();
    });
    expect(deltas).toMatchObject({ error: 1, written: 0 });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(agentCredentialUseThrottleSizeForTests()).toBe(0);
  });

  it('writes nothing when Redis is not configured, and counts it as redis_unavailable', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(getRedis).mockReturnValue(null);
    const deltas = await writeDeltas(async () => {
      expect(() => recordAgentCredentialUse('dev-1')).not.toThrow();
      await flush();
    });
    expect(redis.set).not.toHaveBeenCalled();
    expect(deltas).toMatchObject({ redis_unavailable: 1, written: 0 });
  });

  // Review of wave 1b-1: an outage is a metric, not a per-device log flood.
  it('counts every write decision by outcome, pre-seeded at 0', async () => {
    const counts = await writeCounts();
    expect(Object.keys(counts).sort()).toEqual(['error', 'redis_unavailable', 'throttled', 'written']);
    const t0 = new Date('2026-10-21T10:00:00.000Z');
    const deltas = await writeDeltas(async () => {
      recordAgentCredentialUse('dev-1', t0);
      recordAgentCredentialUse('dev-1', new Date(t0.getTime() + 1_000)); // throttled
      await flush();
    });
    expect(deltas).toEqual({ written: 1, throttled: 1, redis_unavailable: 0, error: 0 });
  });

  it('warns at most once a minute per process across devices, then reports how many it held back', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const now = vi.spyOn(Date, 'now');
    vi.mocked(getRedis).mockReturnValue(null);
    now.mockReturnValue(1_000_000);
    for (let i = 0; i < 50; i++) recordAgentCredentialUse(`dev-${i}`);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    now.mockReturnValue(1_000_000 + AGENT_CREDENTIAL_USE_WARN_INTERVAL_MS);
    recordAgentCredentialUse('dev-next');
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(String(warnSpy.mock.calls[1]![0])).toContain('49 more since the last warning');
  });

  it('bounds the in-memory throttle map', async () => {
    const t0 = Date.now();
    for (let i = 0; i < 10_050; i++) recordAgentCredentialUse(`dev-${i}`, new Date(t0 + i));
    expect(agentCredentialUseThrottleSizeForTests()).toBeLessThanOrEqual(10_000);
  });

  it('above the cap evicts the least recently written device, never one it just refreshed', async () => {
    const t0 = new Date('2026-10-21T10:00:00.000Z').getTime();
    const window = AGENT_CREDENTIAL_USE_WRITE_INTERVAL_MS;
    // dev-0 is written first, then 9,998 others, then dev-0 is refreshed once
    // its window has passed. Every entry is still inside the window at the
    // end, so the time sweep frees nothing and the cap evicts by order alone.
    recordAgentCredentialUse('dev-0', new Date(t0));
    for (let i = 1; i < 9_999; i++) recordAgentCredentialUse(`dev-${i}`, new Date(t0 + 1_000));
    recordAgentCredentialUse('dev-0', new Date(t0 + window));
    recordAgentCredentialUse('dev-9999', new Date(t0 + window));
    expect(agentCredentialUseThrottleSizeForTests()).toBe(10_000);
    recordAgentCredentialUse('dev-10000', new Date(t0 + window)); // at the cap: one eviction
    expect(agentCredentialUseThrottleSizeForTests()).toBe(10_000);
    await flush();
    vi.mocked(redis.set).mockClear();

    // dev-0 was refreshed most recently of the old entries: still throttled.
    recordAgentCredentialUse('dev-0', new Date(t0 + window + 1));
    await flush();
    expect(redis.set).not.toHaveBeenCalled();
    // dev-1, written before that refresh, is the one that went.
    recordAgentCredentialUse('dev-1', new Date(t0 + window + 1));
    await flush();
    expect(redis.set).toHaveBeenCalledWith('agent-cred-use:dev-1', String(t0 + window + 1), 'EX', AGENT_CREDENTIAL_USE_TTL_SECONDS);
  });
});

describe('readAgentCredentialUse (#8318 §6.5)', () => {
  beforeEach(() => {
    __resetAgentCredentialUseThrottleForTests();
    vi.mocked(getRedis).mockReturnValue(redis);
    vi.mocked(redis.get).mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the marker time, or null when there is none', async () => {
    vi.mocked(redis.get).mockResolvedValueOnce('1761040800000');
    expect(await readAgentCredentialUse('dev-1')).toEqual({ at: new Date(1761040800000) });
    vi.mocked(redis.get).mockResolvedValueOnce(null);
    expect(await readAgentCredentialUse('dev-1')).toEqual({ at: null });
    vi.mocked(redis.get).mockResolvedValueOnce('not-a-number');
    expect(await readAgentCredentialUse('dev-1')).toEqual({ at: null });
  });

  it('reads an empty, zero, negative or non-finite marker as no marker, never as a 1970 use', async () => {
    for (const raw of ['', '   ', '0', '-5', 'NaN', 'Infinity']) {
      vi.mocked(redis.get).mockResolvedValueOnce(raw);
      expect(await readAgentCredentialUse('dev-1'), JSON.stringify(raw)).toEqual({ at: null });
    }
    vi.mocked(redis.get).mockResolvedValueOnce('1');
    expect(await readAgentCredentialUse('dev-1')).toEqual({ at: new Date(1) });
  });

  it('reports `unavailable` (never "silent") with its cause when Redis is down or missing, and warns', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(redis.get).mockRejectedValueOnce(new Error('redis down'));
    expect(await readAgentCredentialUse('dev-1')).toEqual({ unavailable: true, cause: 'read_error' });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    __resetAgentCredentialUseThrottleForTests(); // re-arm the warning
    vi.mocked(getRedis).mockReturnValue(null);
    expect(await readAgentCredentialUse('dev-1')).toEqual({ unavailable: true, cause: 'redis_unavailable' });
    expect(warnSpy).toHaveBeenCalledTimes(2);
    // Rate-limited like the write side: the next failure in the window is held back.
    expect(await readAgentCredentialUse('dev-2')).toEqual({ unavailable: true, cause: 'redis_unavailable' });
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });
});
