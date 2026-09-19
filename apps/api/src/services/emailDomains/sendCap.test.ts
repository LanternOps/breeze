import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getRedisMock, getConfigMock, recordCapHitMock } = vi.hoisted(() => ({
  getRedisMock: vi.fn(),
  getConfigMock: vi.fn(),
  recordCapHitMock: vi.fn((_partnerId: string) => undefined),
}));

vi.mock('../redis', () => ({ getRedis: getRedisMock }));
vi.mock('./config', () => ({ getEmailDomainsConfig: getConfigMock }));
vi.mock('./capHits', () => ({ recordCapHit: recordCapHitMock }));

import { partnerLaneCapKey, tryCountPartnerLaneSend } from './sendCap';

const PARTNER = '11111111-1111-1111-1111-111111111111';

/** ioredis `multi()` chain: incr -> expire -> exec, exec resolving [[null, n], [null, 1]]. */
function redisWithCount(count: number) {
  const chain = {
    incr: vi.fn((_key: string) => chain),
    expire: vi.fn((_key: string, _ttlSeconds: number) => chain),
    exec: vi.fn(async () => [[null, count], [null, 1]]),
  };
  return { multi: vi.fn(() => chain), __chain: chain };
}

beforeEach(() => {
  vi.clearAllMocks();
  getConfigMock.mockReturnValue({ dailySendCap: 2000, partnerAllowlist: [] });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('partnerLaneCapKey', () => {
  it('is one fixed window per partner per UTC day', () => {
    const noon = Date.UTC(2026, 8, 17, 12, 0, 0);
    const lateSameDay = Date.UTC(2026, 8, 17, 23, 59, 59);
    const nextDay = Date.UTC(2026, 8, 18, 0, 0, 1);
    expect(partnerLaneCapKey(PARTNER, noon)).toBe(partnerLaneCapKey(PARTNER, lateSameDay));
    expect(partnerLaneCapKey(PARTNER, noon)).not.toBe(partnerLaneCapKey(PARTNER, nextDay));
    expect(partnerLaneCapKey(PARTNER, noon)).toContain(PARTNER);
  });
});

describe('tryCountPartnerLaneSend (spec §9.1)', () => {
  it('allows and counts a send under the cap', async () => {
    const redis = redisWithCount(1);
    getRedisMock.mockReturnValue(redis);
    await expect(tryCountPartnerLaneSend(PARTNER)).resolves.toBe(true);
    expect(redis.__chain.incr).toHaveBeenCalledWith(partnerLaneCapKey(PARTNER, Date.now()));
    // The expiry is set on EVERY increment, in the same round trip. A bare INCR
    // would leave an immortal key per partner per day forever.
    expect(redis.__chain.expire).toHaveBeenCalledTimes(1);
    expect(redis.__chain.expire.mock.calls[0]![1]).toBeGreaterThan(86_400);
  });

  it('allows the send that exactly reaches the cap and refuses the next one', async () => {
    getRedisMock.mockReturnValue(redisWithCount(2000));
    await expect(tryCountPartnerLaneSend(PARTNER)).resolves.toBe(true);
    getRedisMock.mockReturnValue(redisWithCount(2001));
    await expect(tryCountPartnerLaneSend(PARTNER)).resolves.toBe(false);
  });

  // Spec §9.1: the cap defaults to unlimited when !isHosted(). A self-hoster's
  // volume is their own business, and silently moving their ticket mail back to
  // the old From at message 2,001 would be a bug report, not a protection.
  it('is unlimited at 0 and never touches Redis', async () => {
    getConfigMock.mockReturnValue({ dailySendCap: 0, partnerAllowlist: [] });
    getRedisMock.mockReturnValue(redisWithCount(9_999_999));
    await expect(tryCountPartnerLaneSend(PARTNER)).resolves.toBe(true);
    expect(getRedisMock).not.toHaveBeenCalled();
  });

  // Redis down is NOT "unlimited". Fail to the PLATFORM lane: the message still
  // goes out (nothing is lost, spec G3) and an outage cannot lift the abuse cap.
  it('refuses the partner lane when Redis is unavailable', async () => {
    getRedisMock.mockReturnValue(null);
    await expect(tryCountPartnerLaneSend(PARTNER)).resolves.toBe(false);
  });

  it('refuses the partner lane when Redis throws', async () => {
    getRedisMock.mockReturnValue({ multi: () => { throw new Error('ECONNRESET'); } });
    await expect(tryCountPartnerLaneSend(PARTNER)).resolves.toBe(false);
  });

  it('refuses the partner lane when the multi result is unreadable', async () => {
    const chain = { incr: vi.fn(() => chain), expire: vi.fn(() => chain), exec: vi.fn(async () => null) };
    getRedisMock.mockReturnValue({ multi: vi.fn(() => chain) });
    await expect(tryCountPartnerLaneSend(PARTNER)).resolves.toBe(false);
  });

  // A Redis outage must NOT fabricate an abuse signal for W06 to act on.
  it('logs a cap hit only for a genuine over-cap count, never for an outage', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    getRedisMock.mockReturnValue(redisWithCount(2001));
    await tryCountPartnerLaneSend(PARTNER);
    expect(warn.mock.calls.flat().join(' ')).toContain('daily partner-lane cap');

    warn.mockClear();
    getRedisMock.mockReturnValue(null);
    await tryCountPartnerLaneSend(PARTNER);
    expect(warn.mock.calls.flat().join(' ')).not.toContain('daily partner-lane cap');
  });
});

describe('recordPartnerLaneCapHit wiring (W06)', () => {
  it('records the hit for the abuse producer on a genuine over-cap count', async () => {
    getConfigMock.mockReturnValue({ dailySendCap: 2000 });
    getRedisMock.mockReturnValue(redisWithCount(2001));
    await tryCountPartnerLaneSend(PARTNER);
    expect(recordCapHitMock).toHaveBeenCalledWith(PARTNER);
  });

  // W04's invariant, re-pinned now that the hit has a consumer: an outage must
  // never be able to manufacture an abuse signal against a partner.
  it('records NOTHING when Redis is unavailable', async () => {
    getConfigMock.mockReturnValue({ dailySendCap: 2000 });
    getRedisMock.mockReturnValue(null);
    await tryCountPartnerLaneSend(PARTNER);
    expect(recordCapHitMock).not.toHaveBeenCalled();
  });

  it('records NOTHING for a send comfortably under the cap', async () => {
    getConfigMock.mockReturnValue({ dailySendCap: 2000 });
    getRedisMock.mockReturnValue(redisWithCount(3));
    await tryCountPartnerLaneSend(PARTNER);
    expect(recordCapHitMock).not.toHaveBeenCalled();
  });
});
