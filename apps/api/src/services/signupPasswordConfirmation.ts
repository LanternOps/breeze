import type { Redis } from 'ioredis';
import { verifyPassword } from './password';

/**
 * Password confirmation for signup verification links (POST /auth/verify-email).
 *
 * Confirming a signup needs both the emailed link and the password chosen at
 * signup. Each link allows a small number of wrong passwords; after that the
 * caller retires the link and a new signup or resend is needed. When the link
 * belongs to an existing account, every wrong password also counts toward the
 * same per-account lockout the login route uses (`account` hooks), and a
 * locked account is refused without checking the password.
 *
 * Runs before any database transaction or row lock: the argon2 verify is the
 * slow part, and the caller re-checks under its lock only that the stored hash
 * it verified against is still the current one.
 */

export const SIGNUP_PASSWORD_MAX_ATTEMPTS = 5;

/** Long enough to outlive the link itself (24h for a signup link, 1h for a pending registration). */
const ATTEMPT_WINDOW_SECONDS = 24 * 60 * 60;

export function signupPasswordAttemptKey(tokenHash: string): string {
  return `verify-email:password-attempts:${tokenHash}`;
}

export type SignupPasswordFailure =
  | 'password_required'
  | 'password_mismatch'
  | 'account_locked'
  | 'attempts_exhausted';

export type SignupPasswordOutcome = { ok: true } | { ok: false; reason: SignupPasswordFailure };

export interface SignupPasswordAccount {
  isLocked(): Promise<boolean>;
  recordFailure(): Promise<void>;
  clearFailures(): Promise<void>;
}

type AttemptStore = Pick<Redis, 'get' | 'incr' | 'expire' | 'del'>;

export async function checkSignupPassword(input: {
  redis: AttemptStore;
  tokenHash: string;
  passwordHash: string;
  password: string | undefined;
  account?: SignupPasswordAccount;
}): Promise<SignupPasswordOutcome> {
  const key = signupPasswordAttemptKey(input.tokenHash);

  // Fail closed: without a readable counter the attempt cap cannot hold.
  let attempts: number;
  try {
    attempts = Number(await input.redis.get(key) ?? '0');
  } catch {
    return { ok: false, reason: 'attempts_exhausted' };
  }
  if (!Number.isFinite(attempts) || attempts >= SIGNUP_PASSWORD_MAX_ATTEMPTS) {
    return { ok: false, reason: 'attempts_exhausted' };
  }

  if (input.account && await input.account.isLocked()) {
    return { ok: false, reason: 'account_locked' };
  }

  // The first click on the page never carries a password; it only learns
  // that one is needed. It does not use up an attempt.
  if (!input.password) {
    return { ok: false, reason: 'password_required' };
  }

  if (await verifyPassword(input.passwordHash, input.password)) {
    await input.redis.del(key).catch(() => undefined);
    await input.account?.clearFailures();
    return { ok: true };
  }

  let count: number;
  try {
    count = await input.redis.incr(key);
    if (count === 1) await input.redis.expire(key, ATTEMPT_WINDOW_SECONDS);
  } catch {
    count = SIGNUP_PASSWORD_MAX_ATTEMPTS;
  }
  await input.account?.recordFailure();
  return count >= SIGNUP_PASSWORD_MAX_ATTEMPTS
    ? { ok: false, reason: 'attempts_exhausted' }
    : { ok: false, reason: 'password_mismatch' };
}
