import { beforeEach, describe, expect, it, vi } from 'vitest';

// #6130 / #1105 — `rateLimiter` is a Redis round-trip. Called inside a held
// `withDbAccessContext` transaction it pins a pooled Postgres connection
// idle-in-transaction across that round-trip, which is exactly when Redis is
// slow that pool pressure hurts most. The tripwire was previously wired only
// into `bullmq.add`/`addBulk` and `safeFetch`, so rate-limit call sites were
// invisible in logs and the real call-site list had to come from grep.
//
// This suite pins the WIRING (the guard is called, with a low-cardinality
// label, before any Redis work). rate-limit.test.ts exercises the real guard,
// which is a no-op outside any context.
const { assertSpy } = vi.hoisted(() => ({ assertSpy: vi.fn() }));
vi.mock('../db', () => ({
  assertOutsideHeldDbContext: assertSpy,
}));

import { rateLimiter } from './rate-limit';

function makeRedis() {
  const exec = vi.fn().mockResolvedValue([
    [null, 0],
    [null, 1],
    [null, 1],
    [null, []],
    [null, 1],
  ]);
  const chain: Record<string, unknown> = {};
  for (const m of ['zremrangebyscore', 'zadd', 'zcard', 'zrange', 'expire']) {
    chain[m] = vi.fn(() => chain);
  }
  chain.exec = exec;
  return { multi: vi.fn(() => chain), exec } as unknown as Parameters<typeof rateLimiter>[0] & {
    exec: typeof exec;
  };
}

describe('rateLimiter #1105 tripwire (#6130)', () => {
  beforeEach(() => {
    assertSpy.mockClear();
  });

  it('calls assertOutsideHeldDbContext before any Redis work, labelled with the key bucket', async () => {
    const redis = makeRedis();
    await rateLimiter(redis, 'elevation:rate:device:device-1', 10, 60);

    expect(assertSpy).toHaveBeenCalledTimes(1);
    expect(assertSpy).toHaveBeenCalledWith('rateLimiter(elevation)');
  });

  it('labels with the bucket only — no device/user/email id leaks into the label', async () => {
    const redis = makeRedis();
    await rateLimiter(redis, 'login:alice@example.com', 5, 300);

    expect(assertSpy).toHaveBeenCalledWith('rateLimiter(login)');
  });

  it('fires even on the fail-closed path where Redis is unavailable', async () => {
    const result = await rateLimiter(null, 'eventlog:rate:device:device-1', 10, 60);

    expect(result.allowed).toBe(false);
    expect(assertSpy).toHaveBeenCalledWith('rateLimiter(eventlog)');
  });

  it('propagates a strict-mode throw instead of swallowing it into fail-closed', async () => {
    // The guard throws under DB_CONTEXT_TRIPWIRE_STRICT. If the call sat inside
    // rateLimiter's own try/catch the throw would be caught and downgraded to a
    // silent fail-closed deny, which is precisely how a new violation would
    // stay invisible in CI.
    assertSpy.mockImplementationOnce(() => {
      throw new Error('rateLimiter ran inside a held withDbAccessContext transaction (#1105)');
    });
    const redis = makeRedis();
    await expect(rateLimiter(redis, 'mfa:user-1', 5, 300)).rejects.toThrow(/#1105/);
  });
});
