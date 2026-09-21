import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Redis } from 'ioredis';
import {
  resolveInboundCapLimits,
  buildInboundCapChecks,
  admitInboundTicket,
  releaseInboundCharges,
  type InboundCapLimits,
} from './inboundRateLimit';

// ---------------------------------------------------------------------------
// A faithful in-memory ZSET fake — enough to run the REAL shared `rateLimiter`
// (services/rate-limit.ts) against genuine sorted-set semantics, including its
// MULTI [zremrangebyscore, zadd, zcard, zrange WITHSCORES, expire]. This lets the
// tests prove the atomic-admission property (limit holds exactly under back-to-
// back admits) and the refund path (Codex review #7, finding 1) against real code
// rather than a mocked primitive.
// ---------------------------------------------------------------------------
function parseScore(v: number | string): number {
  if (typeof v === 'number') return v;
  if (v === '-inf') return -Infinity;
  if (v === '+inf' || v === 'inf') return Infinity;
  return Number(v);
}

class FakeRedis {
  sets = new Map<string, Map<string, number>>();
  private z(key: string): Map<string, number> {
    let s = this.sets.get(key);
    if (!s) { s = new Map(); this.sets.set(key, s); }
    return s;
  }
  async zadd(key: string, score: number, member: string): Promise<number> {
    const s = this.z(key); const isNew = !s.has(member); s.set(member, score); return isNew ? 1 : 0;
  }
  async zcard(key: string): Promise<number> { return this.sets.get(key)?.size ?? 0; }
  async zcount(key: string, min: number | string, max: number | string): Promise<number> {
    const lo = parseScore(min); const hi = parseScore(max); const s = this.sets.get(key);
    if (!s) return 0; let n = 0; for (const v of s.values()) if (v >= lo && v <= hi) n += 1; return n;
  }
  async zremrangebyscore(key: string, min: number | string, max: number | string): Promise<number> {
    const lo = parseScore(min); const hi = parseScore(max); const s = this.sets.get(key);
    if (!s) return 0; let removed = 0;
    for (const [m, v] of [...s.entries()]) if (v >= lo && v <= hi) { s.delete(m); removed += 1; }
    return removed;
  }
  async zrem(key: string, member: string): Promise<number> {
    const s = this.sets.get(key); if (!s) return 0; return s.delete(member) ? 1 : 0;
  }
  // zrange(key, 0, 0, 'WITHSCORES') → [lowestMember, scoreString]
  async zrange(key: string, start: number, stop: number, withScores?: string): Promise<string[]> {
    const s = this.sets.get(key); if (!s) return [];
    const sorted = [...s.entries()].sort((a, b) => a[1] - b[1]);
    const slice = sorted.slice(start, stop < 0 ? undefined : stop + 1);
    if (withScores) return slice.flatMap(([m, sc]) => [m, String(sc)]);
    return slice.map(([m]) => m);
  }
  async expire(): Promise<number> { return 1; }
  multi(): FakeMulti { return new FakeMulti(this); }
  countInWindow(key: string, windowStart: number): number {
    const s = this.sets.get(key); if (!s) return 0;
    let n = 0; for (const v of s.values()) if (v >= windowStart) n += 1; return n;
  }
}

class FakeMulti {
  private ops: Array<() => Promise<unknown>> = [];
  constructor(private r: FakeRedis) {}
  zremrangebyscore(k: string, a: number | string, b: number | string): this { this.ops.push(() => this.r.zremrangebyscore(k, a, b)); return this; }
  zadd(k: string, score: number, member: string): this { this.ops.push(() => this.r.zadd(k, score, member)); return this; }
  zcard(k: string): this { this.ops.push(() => this.r.zcard(k)); return this; }
  zrange(k: string, a: number, b: number, ws?: string): this { this.ops.push(() => this.r.zrange(k, a, b, ws)); return this; }
  expire(): this { this.ops.push(() => this.r.expire()); return this; }
  async exec(): Promise<unknown[]> { const out: unknown[] = []; for (const op of this.ops) out.push([null, await op()]); return out; }
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
    expect(buildInboundCapChecks('p1', 'jane@acme.com', { perSenderPerHour: 0, perDomainPerHour: 0, perPartnerPerHour: 1000 }).map((c) => c.bucket)).toEqual(['partner']);
  });
  it('skips the domain window when the sender address has no parseable domain', () => {
    expect(buildInboundCapChecks('p1', 'not-an-address', LIMITS).map((c) => c.bucket)).toEqual(['sender', 'partner']);
  });
  it('returns [] when every window is unlimited (caller then skips Redis)', () => {
    expect(buildInboundCapChecks('p1', 'jane@acme.com', { perSenderPerHour: 0, perDomainPerHour: 0, perPartnerPerHour: 0 })).toEqual([]);
  });
});

