import type { Redis } from 'ioredis';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: Date;
}

export interface RateLimitConfig {
  limit: number;
  windowSeconds: number;
}

function failClosed(windowSeconds: number): RateLimitResult {
  return {
    allowed: false,
    remaining: 0,
    resetAt: new Date(Date.now() + windowSeconds * 1000)
  };
}

export async function rateLimiter(
  redis: Redis | null,
  key: string,
  limit: number,
  windowSeconds: number,
  cost = 1
): Promise<RateLimitResult> {
  // If Redis is unavailable, fail closed — deny the request for security
  if (!redis) {
    console.error('[rate-limit] Redis unavailable, failing closed for key:', key);
    return failClosed(windowSeconds);
  }

  const now = Date.now();
  const windowStart = now - windowSeconds * 1000;
  const safeCost = Number.isFinite(cost) ? Math.max(1, Math.floor(cost)) : 1;
  const zaddArgs: Array<string | number> = [];
  for (let i = 0; i < safeCost; i += 1) {
    zaddArgs.push(now, `${now}-${i}-${Math.random().toString(36).slice(2, 10)}`);
  }

  try {
    const results = await redis
      .multi()
      .zremrangebyscore(key, '-inf', windowStart)
      .zadd(key, ...zaddArgs)
      .zcard(key)
      .zrange(key, 0, 0, 'WITHSCORES')
      .expire(key, windowSeconds)
      .exec();

    if (!results) {
      console.error('[rate-limit] Redis multi returned null for key:', key);
      return failClosed(windowSeconds);
    }

    const countResult = results[2]?.[1];
    const count = typeof countResult === 'number' ? countResult : Number(countResult ?? 0);
    const oldestResult = results[3]?.[1];
    const oldestScore = Array.isArray(oldestResult) && oldestResult.length >= 2
      ? Number(oldestResult[1])
      : now;
    const resetAt = new Date(oldestScore + windowSeconds * 1000);

    return {
      allowed: count <= limit,
      remaining: Math.max(0, limit - count),
      resetAt
    };
  } catch (err) {
    console.error('[rate-limit] Redis error for key:', key, err);
    return failClosed(windowSeconds);
  }
}

export const loginLimiter: RateLimitConfig = {
  limit: 5,
  windowSeconds: 5 * 60
};

// Task 10: per-account lockout. Five consecutive failed password attempts
// within the window locks the account for the same window. The lockout is
// strictly account-scoped (keyed on normalized email) so it stacks with
// the per-IP and per-(IP,email) limiters and survives the attacker rotating
// IPs. Cleared on a successful login so a real user with one fat-finger
// doesn't slowly approach a lockout over weeks of normal usage.
//
// Operator overrides: LOGIN_ACCOUNT_LOCKOUT_MAX (default 5) and
// LOGIN_ACCOUNT_LOCKOUT_WINDOW_SECONDS (default 900). Setting MAX=0
// disables the feature entirely — recordAccountFailure / isAccountLocked
// short-circuit BEFORE touching Redis so a Redis outage during the
// disabled state can't accidentally fail-closed and lock everyone out.
function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

// Read at call time, not at module load, so ops can change
// LOGIN_ACCOUNT_LOCKOUT_MAX / _WINDOW_SECONDS without an API restart. The
// kill-switch sibling (mfaForcePartnerAdmin) uses the same pattern.
export function getAccountLockoutMax(): number {
  return positiveIntFromEnv('LOGIN_ACCOUNT_LOCKOUT_MAX', 5);
}

export function getAccountLockoutWindowSeconds(): number {
  return positiveIntFromEnv('LOGIN_ACCOUNT_LOCKOUT_WINDOW_SECONDS', 15 * 60);
}

// Back-compat read-only exports — DO NOT USE in new code, prefer the getters
// above so env changes take effect at runtime. Kept so older call sites and
// tests don't break in one shot; can be removed once all callers migrate.
export const ACCOUNT_LOCKOUT_MAX = getAccountLockoutMax();
export const ACCOUNT_LOCKOUT_WINDOW_SECONDS = getAccountLockoutWindowSeconds();

function accountFailureKey(email: string): string {
  return `login:account-fail:${email.toLowerCase()}`;
}

export interface AccountFailureResult {
  count: number;
  locked: boolean;
  // True only on the attempt that crossed the threshold for the first time
  // in this window. Use it to fire the lockout email exactly once instead of
  // on every subsequent failed attempt during the lockout window.
  newlyLocked: boolean;
}

