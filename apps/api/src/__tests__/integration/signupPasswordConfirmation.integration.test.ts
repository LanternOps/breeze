/**
 * The signup-password attempt cap and the per-account sign-in lockout reserve
 * attempts with Lua scripts on Redis. These tests run those scripts on a real
 * Redis server (REDIS_URL), so the script text itself is exercised: concurrent
 * attempts are capped, the window gets its expiry once, and later attempts do
 * not extend it.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { hashPassword, verifyPassword } from '../../services/password';
import { getAccountLockoutMax, releaseAccountAttempt, reserveAccountAttempt } from '../../services/rate-limit';
import {
  SIGNUP_PASSWORD_MAX_ATTEMPTS,
  checkSignupPassword,
  signupPasswordAttemptKey,
} from '../../services/signupPasswordConfirmation';

vi.mock('../../services/password', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/password')>();
  return { ...actual, verifyPassword: vi.fn(actual.verifyPassword) };
});

const RUN = !!process.env.REDIS_URL;

describe.skipIf(!RUN)('signup password attempts against real Redis', () => {
  const redis = RUN ? new Redis(process.env.REDIS_URL!, { lazyConnect: false, maxRetriesPerRequest: 1 }) : (null as never);
  let passwordHash: string;

  afterAll(async () => {
    await redis?.quit();
  });

  beforeEach(async () => {
    passwordHash ??= await hashPassword('Signup-password-1');
    vi.mocked(verifyPassword).mockClear();
  });

  it('starts the attempt window with an expiry on the first wrong password', async () => {
    const tokenHash = `it-${randomUUID()}`;

    await checkSignupPassword({ redis, tokenHash, passwordHash, password: 'wrong' });

    const key = signupPasswordAttemptKey(tokenHash);
    expect(await redis.get(key)).toBe('1');
    const ttl = await redis.ttl(key);
    expect(ttl).toBeGreaterThan(0);
    await redis.del(key);
  });

  it(`runs at most ${SIGNUP_PASSWORD_MAX_ATTEMPTS} password checks for concurrent attempts on one link`, async () => {
    const tokenHash = `it-${randomUUID()}`;

    const outcomes = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        checkSignupPassword({ redis, tokenHash, passwordHash, password: `wrong-${i}` })),
    );

    expect(verifyPassword).toHaveBeenCalledTimes(SIGNUP_PASSWORD_MAX_ATTEMPTS);
    expect(outcomes.filter((o) => !o.ok && o.reason === 'attempts_exhausted')).toHaveLength(12 - (SIGNUP_PASSWORD_MAX_ATTEMPTS - 1));
    await redis.del(signupPasswordAttemptKey(tokenHash));
  });

  it('clears the counter when the right password is given', async () => {
    const tokenHash = `it-${randomUUID()}`;
    await checkSignupPassword({ redis, tokenHash, passwordHash, password: 'wrong' });

    const outcome = await checkSignupPassword({ redis, tokenHash, passwordHash, password: 'Signup-password-1' });

    expect(outcome).toEqual({ ok: true });
    expect(await redis.exists(signupPasswordAttemptKey(tokenHash))).toBe(0);
  });
});

describe.skipIf(!RUN)('account sign-in attempts against real Redis', () => {
  const redis = RUN ? new Redis(process.env.REDIS_URL!, { lazyConnect: false, maxRetriesPerRequest: 1 }) : (null as never);
  const key = (email: string) => `login:account-fail:${email}`;

  afterAll(async () => {
    await redis?.quit();
  });

  it('honours at most the lockout limit for concurrent attempts on one account', async () => {
    const email = `it-${randomUUID()}@example.test`;

    const reservations = await Promise.all(Array.from({ length: 12 }, () => reserveAccountAttempt(redis, email)));

    expect(reservations.filter((r) => r.allowed)).toHaveLength(getAccountLockoutMax());
    expect(reservations.filter((r) => r.reachesLimit)).toHaveLength(1);
    await redis.del(key(email));
  });

  it('sets the window on the first attempt and does not extend it on later ones, even while locked', async () => {
    const email = `it-${randomUUID()}@example.test`;

    await reserveAccountAttempt(redis, email);
    expect(await redis.ttl(key(email))).toBeGreaterThan(0);

    // Shorten the window, then keep trying past the limit: the expiry must not move.
    await redis.pexpire(key(email), 5_000);
    for (let i = 0; i < getAccountLockoutMax() + 2; i += 1) await reserveAccountAttempt(redis, email);
    const remaining = await redis.pttl(key(email));
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(5_000);
    await redis.del(key(email));
  });

  it('gives back an attempt whose credential was correct', async () => {
    const email = `it-${randomUUID()}@example.test`;
    await reserveAccountAttempt(redis, email);
    await reserveAccountAttempt(redis, email);

    await releaseAccountAttempt(redis, email);
    expect(await redis.get(key(email))).toBe('1');

    await releaseAccountAttempt(redis, email);
    expect(await redis.exists(key(email))).toBe(0);
  });
});
