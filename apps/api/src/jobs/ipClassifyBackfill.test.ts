import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  select, update, runOutside, withSystem, classify, ensureOfflineData, offlineBaselineComplete,
  restrictOnHardDeny, ipClassifyProvider, redis,
} = vi.hoisted(() => ({
  select: vi.fn(),
  update: vi.fn(),
  runOutside: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withSystem: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  classify: vi.fn(),
  ensureOfflineData: vi.fn(),
  offlineBaselineComplete: vi.fn(),
  restrictOnHardDeny: vi.fn(),
  ipClassifyProvider: vi.fn(),
  redis: { get: vi.fn(), set: vi.fn() },
}));

vi.mock('../db', () => ({
  db: { select, update },
  runOutsideDbContext: runOutside,
  withSystemDbAccessContext: withSystem,
}));
vi.mock('../db/schema', () => ({
  partners: {
    id: 'partners.id', signupIp: 'partners.signupIp', signupIpClass: 'partners.signupIpClass',
    signupIpClassSource: 'partners.signupIpClassSource',
  },
  devices: { id: 'devices.id', enrollmentIp: 'devices.enrollmentIp', enrollmentIpClass: 'devices.enrollmentIpClass' },
}));
vi.mock('../services/ipClassify', () => ({ classifyIp: classify }));
vi.mock('../services/ipClassifyOffline', () => ({ ensureOfflineData, offlineBaselineComplete }));
vi.mock('../services/partnerTrustPromotion', () => ({ restrictOnHardDeny }));
vi.mock('../services/redis', () => ({ getRedis: () => redis }));
vi.mock('../config/env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config/env')>()),
  ipClassifyProvider,
}));

import { runIpClassifyBackfill, scheduleIpClassifyBackfill } from './ipClassifyBackfill';

type Row = { id: string; ip: string };

/**
 * select() pages partners, then devices. Every batch here is shorter than the
 * job's page size, so each table is read exactly once.
 */
function withRows(partnerRows: Row[], deviceRows: Row[]) {
  const queue = [partnerRows, deviceRows];
  select.mockImplementation(() => ({
    from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => queue.shift() ?? [] }) }) }),
  }));
}

describe('runIpClassifyBackfill', () => {
  const set = vi.fn();
  const where = vi.fn(async () => undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    ipClassifyProvider.mockReturnValue('none');
    offlineBaselineComplete.mockReturnValue(true);
    ensureOfflineData.mockResolvedValue(undefined);
    restrictOnHardDeny.mockResolvedValue(false);
    redis.get.mockResolvedValue(null);
    redis.set.mockResolvedValue('OK');
    set.mockReturnValue({ where });
    update.mockReturnValue({ set });
  });

  it('re-classifies unknown partners with their source, and only writes devices that gained a class', async () => {
    withRows(
      [{ id: 'p1', ip: '203.0.113.10' }, { id: 'p2', ip: '203.0.113.66' }],
      [{ id: 'd1', ip: '203.0.113.10' }, { id: 'd2', ip: '192.0.2.10' }],
    );
    classify.mockImplementation(async (ip: string) => ({
      '203.0.113.10': { ipClass: 'unknown', asn: 64501, provider: 'offline' },
      '203.0.113.66': { ipClass: 'tor', asn: 64501, provider: 'offline' },
      '192.0.2.10': { ipClass: 'hosting', asn: 64500, provider: 'offline' },
    })[ip]);

    await expect(runIpClassifyBackfill()).resolves.toEqual({
      classifier: 'offline', partners: 2, devices: 1, complete: true,
    });

    expect(ensureOfflineData).toHaveBeenCalledWith({ waitMs: expect.any(Number) });
    expect(set).toHaveBeenCalledWith({
      signupIpClass: 'unknown', signupIpAsn: 64501, signupIpClassifiedAt: expect.any(Date), signupIpClassSource: 'offline',
    });
    expect(set).toHaveBeenCalledWith({
      signupIpClass: 'tor', signupIpAsn: 64501, signupIpClassifiedAt: expect.any(Date), signupIpClassSource: 'offline',
    });
    expect(set).toHaveBeenCalledWith({
      enrollmentIpClass: 'hosting', enrollmentIpAsn: 64500, enrollmentIpClassifiedAt: expect.any(Date),
    });
    expect(set).toHaveBeenCalledTimes(3);
    // One lookup per distinct address across partners and devices.
    expect(classify).toHaveBeenCalledTimes(3);
    // A newly-Tor signup goes straight to the hard-deny evaluation.
    expect(restrictOnHardDeny).toHaveBeenCalledWith('p2');
    expect(restrictOnHardDeny).toHaveBeenCalledTimes(1);
    expect(redis.set).toHaveBeenCalledWith('ipclass:backfill:done:v1:offline', expect.any(String));
  });

  it('does not mark the backfill done when only the partial (Tor-only) baseline was available', async () => {
    offlineBaselineComplete.mockReturnValue(false);
    withRows([{ id: 'p1', ip: '203.0.113.10' }], []);
    classify.mockResolvedValue({ ipClass: 'unknown', asn: null, provider: 'offline-partial' });

    await expect(runIpClassifyBackfill()).resolves.toMatchObject({ complete: false, partners: 1 });
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('keeps going when one row fails', async () => {
    withRows([{ id: 'p1', ip: '203.0.113.10' }, { id: 'p2', ip: '203.0.113.11' }], []);
    classify.mockResolvedValue({ ipClass: 'unknown', asn: 64501, provider: 'offline' });
    where.mockRejectedValueOnce(new Error('db exploded'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(runIpClassifyBackfill()).resolves.toMatchObject({ partners: 1 });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('p1'), expect.any(Error));
    warn.mockRestore();
  });

  it('uses the keyed provider without waiting for offline data when one is configured', async () => {
    ipClassifyProvider.mockReturnValue('ipinfo');
    withRows([{ id: 'p1', ip: '203.0.113.10' }], []);
    classify.mockResolvedValue({ ipClass: 'residential', asn: 64501, provider: 'ipinfo' });

    await expect(runIpClassifyBackfill()).resolves.toMatchObject({ classifier: 'ipinfo', complete: true });
    expect(ensureOfflineData).not.toHaveBeenCalled();
    expect(redis.set).toHaveBeenCalledWith('ipclass:backfill:done:v1:ipinfo', expect.any(String));
  });
});

describe('scheduleIpClassifyBackfill', () => {
  const add = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    ipClassifyProvider.mockReturnValue('none');
    redis.get.mockResolvedValue(null);
  });

  it('enqueues one deduplicated job per classifier', async () => {
    await scheduleIpClassifyBackfill({ add } as never);
    expect(add).toHaveBeenCalledWith('ip-classify-backfill', {}, expect.objectContaining({
      jobId: 'ip-classify-backfill-v1-offline',
    }));
  });

  it('does not enqueue once the backfill for this classifier has completed', async () => {
    redis.get.mockResolvedValue('2026-11-11T00:00:00.000Z');
    await scheduleIpClassifyBackfill({ add } as never);
    expect(add).not.toHaveBeenCalled();
  });
});