/**
 * Increment the per-account failure counter. Returns the new count, whether
 * the account is now locked, and whether THIS call is the one that crossed
 * the threshold (so callers can fire a lockout-notice email exactly once).
 *
 * Fail-closed on Redis errors: if the counter can't be read or incremented
 * we report `locked: true` so we don't silently let an attacker keep
 * guessing during a Redis outage.
 */
export async function recordAccountFailure(
  redis: Redis | null,
  email: string
): Promise<AccountFailureResult> {
  // Feature disabled (MAX=0): short-circuit before any Redis call so the
  // null-Redis fail-closed branch below can't accidentally lock everyone
  // out when ops have explicitly turned the feature off.
  const maxAttempts = getAccountLockoutMax();
  const windowSeconds = getAccountLockoutWindowSeconds();
  if (maxAttempts <= 0) {
    return { count: 0, locked: false, newlyLocked: false };
  }
  if (!redis) {
    console.error('[rate-limit] Redis unavailable, failing closed on account failure for:', email);
    return { count: maxAttempts, locked: true, newlyLocked: false };
  }

  const key = accountFailureKey(email);
  try {
    // Atomically increment the counter. newlyLocked is the call where the
    // INCR's own return value is exactly maxAttempts — only one racer can
    // observe that boundary, so the lockout email + audit row fire exactly
    // once per lockout window. (The previous GET-then-INCR pattern let two
    // concurrent 4→5 / 4→6 callers BOTH return newlyLocked.)
    const count = await redis.incr(key);
    if (count === 1) {
      // Only reset TTL when the counter was just created — otherwise a
      // sliding TTL would let an attacker keep the counter "young" by
      // pacing attempts and never trip the lockout.
      await redis.expire(key, windowSeconds);
    }
    const locked = count >= maxAttempts;
    const newlyLocked = count === maxAttempts;
    return { count, locked, newlyLocked };
  } catch (err) {
    console.error('[rate-limit] Redis error recording account failure for:', email, err);
    return { count: maxAttempts, locked: true, newlyLocked: false };
  }
}

/**
 * Clear the per-account failure counter. Called on a successful login so
 * a real user who fat-fingered their password a few times before getting
 * it right doesn't slowly accumulate towards a lockout over time.
 *
 * Best-effort: a Redis error here logs but doesn't fail the login — the
 * counter will expire naturally at the end of the window.
 */
export async function clearAccountFailures(redis: Redis | null, email: string): Promise<void> {
  if (!redis) return;
  try {
    await redis.del(accountFailureKey(email));
  } catch (err) {
    console.error('[rate-limit] Redis error clearing account failures for:', email, err);
  }
}

/**
 * Check whether an account is currently locked (failure count at or above
 * the threshold within the lockout window). Fail-closed on Redis errors —
 * treat the account as locked so we don't silently let an attacker keep
 * guessing during a Redis outage.
 */
export async function isAccountLocked(redis: Redis | null, email: string): Promise<boolean> {
  const maxAttempts = getAccountLockoutMax();
  if (maxAttempts <= 0) return false;
  if (!redis) {
    console.error('[rate-limit] Redis unavailable, treating account as locked for:', email);
    return true;
  }
  try {
    const v = await redis.get(accountFailureKey(email));
    return v !== null && parseInt(v, 10) >= maxAttempts;
  } catch (err) {
    console.error('[rate-limit] Redis error checking account lock for:', email, err);
    return true;
  }
}

export const forgotPasswordLimiter: RateLimitConfig = {
  limit: 3,
  windowSeconds: 60 * 60
};

export const mfaLimiter: RateLimitConfig = {
  limit: 5,
  windowSeconds: 5 * 60
};

export const smsPhoneVerifyLimiter: RateLimitConfig = {
  limit: 3,
  windowSeconds: 60 * 60
};

export const smsPhoneVerifyUserLimiter: RateLimitConfig = {
  limit: 5,
  windowSeconds: 60 * 60
};

export const smsLoginSendLimiter: RateLimitConfig = {
  limit: 3,
  windowSeconds: 5 * 60
};

export const smsLoginGlobalLimiter: RateLimitConfig = {
  limit: 5,
  windowSeconds: 15 * 60
};

export const phoneConfirmLimiter: RateLimitConfig = {
  limit: 5,
  windowSeconds: 5 * 60
};
