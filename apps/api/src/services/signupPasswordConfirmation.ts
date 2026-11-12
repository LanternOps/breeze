import type { Redis } from 'ioredis';
import { verifyPassword } from './password';

/**
 * Password confirmation for signup verification links (POST /auth/verify-email).
 *
 * Confirming a signup needs both the emailed link and the password chosen at
 * signup. Each link allows a small number of wrong passwords; after that the
 * caller retires the link and a new signup or resend is needed. When the link
 * belongs to an existing account, every wrong password also counts toward the
 * same per-account lockout the login route uses (`account` hooks): the
 * attempt is reserved on the account before the check, and a locked account
 * is refused (after the same check, as on /auth/login).
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
  | 'attempts_exhausted'
  // The attempt counter could not be reached. Nothing is checked; the caller
  // answers "temporarily unavailable" and the link stays usable.
  | 'check_unavailable';

export type SignupPasswordOutcome = { ok: true } | { ok: false; reason: SignupPasswordFailure };

/** Hooks onto the per-account sign-in lockout shared with /auth/login. */
export interface SignupPasswordAccount {
  /** Reserve one attempt on the account (rate-limit.ts reserveAccountAttempt). */
  reserve(): Promise<{ allowed: boolean; count: number; reachesLimit: boolean }>;
  /** The wrong password just locked the account: send the lockout notice. */
  notifyLocked(count: number): Promise<void>;
  /** The password was right: reset the account's failure count. */
  clearFailures(): Promise<void>;
}

type AttemptStore = Pick<Redis, 'eval' | 'del'>;

// One round trip, atomic on the server: count this attempt and start the
// window on the first one.
const RESERVE_ATTEMPT_SCRIPT = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return n
`;

async function reserveAttempt(redis: AttemptStore, key: string): Promise<number | null> {
  try {
    const n = Number(await redis.eval(RESERVE_ATTEMPT_SCRIPT, 1, key, String(ATTEMPT_WINDOW_SECONDS)));
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export async function checkSignupPassword(input: {
  redis: AttemptStore;
  tokenHash: string;
  passwordHash: string;
  password: string | undefined;
  account?: SignupPasswordAccount;
}): Promise<SignupPasswordOutcome> {
  // The first click on the page never carries a password; it only learns
  // that one is needed. It does not use up an attempt.
  if (!input.password) {
    return { ok: false, reason: 'password_required' };
  }

  // Reserve the attempt before checking the password, so concurrent requests
  // cannot all pass the cap: at most SIGNUP_PASSWORD_MAX_ATTEMPTS checks run
  // per link. Fails closed when the counter is unreachable.
  const key = signupPasswordAttemptKey(input.tokenHash);
  const attempt = await reserveAttempt(input.redis, key);
  if (attempt === null) {
    return { ok: false, reason: 'check_unavailable' };
  }
  if (attempt > SIGNUP_PASSWORD_MAX_ATTEMPTS) {
    return { ok: false, reason: 'attempts_exhausted' };
  }

  // The account attempt is reserved before the check as well, and the check
  // runs even when the account is locked, as on /auth/login.
  const accountAttempt = input.account ? await input.account.reserve() : null;
  const valid = await verifyPassword(input.passwordHash, input.password);

  if (accountAttempt && !accountAttempt.allowed) {
    return { ok: false, reason: 'account_locked' };
  }

  if (valid) {
    await input.redis.del(key).catch(() => undefined);
    await input.account?.clearFailures();
    return { ok: true };
  }

  if (accountAttempt?.reachesLimit) {
    await input.account?.notifyLocked(accountAttempt.count);
  }
  return attempt >= SIGNUP_PASSWORD_MAX_ATTEMPTS
    ? { ok: false, reason: 'attempts_exhausted' }
    : { ok: false, reason: 'password_mismatch' };
}