describe('admitInboundTicket', () => {
  it('admits when every window has room and reports the charged keys', async () => {
    const r = new FakeRedis();
    const checks = buildInboundCapChecks('p1', 'jane@acme.com', LIMITS);
    const { verdict, chargedKeys } = await admitInboundTicket(asRedis(r), checks, 'msg-1');
    expect(verdict).toEqual({ throttled: false, bucket: null });
    expect(chargedKeys).toEqual(checks.map((c) => c.key));
    for (const c of checks) expect(r.countInWindow(c.key, 0)).toBe(1);
  });

  it('throttles at the tightest full window and stops there', async () => {
    const r = new FakeRedis();
    const checks = buildInboundCapChecks('p1', 'jane@acme.com', { perSenderPerHour: 1, perDomainPerHour: 200, perPartnerPerHour: 1000 });
    await admitInboundTicket(asRedis(r), checks, 'a'); // fills the sender window (limit 1)
    const { verdict, chargedKeys } = await admitInboundTicket(asRedis(r), checks, 'b');
    expect(verdict).toEqual({ throttled: true, bucket: 'sender' });
    // Short-circuits at sender: only the sender window was charged (then to be refunded).
    expect(chargedKeys).toEqual(['inbound:tix:sender:p1:jane@acme.com']);
  });

  it('fails OPEN with a null client (nothing charged, not throttled)', async () => {
    const { verdict, chargedKeys } = await admitInboundTicket(null, buildInboundCapChecks('p1', 'jane@acme.com', LIMITS), 'm');
    expect(verdict).toEqual({ throttled: false, bucket: null });
    expect(chargedKeys).toEqual([]);
  });

  it('is a no-op with empty checks', async () => {
    const { verdict, chargedKeys } = await admitInboundTicket(asRedis(new FakeRedis()), [], 'm');
    expect(verdict).toEqual({ throttled: false, bucket: null });
    expect(chargedKeys).toEqual([]);
  });
});

describe('exact under concurrency (Codex review #7, finding 1)', () => {
  it('a limit of 1 admits exactly ONE of two back-to-back messages', async () => {
    const r = new FakeRedis();
    const limits: InboundCapLimits = { perSenderPerHour: 30, perDomainPerHour: 200, perPartnerPerHour: 1 };
    const checks = () => buildInboundCapChecks('p1', 'jane@acme.com', limits);

    // Two DIFFERENT messages competing for the single partner slot. Because admit
    // charges-and-checks atomically (ZADD then ZCARD in one MULTI), the second sees
    // its own charge in the count and is rejected — no over-admission.
    const a = await admitInboundTicket(asRedis(r), checks(), 'A');
    const b = await admitInboundTicket(asRedis(r), checks(), 'B');
    expect(a.verdict.throttled).toBe(false);
    expect(b.verdict).toEqual({ throttled: true, bucket: 'partner' });
  });

  it('refunding a non-creating message frees the slot (no residual charge)', async () => {
    const r = new FakeRedis();
    const limits: InboundCapLimits = { perSenderPerHour: 30, perDomainPerHour: 200, perPartnerPerHour: 1 };
    const senderKey = 'inbound:tix:sender:p1:jane@acme.com';

    // A admits and creates a ticket (kept). B admits, is throttled by partner, and
    // is refunded because it created nothing — the sender/domain windows it touched
    // before the partner window must NOT retain B.
    await admitInboundTicket(asRedis(r), buildInboundCapChecks('p1', 'jane@acme.com', limits), 'A');
    const b = await admitInboundTicket(asRedis(r), buildInboundCapChecks('p1', 'jane@acme.com', limits), 'B');
    expect(b.verdict.throttled).toBe(true);
    await releaseInboundCharges(asRedis(r), b.chargedKeys, 'B'); // worker refunds non-creations

    // Only A remains in the sender window; B left no residual.
    expect(r.countInWindow(senderKey, 0)).toBe(1);

    // Drain the partner window (A's ticket aged out) and a fresh message admits again.
    await r.zremrangebyscore('inbound:tix:partner:p1', '-inf', '+inf');
    const c = await admitInboundTicket(asRedis(r), buildInboundCapChecks('p1', 'jane@acme.com', limits), 'C');
    expect(c.verdict.throttled).toBe(false);
  });
});

