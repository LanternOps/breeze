import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Redis } from 'ioredis';
import {
  resolveInboundCapLimits,
  buildInboundCapChecks,
  peekInboundThrottle,
  chargeInboundTickets,
  type InboundCapLimits,
} from './inboundRateLimit';

// ---------------------------------------------------------------------------
// A faithful in-memory ZSET fake, enough to exercise the real peek/charge code
// against genuine sorted-set semantics: zadd (member→score), zcount over a
// score range, zremrangebyscore, expire, and a multi() that queues + applies.
// This lets the tests observe RESIDUAL STATE — the exact thing the mocked-primitive
// tests could not (Codex review #6, finding 1).
// ---------------------------------------------------------------------------
function parseScore(v: number | string): number {
  if (typeof v === 'number') return v;
  if (v === '-inf' || v === '-Infinity') return -Infinity;
  if (v === '+inf' || v === '+Infinity' || v === 'inf') return Infinity;
  return Number(v);
}

class FakeRedis {
  private sets = new Map<string, Map<string, number>>();
  throwOnce = false;

  private zset(key: string): Map<string, number> {
    let z = this.sets.get(key);
    if (!z) { z = new Map(); this.sets.set(key, z); }
    return z;
  }

  async zadd(key: string, score: number, member: string): Promise<number> {
    const z = this.zset(key);
    const isNew = !z.has(member);
    z.set(member, score);
    return isNew ? 1 : 0;
  }

  async zcount(key: string, min: number | string, max: number | string): Promise<number> {
    if (this.throwOnce) { this.throwOnce = false; throw new Error('redis boom'); }
    const lo = parseScore(min);
    const hi = parseScore(max);
    const z = this.sets.get(key);
    if (!z) return 0;
    let n = 0;
    for (const s of z.values()) if (s >= lo && s <= hi) n += 1;
    return n;
  }

  async zremrangebyscore(key: string, min: number | string, max: number | string): Promise<number> {
    const lo = parseScore(min);
    const hi = parseScore(max);
    const z = this.sets.get(key);
    if (!z) return 0;
    let removed = 0;
    for (const [m, s] of [...z.entries()]) {
      if (s >= lo && s <= hi) { z.delete(m); removed += 1; }
    }
    return removed;
  }

  async expire(): Promise<number> { return 1; }

  multi(): FakeMulti { return new FakeMulti(this); }

  /** Test helper: number of members currently inside [windowStart, +inf). */
  countInWindow(key: string, windowStart: number): number {
    const z = this.sets.get(key);
    if (!z) return 0;
    let n = 0;
    for (const s of z.values()) if (s >= windowStart) n += 1;
    return n;
  }
}

class FakeMulti {
  private ops: Array<() => Promise<unknown>> = [];
  constructor(private redis: FakeRedis) {}
  zremrangebyscore(key: string, min: number | string, max: number | string): this {
    this.ops.push(() => this.redis.zremrangebyscore(key, min, max)); return this;
  }
  zadd(key: string, score: number, member: string): this {
    this.ops.push(() => this.redis.zadd(key, score, member)); return this;
  }
  expire(): this { this.ops.push(() => this.redis.expire()); return this; }
  async exec(): Promise<unknown[]> {
    const out: unknown[] = [];
    for (const op of this.ops) out.push([null, await op()]);
    return out;
  }
}

const asRedis = (f: FakeRedis) => f as unknown as Redis;
const LIMITS: InboundCapLimits = { perSenderPerHour: 30, perDomainPerHour: 200, perPartnerPerHour: 1000 };

