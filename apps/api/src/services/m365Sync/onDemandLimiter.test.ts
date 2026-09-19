import { beforeEach, describe, expect, it, vi } from 'vitest';

const { redisMocks } = vi.hoisted(() => ({
  redisMocks: { set: vi.fn(), ttl: vi.fn(), del: vi.fn(), available: true },
}));
vi.mock('../redis', () => ({
  getRedis: () => (redisMocks.available ? { set: redisMocks.set, ttl: redisMocks.ttl, del: redisMocks.del } : null),
}));

import {
  ON_DEMAND_SYNC_WINDOW_SECONDS,
  consumeOnDemandSyncSlot,
  releaseOnDemandSyncSlot,
} from './onDemandLimiter';

const ORG = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  vi.clearAllMocks();
  redisMocks.available = true;
  redisMocks.set.mockReset(); redisMocks.ttl.mockReset(); redisMocks.del.mockReset();
});

describe('consumeOnDemandSyncSlot (spec §5.2: one per org per 15 min)', () => {
  it('allows the first call in the window and reserves the slot with NX + EX', async () => {
    redisMocks.set.mockResolvedValueOnce('OK');
    await expect(consumeOnDemandSyncSlot(ORG)).resolves.toEqual({ allowed: true });
    expect(ON_DEMAND_SYNC_WINDOW_SECONDS).toBe(900);
    expect(redisMocks.set).toHaveBeenCalledWith(`m365-sync-on-demand-${ORG}`, '1', 'EX', 900, 'NX');
  });

  it('denies a second call and reports the remaining TTL', async () => {
    redisMocks.set.mockResolvedValueOnce(null);
    redisMocks.ttl.mockResolvedValueOnce(412);
    await expect(consumeOnDemandSyncSlot(ORG)).resolves.toEqual({ allowed: false, retryAfterSeconds: 412 });
  });

  it('falls back to the full window when the TTL is missing or non-positive', async () => {
    redisMocks.set.mockResolvedValue(null);
    for (const value of [-1, -2, 0, null, undefined, 'x']) {
      redisMocks.ttl.mockResolvedValueOnce(value);
      await expect(consumeOnDemandSyncSlot(ORG)).resolves.toEqual({
        allowed: false, retryAfterSeconds: ON_DEMAND_SYNC_WINDOW_SECONDS,
      });
    }
  });

  it('fails CLOSED when Redis is unavailable', async () => {
    redisMocks.available = false;
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(consumeOnDemandSyncSlot(ORG)).resolves.toEqual({
        allowed: false, retryAfterSeconds: ON_DEMAND_SYNC_WINDOW_SECONDS,
      });
    } finally { spy.mockRestore(); }
  });

  it('fails CLOSED when Redis throws', async () => {
    redisMocks.set.mockRejectedValueOnce(new Error('connection reset'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(consumeOnDemandSyncSlot(ORG)).resolves.toEqual({
        allowed: false, retryAfterSeconds: ON_DEMAND_SYNC_WINDOW_SECONDS,
      });
      expect(spy).toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });

  it('scopes the key per org and never uses a colon (repo key convention)', async () => {
    redisMocks.set.mockResolvedValue('OK');
    await consumeOnDemandSyncSlot('22222222-2222-4222-8222-222222222222');
    expect(redisMocks.set.mock.calls[0]![0]).toBe('m365-sync-on-demand-22222222-2222-4222-8222-222222222222');
  });
});

describe('releaseOnDemandSyncSlot', () => {
  it('deletes the org key so a request that failed downstream does not lock the org out', async () => {
    redisMocks.del.mockResolvedValueOnce(1);
    await releaseOnDemandSyncSlot(ORG);
    expect(redisMocks.del).toHaveBeenCalledWith(`m365-sync-on-demand-${ORG}`);
  });

  it('never throws', async () => {
    redisMocks.del.mockRejectedValueOnce(new Error('down'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(releaseOnDemandSyncSlot(ORG)).resolves.toBeUndefined();
      redisMocks.available = false;
      await expect(releaseOnDemandSyncSlot(ORG)).resolves.toBeUndefined();
    } finally { spy.mockRestore(); }
  });
});
