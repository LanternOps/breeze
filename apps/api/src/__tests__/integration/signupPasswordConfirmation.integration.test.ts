/**
 * The signup-password attempt cap runs its reservation as a Lua script on
 * Redis. These tests run that script on a real Redis server (REDIS_URL), so the
 * script text itself is exercised: concurrent attempts are capped, and the
 * attempt window gets its expiry.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { hashPassword, verifyPassword } from '../../services/password';
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
