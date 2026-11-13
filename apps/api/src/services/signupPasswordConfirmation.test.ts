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
    // The service's two scripts: reserve (INCR, EXPIRE on the first one) and
    // give back (DECR, DEL at zero). Real Redis runs them in the integration suite.
    eval: vi.fn(async (script: string, _numKeys: number, key: string, seconds?: string) => {
      if (script.includes("redis.call('DECR', KEYS[1])")) {
        const next = Number(store.get(key) ?? '0') - 1;
        if (next <= 0) store.delete(key); else store.set(key, String(next));
        await tick();
        return next;
      }
      const next = incrWithExpiry(key, Number(seconds));
      await tick();
      return next;
    }),
  };
}

function fakeAccount(reservation: { allowed: boolean; count: number; reachesLimit: boolean } = { allowed: true, count: 1, reachesLimit: false }) {
  const calls: string[] = [];
  return {
    calls,
    reserve: vi.fn(async () => { calls.push('reserve'); return reservation; }),
    notifyLocked: vi.fn(async () => undefined),
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
    expect(account.reserve).not.toHaveBeenCalled();
  });

  it('counts a wrong password against the link and the account', async () => {
    const redis = fakeRedis();
    const account = fakeAccount();

    const outcome = await checkSignupPassword({ redis: redis as any, tokenHash: 't1', passwordHash, password: 'wrong', account });

    expect(outcome).toEqual({ ok: false, reason: 'password_mismatch' });
    expect(redis.store.get(signupPasswordAttemptKey('t1'))).toBe('1');
    expect(redis.expiries.get(signupPasswordAttemptKey('t1'))).toBeGreaterThan(0);
    expect(account.reserve).toHaveBeenCalledOnce();
    expect(account.notifyLocked).not.toHaveBeenCalled();
  });

  it('reserves the account attempt before checking the password', async () => {
    const redis = fakeRedis();
    const account = fakeAccount();
    vi.mocked(verifyPassword).mockImplementationOnce(async () => { account.calls.push('verify'); return false; });

    await checkSignupPassword({ redis: redis as any, tokenHash: 't1', passwordHash, password: 'wrong', account });

    expect(account.calls).toEqual(['reserve', 'verify']);
  });

  it('sends the lockout notice when a wrong password reaches the account limit', async () => {
    const redis = fakeRedis();
    const account = fakeAccount({ allowed: true, count: 5, reachesLimit: true });

    await checkSignupPassword({ redis: redis as any, tokenHash: 't1', passwordHash, password: 'wrong', account });

    expect(account.notifyLocked).toHaveBeenCalledWith(5);
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

  it('refuses a locked-out account even with the right password, after the same password check', async () => {
    const redis = fakeRedis();
    const account = fakeAccount({ allowed: false, count: 6, reachesLimit: false });

    const outcome = await checkSignupPassword({ redis: redis as any, tokenHash: 't1', passwordHash, password: 'Signup-password-1', account });

    expect(outcome).toEqual({ ok: false, reason: 'account_locked' });
    expect(verifyPassword).toHaveBeenCalledOnce();
    expect(account.clearFailures).not.toHaveBeenCalled();
    expect(account.notifyLocked).not.toHaveBeenCalled();
  });

  it('does not use up the link while the account is locked out', async () => {
    const redis = fakeRedis();
    const locked = fakeAccount({ allowed: false, count: 6, reachesLimit: false });

    for (let i = 0; i < SIGNUP_PASSWORD_MAX_ATTEMPTS + 1; i += 1) {
      expect(await checkSignupPassword({ redis: redis as any, tokenHash: 't1', passwordHash, password: 'Signup-password-1', account: locked }))
        .toEqual({ ok: false, reason: 'account_locked' });
    }

    expect(redis.store.has(signupPasswordAttemptKey('t1'))).toBe(false);
    // Once the lock has passed, the same link still works.
    expect(await checkSignupPassword({ redis: redis as any, tokenHash: 't1', passwordHash, password: 'Signup-password-1', account: fakeAccount() }))
      .toEqual({ ok: true });
  });

  it('gives the link attempt back for a locked account whatever password was sent', async () => {
    const redis = fakeRedis();
    const locked = fakeAccount({ allowed: false, count: 6, reachesLimit: false });

    expect(await checkSignupPassword({ redis: redis as any, tokenHash: 't1', passwordHash, password: 'wrong', account: locked }))
      .toEqual({ ok: false, reason: 'account_locked' });

    expect(redis.store.has(signupPasswordAttemptKey('t1'))).toBe(false);
  });

  it('still counts a wrong password against the link while the account is unlocked', async () => {
    const redis = fakeRedis();

    await checkSignupPassword({ redis: redis as any, tokenHash: 't1', passwordHash, password: 'wrong', account: fakeAccount() });

    expect(redis.store.get(signupPasswordAttemptKey('t1'))).toBe('1');
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
