import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getRedis } from './redis';
import {
  AGENT_CREDENTIAL_USE_TTL_SECONDS,
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

  it('never throws into the request: a Redis failure is logged and the throttle entry released', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(redis.set).mockRejectedValueOnce(new Error('redis down'));
    expect(() => recordAgentCredentialUse('dev-1')).not.toThrow();
    await flush();
    expect(errSpy).toHaveBeenCalled();
    expect(agentCredentialUseThrottleSizeForTests()).toBe(0);
  });

  it('is a no-op when Redis is not configured', async () => {
    vi.mocked(getRedis).mockReturnValue(null);
    expect(() => recordAgentCredentialUse('dev-1')).not.toThrow();
    await flush();
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('bounds the in-memory throttle map', async () => {
    const t0 = Date.now();
    for (let i = 0; i < 10_050; i++) recordAgentCredentialUse(`dev-${i}`, new Date(t0 + i));
    expect(agentCredentialUseThrottleSizeForTests()).toBeLessThanOrEqual(10_000);
  });
});

describe('readAgentCredentialUse (#8318 §6.5)', () => {
  beforeEach(() => {
    vi.mocked(getRedis).mockReturnValue(redis);
    vi.mocked(redis.get).mockReset();
  });

  it('returns the marker time, or null when there is none', async () => {
    vi.mocked(redis.get).mockResolvedValueOnce('1761040800000');
    expect(await readAgentCredentialUse('dev-1')).toEqual({ at: new Date(1761040800000) });
    vi.mocked(redis.get).mockResolvedValueOnce(null);
    expect(await readAgentCredentialUse('dev-1')).toEqual({ at: null });
    vi.mocked(redis.get).mockResolvedValueOnce('not-a-number');
    expect(await readAgentCredentialUse('dev-1')).toEqual({ at: null });
  });

  it('reports `unavailable` (never "silent") when Redis is down or missing', async () => {
    vi.mocked(redis.get).mockRejectedValueOnce(new Error('redis down'));
    expect(await readAgentCredentialUse('dev-1')).toEqual({ unavailable: true });
    vi.mocked(getRedis).mockReturnValue(null);
    expect(await readAgentCredentialUse('dev-1')).toEqual({ unavailable: true });
  });
});
