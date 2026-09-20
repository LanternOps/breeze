import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Redis } from 'ioredis';

// Mock the shared limiter so we control allow/deny per key without Redis.
const rateLimiterMock = vi.fn();
vi.mock('../rate-limit', () => ({
  rateLimiter: (...args: unknown[]) => rateLimiterMock(...args),
}));

import {
  resolveInboundCapLimits,
  evaluateInboundThrottle,
} from './inboundRateLimit';

const allow = { allowed: true, remaining: 1, resetAt: new Date() };
const deny = { allowed: false, remaining: 0, resetAt: new Date() };
const fakeRedis = {} as unknown as Redis;

describe('resolveInboundCapLimits', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.INBOUND_MAX_PER_SENDER_PER_HOUR = '30';
    process.env.INBOUND_MAX_PER_DOMAIN_PER_HOUR = '200';
    process.env.INBOUND_MAX_PER_PARTNER_PER_HOUR = '1000';
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it('falls back to env defaults when overrides are null', () => {
    expect(resolveInboundCapLimits({
      maxTicketsPerSenderPerHour: null,
      maxTicketsPerDomainPerHour: null,
      maxTicketsPerPartnerPerHour: null,
    })).toEqual({ perSenderPerHour: 30, perDomainPerHour: 200, perPartnerPerHour: 1000 });
  });

  it('lets a partner override win, including 0 (unlimited)', () => {
    expect(resolveInboundCapLimits({
      maxTicketsPerSenderPerHour: 5,
      maxTicketsPerDomainPerHour: 0,
      maxTicketsPerPartnerPerHour: null,
    })).toEqual({ perSenderPerHour: 5, perDomainPerHour: 0, perPartnerPerHour: 1000 });
  });
});

describe('evaluateInboundThrottle', () => {
  beforeEach(() => rateLimiterMock.mockReset());

  const limits = { perSenderPerHour: 30, perDomainPerHour: 200, perPartnerPerHour: 1000 };

  it('passes when every window allows', async () => {
    rateLimiterMock.mockResolvedValue(allow);
    const v = await evaluateInboundThrottle({ redis: fakeRedis, from: 'jane@acme.com', partnerId: 'p1', limits });
    expect(v).toEqual({ throttled: false, bucket: null });
    expect(rateLimiterMock).toHaveBeenCalledTimes(3);
  });

  it('reports the sender bucket first (tightest window) and short-circuits', async () => {
    rateLimiterMock.mockResolvedValueOnce(deny); // sender window denies
    const v = await evaluateInboundThrottle({ redis: fakeRedis, from: 'jane@acme.com', partnerId: 'p1', limits });
    expect(v).toEqual({ throttled: true, bucket: 'sender' });
    // Stops at the first tripped window — does not check domain/partner.
    expect(rateLimiterMock).toHaveBeenCalledTimes(1);
  });

  it('namespaces keys by partner and lowercases the sender', async () => {
    rateLimiterMock.mockResolvedValue(allow);
    await evaluateInboundThrottle({ redis: fakeRedis, from: 'Jane@ACME.com', partnerId: 'p1', limits });
    const keys = rateLimiterMock.mock.calls.map((c) => c[1]);
    expect(keys).toEqual([
      'inbound:tix:sender:p1:jane@acme.com',
      'inbound:tix:sdom:p1:acme.com',
      'inbound:tix:partner:p1',
    ]);
  });

  it('skips a window whose limit is 0 (unlimited)', async () => {
    rateLimiterMock.mockResolvedValue(allow);
    await evaluateInboundThrottle({
      redis: fakeRedis,
      from: 'jane@acme.com',
      partnerId: 'p1',
      limits: { perSenderPerHour: 0, perDomainPerHour: 0, perPartnerPerHour: 1000 },
    });
    // Only the partner window is checked.
    expect(rateLimiterMock).toHaveBeenCalledTimes(1);
    expect(rateLimiterMock.mock.calls[0][1]).toBe('inbound:tix:partner:p1');
  });

  it('skips the domain window when the sender address has no parseable domain', async () => {
    rateLimiterMock.mockResolvedValue(allow);
    await evaluateInboundThrottle({ redis: fakeRedis, from: 'not-an-address', partnerId: 'p1', limits });
    const keys = rateLimiterMock.mock.calls.map((c) => c[1]);
    expect(keys).toEqual([
      'inbound:tix:sender:p1:not-an-address',
      'inbound:tix:partner:p1',
    ]);
  });

  it('fails OPEN (does not throttle) when Redis is unavailable, without calling the limiter', async () => {
    rateLimiterMock.mockResolvedValue(deny);
    const v = await evaluateInboundThrottle({ redis: null, from: 'jane@acme.com', partnerId: 'p1', limits });
    expect(v).toEqual({ throttled: false, bucket: null });
    expect(rateLimiterMock).not.toHaveBeenCalled();
  });

  it('reports partner bucket when only the partner window trips', async () => {
    rateLimiterMock.mockResolvedValueOnce(allow).mockResolvedValueOnce(allow).mockResolvedValueOnce(deny);
    const v = await evaluateInboundThrottle({ redis: fakeRedis, from: 'jane@acme.com', partnerId: 'p1', limits });
    expect(v).toEqual({ throttled: true, bucket: 'partner' });
  });
});