describe('resolveInboundCapLimits', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.INBOUND_MAX_PER_SENDER_PER_HOUR = '30';
    process.env.INBOUND_MAX_PER_DOMAIN_PER_HOUR = '200';
    process.env.INBOUND_MAX_PER_PARTNER_PER_HOUR = '1000';
  });
  afterEach(() => { process.env = { ...saved }; });

  it('falls back to env defaults when overrides are null', () => {
    expect(resolveInboundCapLimits({
      maxTicketsPerSenderPerHour: null, maxTicketsPerDomainPerHour: null, maxTicketsPerPartnerPerHour: null,
    })).toEqual({ perSenderPerHour: 30, perDomainPerHour: 200, perPartnerPerHour: 1000 });
  });

  it('lets a partner override win, including 0 (unlimited)', () => {
    expect(resolveInboundCapLimits({
      maxTicketsPerSenderPerHour: 5, maxTicketsPerDomainPerHour: 0, maxTicketsPerPartnerPerHour: null,
    })).toEqual({ perSenderPerHour: 5, perDomainPerHour: 0, perPartnerPerHour: 1000 });
  });
});

describe('buildInboundCapChecks', () => {
  it('namespaces keys by partner, lowercases the sender, tightest→broadest order', () => {
    expect(buildInboundCapChecks('p1', 'Jane@ACME.com', LIMITS).map((c) => c.key)).toEqual([
      'inbound:tix:sender:p1:jane@acme.com',
      'inbound:tix:sdom:p1:acme.com',
      'inbound:tix:partner:p1',
    ]);
  });

  it('skips a window whose limit is 0 (unlimited)', () => {
    const checks = buildInboundCapChecks('p1', 'jane@acme.com', { perSenderPerHour: 0, perDomainPerHour: 0, perPartnerPerHour: 1000 });
    expect(checks.map((c) => c.bucket)).toEqual(['partner']);
  });

  it('skips the domain window when the sender address has no parseable domain', () => {
    expect(buildInboundCapChecks('p1', 'not-an-address', LIMITS).map((c) => c.bucket)).toEqual(['sender', 'partner']);
  });

  it('returns [] when every window is unlimited (caller then skips Redis)', () => {
    expect(buildInboundCapChecks('p1', 'jane@acme.com', { perSenderPerHour: 0, perDomainPerHour: 0, perPartnerPerHour: 0 })).toEqual([]);
  });
});

describe('peekInboundThrottle (read-only)', () => {
  it('passes when every window has room, and mutates nothing', async () => {
    const r = new FakeRedis();
    const checks = buildInboundCapChecks('p1', 'jane@acme.com', LIMITS);
    const v = await peekInboundThrottle(asRedis(r), checks);
    expect(v).toEqual({ throttled: false, bucket: null });
    // A peek must never create members.
    for (const c of checks) expect(r.countInWindow(c.key, 0)).toBe(0);
  });

  it('throttles on the tightest full window (sender) first', async () => {
    const r = new FakeRedis();
    const now = Date.now();
    // Fill the sender window to its limit of 1.
    const checks = buildInboundCapChecks('p1', 'jane@acme.com', { perSenderPerHour: 1, perDomainPerHour: 200, perPartnerPerHour: 1000 });
    await chargeInboundTickets(asRedis(r), checks, 'seed', now);
    const v = await peekInboundThrottle(asRedis(r), checks, now);
    expect(v).toEqual({ throttled: true, bucket: 'sender' });
  });

  it('reports the partner window when only it is full', async () => {
    const r = new FakeRedis();
    const now = Date.now();
    const partnerKey = 'inbound:tix:partner:p1';
    await r.zadd(partnerKey, now, 'x'); // partner window has 1, limit 1
    const checks = buildInboundCapChecks('p1', 'jane@acme.com', { perSenderPerHour: 30, perDomainPerHour: 200, perPartnerPerHour: 1 });
    expect(await peekInboundThrottle(asRedis(r), checks, now)).toEqual({ throttled: true, bucket: 'partner' });
  });

  it('ignores members outside the 1h window (uses the live count)', async () => {
    const r = new FakeRedis();
    const now = Date.now();
    const checks = buildInboundCapChecks('p1', 'jane@acme.com', { perSenderPerHour: 1, perDomainPerHour: 200, perPartnerPerHour: 1000 });
    // A stale member two hours old must NOT count toward the window.
    await r.zadd(checks[0]!.key, now - 2 * 60 * 60 * 1000, 'stale');
    expect(await peekInboundThrottle(asRedis(r), checks, now)).toEqual({ throttled: false, bucket: null });
  });

  it('fails OPEN on empty checks or a null client, doing no Redis work', async () => {
    expect(await peekInboundThrottle(null, buildInboundCapChecks('p1', 'jane@acme.com', LIMITS))).toEqual({ throttled: false, bucket: null });
    expect(await peekInboundThrottle(asRedis(new FakeRedis()), [])).toEqual({ throttled: false, bucket: null });
  });

  it('fails OPEN (not throttled) when the Redis read throws', async () => {
    const r = new FakeRedis();
    r.throwOnce = true;
    const checks = buildInboundCapChecks('p1', 'jane@acme.com', LIMITS);
    expect(await peekInboundThrottle(asRedis(r), checks)).toEqual({ throttled: false, bucket: null });
  });
});