describe('redelivery cannot free the original charge (Codex review #8, finding 1)', () => {
  it('a redelivery uses its OWN reservation, so refunding it leaves the original slot intact', async () => {
    const r = new FakeRedis();
    // Room to spare so the redelivery is not throttled — it transiently occupies a
    // second slot, then the worker refunds it (the dedup path creates no ticket).
    const limits: InboundCapLimits = { perSenderPerHour: 5, perDomainPerHour: 200, perPartnerPerHour: 1000 };
    const senderKey = 'inbound:tix:sender:p1:jane@acme.com';
    const checks = () => buildInboundCapChecks('p1', 'jane@acme.com', limits);

    // First delivery of message M: reservation M-attempt-1, creates a ticket → KEEP.
    const first = await admitInboundTicket(asRedis(r), checks(), 'M-attempt-1');
    expect(first.verdict.throttled).toBe(false);
    expect(r.countInWindow(senderKey, 0)).toBe(1);

    // Redelivery of the SAME message M: a DIFFERENT reservation. It transiently
    // charges a second slot...
    const redelivery = await admitInboundTicket(asRedis(r), checks(), 'M-attempt-2');
    expect(redelivery.verdict.throttled).toBe(false);
    expect(r.countInWindow(senderKey, 0)).toBe(2);
    // ...then the worker refunds it because the pipeline dedups (no new ticket).
    await releaseInboundCharges(asRedis(r), redelivery.chargedKeys, 'M-attempt-2');

    // The original delivery's charge is UNTOUCHED — a shared-member refund would
    // have removed it and freed the cap; here the window stays at exactly 1.
    expect(r.countInWindow(senderKey, 0)).toBe(1);
  });

  it('a redelivery throttled at a full window still refunds only its own slot', async () => {
    const r = new FakeRedis();
    const limits: InboundCapLimits = { perSenderPerHour: 1, perDomainPerHour: 200, perPartnerPerHour: 1000 };
    const senderKey = 'inbound:tix:sender:p1:jane@acme.com';
    const checks = () => buildInboundCapChecks('p1', 'jane@acme.com', limits);

    await admitInboundTicket(asRedis(r), checks(), 'M-attempt-1'); // creates, kept (count 1, limit 1)
    const redelivery = await admitInboundTicket(asRedis(r), checks(), 'M-attempt-2');
    expect(redelivery.verdict).toEqual({ throttled: true, bucket: 'sender' });
    await releaseInboundCharges(asRedis(r), redelivery.chargedKeys, 'M-attempt-2');
    expect(r.countInWindow(senderKey, 0)).toBe(1); // original survives
  });
});

describe('releaseInboundCharges', () => {
  it('removes the message from each charged window and is a no-op when empty/null', async () => {
    const r = new FakeRedis();
    const checks = buildInboundCapChecks('p1', 'jane@acme.com', LIMITS);
    const { chargedKeys } = await admitInboundTicket(asRedis(r), checks, 'm1');
    await releaseInboundCharges(asRedis(r), chargedKeys, 'm1');
    for (const c of checks) expect(r.countInWindow(c.key, 0)).toBe(0);
    await expect(releaseInboundCharges(null, chargedKeys, 'm1')).resolves.toBeUndefined();
    await expect(releaseInboundCharges(asRedis(r), [], 'm1')).resolves.toBeUndefined();
  });
});
