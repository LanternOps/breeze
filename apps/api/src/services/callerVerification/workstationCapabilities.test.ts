import { beforeEach, describe, expect, it, vi } from 'vitest';

const redis = vi.hoisted(() => ({ mget: vi.fn(), set: vi.fn(), del: vi.fn() }));
const redisState = vi.hoisted(() => ({ available: true }));
const capture = vi.hoisted(() => vi.fn());
vi.mock('../redis', () => ({ getRedis: () => (redisState.available ? redis : null) }));
vi.mock('../sentry', () => ({ captureException: capture }));

import {
  WORKSTATION_READINESS_TTL_SECONDS,
  __resetReadinessReportThrottleForTests,
  readinessKey,
  recordWorkstationCapabilities,
  workstationReadiness,
  workstationReadyUsers,
  workstationUserAvailable,
} from './workstationCapabilities';

const ORG = '11111111-1111-4111-8111-111111111111';
const DEVICE = '22222222-2222-4222-8222-222222222222';
const DEVICE2 = '33333333-3333-4333-8333-333333333333';

beforeEach(() => {
  vi.resetAllMocks();
  redisState.available = true;
  __resetReadinessReportThrottleForTests();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('recordWorkstationCapabilities', () => {
  it('replaces readiness with a short-lived observation keyed by org and device', async () => {
    await recordWorkstationCapabilities(ORG, DEVICE, { callerVerify: true, usernames: ['alex', 'alex', 'sam'] });
    expect(redis.set).toHaveBeenCalledWith(readinessKey(ORG, DEVICE), JSON.stringify(['alex', 'sam']), 'EX', WORKSTATION_READINESS_TTL_SECONDS);
    expect(WORKSTATION_READINESS_TTL_SECONDS).toBeLessThanOrEqual(180);
  });

  it.each([
    ['an old agent (field absent)', undefined],
    ['callerVerify false', { callerVerify: false, usernames: ['alex'] }],
    ['no users', { callerVerify: true, usernames: [] }],
  ])('clears readiness for %s', async (_label, observation) => {
    await recordWorkstationCapabilities(ORG, DEVICE, observation);
    expect(redis.del).toHaveBeenCalledWith(readinessKey(ORG, DEVICE));
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('caps the stored user list', async () => {
    const usernames = Array.from({ length: 40 }, (_, i) => `user${i}`);
    await recordWorkstationCapabilities(ORG, DEVICE, { callerVerify: true, usernames });
    expect(JSON.parse(redis.set.mock.calls[0]![1] as string)).toHaveLength(32);
  });

  it('never throws, but reports a store fault', async () => {
    redis.set.mockRejectedValueOnce(new Error('down'));
    await expect(recordWorkstationCapabilities(ORG, DEVICE, { callerVerify: true, usernames: ['alex'] })).resolves.toBeUndefined();
    expect(capture).toHaveBeenCalledTimes(1);
    redisState.available = false;
    await expect(recordWorkstationCapabilities(ORG, DEVICE, undefined)).resolves.toBeUndefined();
  });
});

describe('workstationReadiness', () => {
  it('reads every device in one round trip', async () => {
    redis.mget.mockResolvedValueOnce(['["alex"]', null]);
    const map = await workstationReadiness(ORG, [DEVICE, DEVICE2]);
    expect(redis.mget).toHaveBeenCalledTimes(1);
    expect(redis.mget).toHaveBeenCalledWith(readinessKey(ORG, DEVICE), readinessKey(ORG, DEVICE2));
    expect(map?.get(DEVICE)).toEqual(['alex']);
    expect(map?.get(DEVICE2)).toEqual([]);
  });

  it('returns null (store unknown, not "nobody ready") and reports it, throttled', async () => {
    redis.mget.mockRejectedValue(new Error('down'));
    expect(await workstationReadiness(ORG, [DEVICE])).toBeNull();
    expect(await workstationReadiness(ORG, [DEVICE])).toBeNull();
    expect(capture).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledTimes(2);
    redisState.available = false;
    expect(await workstationReadiness(ORG, [DEVICE])).toBeNull();
  });

  it('treats a corrupt entry as that device having no ready user', async () => {
    redis.mget.mockResolvedValueOnce(['{', '{"alex":true}']);
    const map = await workstationReadiness(ORG, [DEVICE, DEVICE2]);
    expect(map?.get(DEVICE)).toEqual([]);
    expect(map?.get(DEVICE2)).toEqual([]);
    expect(capture).not.toHaveBeenCalled();
  });
});

describe('workstationUserAvailable / workstationReadyUsers', () => {
  it('requires the exact user on that org and device', async () => {
    redis.mget.mockResolvedValueOnce(['["alex"]']);
    expect(await workstationUserAvailable(ORG, DEVICE, 'alex')).toBe(true);
    redis.mget.mockResolvedValueOnce(['["alex"]']);
    // Exact spelling: folding could select another Unix account.
    expect(await workstationUserAvailable(ORG, DEVICE, 'Alex')).toBe(false);
  });

  it('fails closed on a store fault', async () => {
    redis.mget.mockRejectedValueOnce(new Error('down'));
    expect(await workstationUserAvailable(ORG, DEVICE, 'alex')).toBe(false);
  });

  it('returns only string entries', async () => {
    redis.mget.mockResolvedValueOnce(['["alex", 5, null, "sam"]']);
    expect(await workstationReadyUsers(ORG, DEVICE)).toEqual(['alex', 'sam']);
  });
});
