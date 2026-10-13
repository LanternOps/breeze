import { beforeEach, describe, expect, it, vi } from 'vitest';

const redis = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), del: vi.fn() }));
const redisState = vi.hoisted(() => ({ available: true }));
vi.mock('../redis', () => ({ getRedis: () => (redisState.available ? redis : null) }));

import {
  WORKSTATION_READINESS_TTL_SECONDS,
  readinessKey,
  recordWorkstationCapabilities,
  workstationReadyUsers,
  workstationUserAvailable,
} from './workstationCapabilities';

const ORG = '11111111-1111-4111-8111-111111111111';
const DEVICE = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  vi.resetAllMocks();
  redisState.available = true;
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

  it('never throws when Redis fails or is absent', async () => {
    redis.set.mockRejectedValueOnce(new Error('down'));
    await expect(recordWorkstationCapabilities(ORG, DEVICE, { callerVerify: true, usernames: ['alex'] })).resolves.toBeUndefined();
    redisState.available = false;
    await expect(recordWorkstationCapabilities(ORG, DEVICE, undefined)).resolves.toBeUndefined();
  });
});

describe('workstationUserAvailable', () => {
  it('requires the exact user on that org and device', async () => {
    redis.get.mockResolvedValueOnce('["alex"]');
    expect(await workstationUserAvailable(ORG, DEVICE, 'alex')).toBe(true);
    expect(redis.get).toHaveBeenCalledWith(readinessKey(ORG, DEVICE));
    redis.get.mockResolvedValueOnce('["alex"]');
    // Exact spelling: folding could select another Unix account.
    expect(await workstationUserAvailable(ORG, DEVICE, 'Alex')).toBe(false);
    redis.get.mockResolvedValueOnce('["someone-else"]');
    expect(await workstationUserAvailable(ORG, DEVICE, 'alex')).toBe(false);
  });

  it.each([
    ['a missing key', async () => redis.get.mockResolvedValueOnce(null)],
    ['corrupt JSON', async () => redis.get.mockResolvedValueOnce('{')],
    ['a non-array', async () => redis.get.mockResolvedValueOnce('{"alex":true}')],
    ['a Redis error', async () => redis.get.mockRejectedValueOnce(new Error('down'))],
    ['no Redis', async () => { redisState.available = false; }],
  ])('fails closed on %s', async (_label, arrange) => {
    await arrange();
    expect(await workstationUserAvailable(ORG, DEVICE, 'alex')).toBe(false);
  });
});

describe('workstationReadyUsers', () => {
  it('returns only string entries', async () => {
    redis.get.mockResolvedValueOnce('["alex", 5, null, "sam"]');
    expect(await workstationReadyUsers(ORG, DEVICE)).toEqual(['alex', 'sam']);
  });
});
