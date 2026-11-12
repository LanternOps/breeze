import { beforeAll, describe, expect, it, vi } from 'vitest';
import { hashPassword } from './password';
import {
  SIGNUP_PASSWORD_MAX_ATTEMPTS,
  checkSignupPassword,
  signupPasswordAttemptKey,
} from './signupPasswordConfirmation';

function fakeRedis(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  const expiries = new Map<string, number>();
  return {
    store,
    expiries,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    incr: vi.fn(async (key: string) => {
      const next = Number(store.get(key) ?? '0') + 1;
      store.set(key, String(next));
      return next;
    }),
    expire: vi.fn(async (key: string, seconds: number) => {
      expiries.set(key, seconds);
      return 1;
    }),
    del: vi.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
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

  it('refuses when the attempt counter cannot be read', async () => {
    const redis = fakeRedis();
    redis.get.mockRejectedValueOnce(new Error('redis down'));

    const outcome = await checkSignupPassword({ redis: redis as any, tokenHash: 't1', passwordHash, password: 'Signup-password-1' });

    expect(outcome).toEqual({ ok: false, reason: 'attempts_exhausted' });
  });
});
