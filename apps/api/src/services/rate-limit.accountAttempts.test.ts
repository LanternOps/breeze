import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';
import { releaseAccountAttempt, reserveAccountAttempt } from './rate-limit';

// Per-account sign-in attempts are reserved before the credential is checked.
// The Lua script itself runs against real Redis in
// __tests__/integration/signupPasswordConfirmation.integration.test.ts; these
// tests cover how the reply is read and the fail-closed paths.

// The limit and window are read from the environment at call time.
describe('reserveAccountAttempt', () => {
  beforeEach(() => {
    delete process.env.LOGIN_ACCOUNT_LOCKOUT_MAX;
    delete process.env.LOGIN_ACCOUNT_LOCKOUT_WINDOW_SECONDS;
  });
  afterEach(() => {
    delete process.env.LOGIN_ACCOUNT_LOCKOUT_MAX;
    delete process.env.LOGIN_ACCOUNT_LOCKOUT_WINDOW_SECONDS;
  });

  it('counts the attempt in one script call keyed on the normalized email, with the window on first use', async () => {
    const redis = { eval: vi.fn(async () => 1) };

    const reservation = await reserveAccountAttempt(redis as unknown as Redis, 'Victim@Example.com');

    expect(reservation).toEqual({ allowed: true, count: 1, reachesLimit: false });
    expect(redis.eval).toHaveBeenCalledTimes(1);
    const [script, numKeys, key, window] = redis.eval.mock.calls[0] as unknown as [string, number, string, string];
    expect(script).toContain("redis.call('INCR', KEYS[1])");
    expect(script).toContain("if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end");
    expect(numKeys).toBe(1);
    expect(key).toBe('login:account-fail:victim@example.com');
    expect(window).toBe('900');
  });

  it.each([
    [4, { allowed: true, count: 4, reachesLimit: false }],
    [5, { allowed: true, count: 5, reachesLimit: true }],
    [6, { allowed: false, count: 6, reachesLimit: false }],
  ])('reads reply %i as %j with the default limit of 5', async (reply, expected) => {
    const redis = { eval: vi.fn(async () => reply) };

    expect(await reserveAccountAttempt(redis as unknown as Redis, 'victim@example.com')).toEqual(expected);
  });

  it('refuses when Redis is missing or fails, as the lockout check always has', async () => {
    const failing = { eval: vi.fn(async () => { throw new Error('redis down'); }) };

    expect((await reserveAccountAttempt(null, 'victim@example.com')).allowed).toBe(false);
    expect((await reserveAccountAttempt(failing as unknown as Redis, 'victim@example.com')).allowed).toBe(false);
  });

  it('allows without touching Redis when the lockout is turned off (LOGIN_ACCOUNT_LOCKOUT_MAX=0)', async () => {
    process.env.LOGIN_ACCOUNT_LOCKOUT_MAX = '0';
    const redis = { eval: vi.fn() };

    expect(await reserveAccountAttempt(redis as unknown as Redis, 'victim@example.com')).toEqual({ allowed: true, count: 0, reachesLimit: false });
    expect(await reserveAccountAttempt(null, 'victim@example.com')).toEqual({ allowed: true, count: 0, reachesLimit: false });
    expect(redis.eval).not.toHaveBeenCalled();
  });
});

describe('releaseAccountAttempt', () => {
  it('gives the reserved attempt back and removes the counter at zero', async () => {
    const redis = { eval: vi.fn(async () => 0) };

    await releaseAccountAttempt(redis as unknown as Redis, 'Victim@Example.com');

    const [script, , key] = redis.eval.mock.calls[0] as unknown as [string, number, string];
    expect(script).toContain("redis.call('DECR', KEYS[1])");
    expect(script).toContain("redis.call('DEL', KEYS[1])");
    expect(key).toBe('login:account-fail:victim@example.com');
  });

  it('is best-effort', async () => {
    const failing = { eval: vi.fn(async () => { throw new Error('redis down'); }) };

    await expect(releaseAccountAttempt(failing as unknown as Redis, 'victim@example.com')).resolves.toBeUndefined();
    await expect(releaseAccountAttempt(null, 'victim@example.com')).resolves.toBeUndefined();
  });
});
