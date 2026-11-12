import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashPassword, verifyPassword } from './password';

vi.mock('./password', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./password')>();
  return { ...actual, verifyPassword: vi.fn(actual.verifyPassword) };
});
import {
  SIGNUP_PASSWORD_MAX_ATTEMPTS,
  checkSignupPassword,
  signupPasswordAttemptKey,
} from './signupPasswordConfirmation';

// Behaves like Redis for the commands used: each command is atomic, and every
// reply arrives on a later tick, so concurrent callers interleave between
// commands exactly as they would against a real server.
function fakeRedis(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  const expiries = new Map<string, number>();
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const incrWithExpiry = (key: string, seconds: number) => {
    const next = Number(store.get(key) ?? '0') + 1;
    store.set(key, String(next));
    if (next === 1) expiries.set(key, seconds);
    return next;
  };
  return {
    store,
    expiries,
    get: vi.fn(async (key: string) => { await tick(); return store.get(key) ?? null; }),
    incr: vi.fn(async (key: string) => {
      await tick();
      const next = Number(store.get(key) ?? '0') + 1;
      store.set(key, String(next));
      return next;
    }),
    expire: vi.fn(async (key: string, seconds: number) => {
      await tick();
      expiries.set(key, seconds);
      return 1;
    }),
    del: vi.fn(async (key: string) => { await tick(); return store.delete(key) ? 1 : 0; }),
    // The only script the service runs: INCR, and EXPIRE on the first increment.
    eval: vi.fn(async (_script: string, _numKeys: number, key: string, seconds: string) => {
      const next = incrWithExpiry(key, Number(seconds));
      await tick();
      return next;
    }),
  };
}

function fakeAccount(locked = false) {
  return {
    isLocked: vi.fn(async () => locked),
    recordFailure: vi.fn(async () => undefined),
    clearFailures: vi.fn(async () => undefined),
  };
}

let passwordHash: string;
beforeAll(async () => {
  passwordHash = await hashPassword('Signup-password-1');
});

describe('checkSignupPassword', () => {
  beforeEach(() => vi.mocked(verifyPassword).mockClear());

  it(`runs at most ${SIGNUP_PASSWORD_MAX_ATTEMPTS} password checks for one link, even concurrently`, async () => {
    const redis = fakeRedis();

    const outcomes = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        checkSignupPassword({ redis: redis as any, tokenHash: 't1', passwordHash, password: `wrong-${i}` })),
    );

    expect(verifyPassword).toHaveBeenCalledTimes(SIGNUP_PASSWORD_MAX_ATTEMPTS);
    expect(outcomes.filter((o) => !o.ok && o.reason === 'password_mismatch')).toHaveLength(SIGNUP_PASSWORD_MAX_ATTEMPTS - 1);
    expect(outcomes.filter((o) => !o.ok && o.reason === 'attempts_exhausted')).toHaveLength(12 - (SIGNUP_PASSWORD_MAX_ATTEMPTS - 1));
  });

  it('refuses without checking the password when the attempt counter is unavailable', async () => {
    const redis = fakeRedis();
    redis.eval.mockRejectedValueOnce(new Error('redis down'));
    redis.incr.mockRejectedValueOnce(new Error('redis down'));
    redis.get.mockRejectedValueOnce(new Error('redis down'));

    const outcome = await checkSignupPassword({ redis: redis as any, tokenHash: 't1', passwordHash, password: 'Signup-password-1' });

    expect(outcome).toEqual({ ok: false, reason: 'check_unavailable' });
    expect(verifyPassword).not.toHaveBeenCalled();
  });

  it('asks for the password without counting an attempt when none is sent', async () => {
    const redis = fakeRedis();
    const account = fakeAccount();

    const outcome = await checkSignupPassword({ redis: redis as any, tokenHash: 't1', passwordHash, password: undefined, account });

    expect(outcome).toEqual({ ok: false, reason: 'password_required' });
    expect(redis.incr).not.toHaveBeenCalled();
    expect(account.recordFailure).not.toHaveBeenCalled();
  });

  it('counts a wrong password against the link and the account', async () => {
    const redis = fakeRedis();
    const account = fakeAccount();

    const outcome = await checkSignupPassword({ redis: redis as any, tokenHash: 't1', passwordHash, password: 'wrong', account });

    expect(outcome).toEqual({ ok: false, reason: 'password_mismatch' });
    expect(redis.store.get(signupPasswordAttemptKey('t1'))).toBe('1');
    expect(redis.expiries.get(signupPasswordAttemptKey('t1'))).toBeGreaterThan(0);
    expect(account.recordFailure).toHaveBeenCalledOnce();
  });

  it(`retires the link on the ${SIGNUP_PASSWORD_MAX_ATTEMPTS}th wrong password`, async () => {
    const redis = fakeRedis({ [signupPasswordAttemptKey('t1')]: String(SIGNUP_PASSWORD_MAX_ATTEMPTS - 1) });

    const outcome = await checkSignupPassword({ redis: redis as any, tokenHash: 't1', passwordHash, password: 'wrong' });

    expect(outcome).toEqual({ ok: false, reason: 'attempts_exhausted' });
  });

  it('refuses even the right password once the link has used its attempts', async () => {
    const redis = fakeRedis({ [signupPasswordAttemptKey('t1')]: String(SIGNUP_PASSWORD_MAX_ATTEMPTS) });

    const outcome = await checkSignupPassword({ redis: redis as any, tokenHash: 't1', passwordHash, password: 'Signup-password-1' });

    expect(outcome).toEqual({ ok: false, reason: 'attempts_exhausted' });
    expect(redis.incr).not.toHaveBeenCalled();
  });

  it('refuses without checking the password while the account is locked out', async () => {
    const redis = fakeRedis();
    const account = fakeAccount(true);

    const outcome = await checkSignupPassword({ redis: redis as any, tokenHash: 't1', passwordHash, password: 'Signup-password-1', account });

    expect(outcome).toEqual({ ok: false, reason: 'account_locked' });
    expect(redis.incr).not.toHaveBeenCalled();
    expect(account.clearFailures).not.toHaveBeenCalled();
  });

  it('accepts the right password and clears the link and account counters', async () => {
    const redis = fakeRedis({ [signupPasswordAttemptKey('t1')]: '2' });
    const account = fakeAccount();

    const outcome = await checkSignupPassword({ redis: redis as any, tokenHash: 't1', passwordHash, password: 'Signup-password-1', account });

    expect(outcome).toEqual({ ok: true });
    expect(redis.store.has(signupPasswordAttemptKey('t1'))).toBe(false);
    expect(account.clearFailures).toHaveBeenCalledOnce();
  });
});