describe('chargeInboundTickets', () => {
  it('records one member per window and is idempotent per dedupeMember', async () => {
    const r = new FakeRedis();
    const now = Date.now();
    const checks = buildInboundCapChecks('p1', 'jane@acme.com', LIMITS);
    await chargeInboundTickets(asRedis(r), checks, 'pmid-1', now);
    await chargeInboundTickets(asRedis(r), checks, 'pmid-1', now); // redelivery of SAME message
    for (const c of checks) expect(r.countInWindow(c.key, now - 60 * 60 * 1000)).toBe(1);
  });

  it('is a no-op with a null client or empty checks', async () => {
    await expect(chargeInboundTickets(null, buildInboundCapChecks('p1', 'jane@acme.com', LIMITS), 'm')).resolves.toBeUndefined();
    await expect(chargeInboundTickets(asRedis(new FakeRedis()), [], 'm')).resolves.toBeUndefined();
  });
});

describe('no residual charge across buckets (Codex review #6, finding 1)', () => {
  it('a message quarantined by the partner window leaves NO charge in the sender/domain windows', async () => {
    const r = new FakeRedis();
    const now = Date.now();
    // partner=1 (the binding window); sender/domain generous.
    const limits: InboundCapLimits = { perSenderPerHour: 30, perDomainPerHour: 200, perPartnerPerHour: 1 };
    const checksA = buildInboundCapChecks('p1', 'jane@acme.com', limits);

    // Message A: peek OK, ticket created, so the worker charges all three windows.
    expect((await peekInboundThrottle(asRedis(r), checksA, now)).throttled).toBe(false);
    await chargeInboundTickets(asRedis(r), checksA, 'A', now);

    // Message B (same sender/domain/partner): peek now sees the partner window full.
    const checksB = buildInboundCapChecks('p1', 'jane@acme.com', limits);
    const verdictB = await peekInboundThrottle(asRedis(r), checksB, now);
    expect(verdictB).toEqual({ throttled: true, bucket: 'partner' });
    // B is throttled ⇒ the worker records NO charge for it. The OLD charge-then-check
    // design left B's member in the sender + domain windows even though B made no
    // ticket; here those windows still hold ONLY A.
    const senderKey = 'inbound:tix:sender:p1:jane@acme.com';
    const domainKey = 'inbound:tix:sdom:p1:acme.com';
    expect(r.countInWindow(senderKey, now - 60 * 60 * 1000)).toBe(1);
    expect(r.countInWindow(domainKey, now - 60 * 60 * 1000)).toBe(1);

    // And once partner capacity frees up, Jane's sender window is not polluted:
    // draining the partner window lets a fresh peek pass again.
    await r.zremrangebyscore('inbound:tix:partner:p1', '-inf', '+inf');
    expect((await peekInboundThrottle(asRedis(r), buildInboundCapChecks('p1', 'jane@acme.com', limits), now)).throttled).toBe(false);
  });
});
