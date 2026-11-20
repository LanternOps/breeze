import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getRedisMock, getConfigMock, recordCapHitMock } = vi.hoisted(() => ({
  getRedisMock: vi.fn(),
  getConfigMock: vi.fn(),
  recordCapHitMock: vi.fn((_partnerId: string) => undefined),
}));

vi.mock('../redis', () => ({ getRedis: getRedisMock }));
vi.mock('./config', () => ({ getEmailDomainsConfig: getConfigMock }));
vi.mock('./capHits', () => ({ recordCapHit: recordCapHitMock }));

import { countPartnerLaneSend, nextCapWindowStart, partnerLaneCapKey, tryCountPartnerLaneSend } from './sendCap';

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
    expect(partnerLaneCapKey(PARTNER, noon, 'internal')).toBe(partnerLaneCapKey(PARTNER, lateSameDay, 'internal'));
    expect(partnerLaneCapKey(PARTNER, noon, 'internal')).not.toBe(partnerLaneCapKey(PARTNER, nextDay, 'internal'));
    expect(partnerLaneCapKey(PARTNER, noon, 'internal')).toContain(PARTNER);
  });
});

describe('tryCountPartnerLaneSend (spec §9.1)', () => {
  it('allows and counts a send under the cap', async () => {
    const redis = redisWithCount(1);
    getRedisMock.mockReturnValue(redis);
    await expect(tryCountPartnerLaneSend(PARTNER)).resolves.toBe(true);
    expect(redis.__chain.incr).toHaveBeenCalledWith(partnerLaneCapKey(PARTNER, Date.now(), 'internal'));
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

describe('countPartnerLaneSend tells an over-cap verdict from an outage', () => {
  it('allowed under the cap and at 0 (unlimited)', async () => {
    getRedisMock.mockReturnValue(redisWithCount(1));
    await expect(countPartnerLaneSend(PARTNER, 'internal')).resolves.toBe('allowed');
    getConfigMock.mockReturnValue({ dailySendCap: 0, partnerAllowlist: [] });
    await expect(countPartnerLaneSend(PARTNER, 'internal')).resolves.toBe('allowed');
  });

  it('over_cap only for a genuine count past the cap', async () => {
    getRedisMock.mockReturnValue(redisWithCount(2001));
    await expect(countPartnerLaneSend(PARTNER, 'internal')).resolves.toBe('over_cap');
  });

  it('unavailable when Redis is missing, throws, or returns an unreadable result', async () => {
    getRedisMock.mockReturnValue(null);
    await expect(countPartnerLaneSend(PARTNER, 'internal')).resolves.toBe('unavailable');
    getRedisMock.mockReturnValue({ multi: () => { throw new Error('ECONNRESET'); } });
    await expect(countPartnerLaneSend(PARTNER, 'internal')).resolves.toBe('unavailable');
    const chain = { incr: vi.fn(() => chain), expire: vi.fn(() => chain), exec: vi.fn(async () => null) };
    getRedisMock.mockReturnValue({ multi: vi.fn(() => chain) });
    await expect(countPartnerLaneSend(PARTNER, 'internal')).resolves.toBe('unavailable');
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

// Strix finding on #12249: mail an outsider can trigger (inbound-email
// autoresponse, portal self-registration and password reset, trust-page access
// verification) must not spend the budget the partner's own mail draws on.
describe('separate buckets for internally and externally triggered sends', () => {
  it('counts the external bucket under its own key, never the partner key', async () => {
    const redis = redisWithCount(1);
    getRedisMock.mockReturnValue(redis);
    const now = Date.now();
    await expect(countPartnerLaneSend(PARTNER, 'external')).resolves.toBe('allowed');
    const key = redis.__chain.incr.mock.calls[0]![0];
    expect(key).toBe(partnerLaneCapKey(PARTNER, now, 'external'));
    expect(key).not.toBe(partnerLaneCapKey(PARTNER, now, 'internal'));
    expect(key).toContain(PARTNER);
  });

  it('keeps the internal key unchanged, so counters already in Redis carry over on deploy', () => {
    const noon = Date.UTC(2026, 8, 17, 12, 0, 0);
    expect(partnerLaneCapKey(PARTNER, noon, 'internal')).toBe(`email-domains:partner-lane-sends:${PARTNER}:2026-09-17`);
  });

  it('an external over-cap count is NOT recorded as the partner\'s own cap hit', async () => {
    getRedisMock.mockReturnValue(redisWithCount(2001));
    await expect(countPartnerLaneSend(PARTNER, 'external')).resolves.toBe('over_cap');
    expect(recordCapHitMock).not.toHaveBeenCalled();
    getRedisMock.mockReturnValue(redisWithCount(2001));
    await expect(countPartnerLaneSend(PARTNER, 'internal')).resolves.toBe('over_cap');
    expect(recordCapHitMock).toHaveBeenCalledWith(PARTNER);
  });

  it('the domain test send counts against the internal bucket', async () => {
    const redis = redisWithCount(1);
    getRedisMock.mockReturnValue(redis);
    await tryCountPartnerLaneSend(PARTNER);
    expect(redis.__chain.incr).toHaveBeenCalledWith(partnerLaneCapKey(PARTNER, Date.now(), 'internal'));
  });
});

describe('nextCapWindowStart', () => {
  it('is the next 00:00 UTC, strictly after now', () => {
    expect(nextCapWindowStart(Date.UTC(2026, 8, 17, 12, 0, 0)).toISOString()).toBe('2026-09-18T00:00:00.000Z');
    expect(nextCapWindowStart(Date.UTC(2026, 8, 17, 0, 0, 0)).toISOString()).toBe('2026-09-18T00:00:00.000Z');
    expect(nextCapWindowStart(Date.UTC(2026, 11, 31, 23, 59, 59)).toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });
});
