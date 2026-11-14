import type { Redis } from 'ioredis';
import * as dbModule from '../db';

/**
 * Calls the #1105 held-context tripwire, tolerating a PARTIAL test double of
 * `../db`.
 *
 * `rateLimiter` is reached from well over a hundred call sites, and a large
 * number of their unit suites mock `../db` with just the handful of exports
 * that route needs. Vitest throws on reading an undeclared export from a
 * mocked module, so a plain named import would turn this instrumentation into
 * a mass test failure that says nothing about the code under test. The
 * property READ is therefore guarded; the call itself is not — a strict-mode
 * (`DB_CONTEXT_TRIPWIRE_STRICT`) throw still propagates to the caller, which
 * is the whole point of the guard. Same tolerance `createInstrumentedQueue`
 * applies to a partially-doubled BullMQ Queue.
 */
let missingGuardWarned = false;

export function assertOutsideHeldDbContextSafe(operation: string): void {
  let assertFn: ((op: string) => void) | undefined;
  try {
    assertFn = (dbModule as { assertOutsideHeldDbContext?: (op: string) => void })
      .assertOutsideHeldDbContext;
  } catch {
    // Partially-mocked `../db` in a unit test — nothing to assert against.
    return;
  }
  if (typeof assertFn !== 'function') {
    // The cast above erases the type, so a rename or removal of the export
    // would otherwise disable the tripwire for every rateLimiter call site
    // with no compile error and no runtime signal. Warn once per process so
    // the breakage is at least visible in logs.
    if (!missingGuardWarned) {
      missingGuardWarned = true;
      console.warn(
        '[rate-limit] #1105 tripwire unavailable: db.assertOutsideHeldDbContext is not a function '
        + '— held-context detection is OFF for every rateLimiter call site.',
      );
    }
    return;
  }
  assertFn(operation);
}

/** Test-only: reset the once-per-process warn latch. */
export function __resetMissingGuardWarnForTests(): void {
  missingGuardWarned = false;
}

/**
 * Low-cardinality label for the #1105 tripwire: the key's first segment only
 * (`elevation:rate:device:<uuid>` → `elevation`).
 *
 * The bucket is what identifies the limiter; the id that follows it is a
 * device/user/email and must never reach a log line or a Sentry message. The
 * originating call site comes from the stack the tripwire captures, not from
 * this string, so one segment is enough to read the logs by.
 */
function rateLimitBucketLabel(key: string): string {
  // A key with no separator carries no bucket we can trust to be id-free, so
  // it degrades to `unknown` rather than risking an identifier in the label.
  const sep = key.indexOf(':');
  if (sep <= 0) return 'unknown';
  return key.slice(0, sep);
}

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

export interface RateLimiterOptions {
  /**
   * Give the just-recorded entries back when the request is REJECTED, so a
   * rejected attempt does not consume window capacity (issue #3696).
   *
   * The default (false) is the correct, punitive behaviour for credential-style
   * limiters: hammering while throttled should keep you throttled. But it makes
   * `resetAt` a lie for a well-behaved client — `resetAt` is derived from the
   * OLDEST entry in the window, so a client that honours the advertised wait
   * can still be rejected on its next attempt because its own rejected
   * attempts are sitting in the window behind it, and each rejection pushes
   * the recovery further out.
   *
   * Opt in for buckets that throttle an ALREADY-AUTHENTICATED holder and
   * advertise `Retry-After`, where honouring the wait must actually work. Raw
   * request volume there is still bounded by the global per-IP limiter.
   */
  refundOnReject?: boolean;
}

export async function rateLimiter(
  redis: Redis | null,
  key: string,
  limit: number,
  windowSeconds: number,
  cost = 1,
  options: RateLimiterOptions = {}
): Promise<RateLimitResult> {
  // #6130 / #1105 — this is a Redis round-trip. Inside a held
  // `withDbAccessContext` transaction it pins a pooled Postgres connection
  // idle-in-transaction for the whole round-trip, which is worst exactly when
  // Redis is slow. Deliberately OUTSIDE the try/catch below: under
  // DB_CONTEXT_TRIPWIRE_STRICT the guard throws, and a caught throw would be
  // downgraded to a silent fail-closed deny — the violation would never
  // surface. Warn-only by default (prod-safe); the label is the key's bucket
  // so call sites are readable in logs without leaking the keyed identifier.
  assertOutsideHeldDbContextSafe(`rateLimiter(${rateLimitBucketLabel(key)})`);

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
    const allowed = count <= limit;

    // Tracks whether the refund actually landed in Redis, so `remaining`
    // below reflects the true post-refund state rather than always the
    // pre-refund `count` — see the `remaining` comment (#3984).
    let refunded = false;
    if (!allowed && options.refundOnReject) {
      // Remove exactly the members this call added. Best-effort: a failure here
      // only means the caller is treated the old (punitive) way, never that a
      // request is wrongly allowed — `allowed` was already decided above.
      const members = zaddArgs.filter((_, i) => i % 2 === 1) as string[];
      try {
        await redis.zrem(key, ...members);
        refunded = true;
      } catch (err) {
        console.error('[rate-limit] refund failed for key:', key, err);
      }
    }

    // `count` includes this call's own just-added (and possibly just-refunded)
    // entries. When the refund above actually landed, those entries are gone
    // from Redis, so reporting `remaining` from the pre-refund `count` lies —
    // it can under-report the capacity the refund actually restored, which is
    // exactly the number a well-behaved client reads to decide when to retry
    // (#3984).
    //
    // NOTE on current callers: the `refundOnReject: true` call sites
    // (apps/api/src/routes/auth/login.ts's /auth/refresh limiter,
    // pamReconciliationRateLimit.ts, and middleware/rateLimitBudget.ts) pass
    // `cost = 1`, and at cost 1 a
    // rejection means `count` was already `>= limit + 1` BEFORE this call's
    // own entry, so refunding just this call's own 1 entry never brings
    // `effectiveCount` below `limit` — `remaining` is still correctly 0
    // either way. This fix has no observable effect on those call sites
    // today; it corrects the general `rateLimiter()` contract for any
    // caller (present or future) that passes a weighted `cost > 1`, where a
    // single rejected call CAN refund enough to restore real capacity.
    const effectiveCount = refunded ? Math.max(0, count - safeCost) : count;

    return {
      allowed,
      remaining: Math.max(0, limit - effectiveCount),
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
// disables the feature entirely — reserveAccountAttempt / releaseAccountAttempt
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

// Budget for POST /auth/refresh, keyed per refresh-token FAMILY (issue #3696).
//
// This limiter sits after the refresh JWT's signature has been verified but
// BEFORE reuse-detection and the user/epoch validity checks, so it is a cheap
// volume guard, not an authorization control: it bounds how fast a caller
// holding a structurally-valid refresh token may spend it, protecting the
// Redis/Postgres session lookups, the rotation writes and the token mint from
// a runaway client (a stuck poll loop, a wedged tab). Credential-guessing is
// not its job — an attacker without a signed refresh token never reaches it,
// and raw request volume is separately capped by the global per-IP limiter.
//
// Why the budget moved from 10/60s per USER:
//
//  - `apps/web` is an Astro MPA and access tokens are memory-only, so EVERY
//    full-page navigation starts a fresh JS realm that must spend one refresh.
//    10/60s therefore capped a signed-in operator at ten page views per minute
//    — well inside normal triage pace. The eleventh navigation 429'd and the
//    client treated the throttle as an expiry and evicted to /login.
//    Reproduced at 10 navigations in 24 seconds.
//  - Keying per user meant one wedged browser tab starved the SAME person's
//    other devices. The family id is preserved across rotation, so a family is
//    effectively one browser profile's session chain — the granularity that
//    actually matches "one navigation, one refresh".
//
// 60/60s keeps the runaway-client ceiling low in absolute terms while putting
// it far beyond any human click rate, including several tabs at once.
// Operator-overridable at runtime (read per call, no restart needed) via
// AUTH_REFRESH_RATE_LIMIT / AUTH_REFRESH_RATE_WINDOW_SECONDS.
export function getRefreshRateLimit(): number {
  return positiveIntFromEnv('AUTH_REFRESH_RATE_LIMIT', 60);
}

export function getRefreshRateWindowSeconds(): number {
  return positiveIntFromEnv('AUTH_REFRESH_RATE_WINDOW_SECONDS', 60);
}

// Back-compat read-only exports — DO NOT USE in new code, prefer the getters
// above so env changes take effect at runtime. Kept so older call sites and
// tests don't break in one shot; can be removed once all callers migrate.
export const ACCOUNT_LOCKOUT_MAX = getAccountLockoutMax();
export const ACCOUNT_LOCKOUT_WINDOW_SECONDS = getAccountLockoutWindowSeconds();

function accountFailureKey(email: string): string {
  return `login:account-fail:${email.toLowerCase()}`;
}

export interface AccountAttemptReservation {
  /**
   * The credential may be checked and its result honoured. False when the
   * account is locked (this attempt is past the limit) or the counter could
   * not be reached.
   */
  allowed: boolean;
  /** Attempts in the current window, this one included. */
  count: number;
  /** This attempt is the last one before the lock. If it fails, the account is now locked. */
  reachesLimit: boolean;
}

// Count one attempt and start the window on the first one, atomically on the
// server. Later attempts (including ones made while locked) never move the
// expiry, so trying again does not extend a lock.
const RESERVE_ACCOUNT_ATTEMPT_SCRIPT = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return n
`;

// Give back a reserved attempt whose credential turned out to be correct.
const RELEASE_ACCOUNT_ATTEMPT_SCRIPT = `
local n = redis.call('DECR', KEYS[1])
if n <= 0 then redis.call('DEL', KEYS[1]) end
return n
`;

/**
 * Reserve one sign-in attempt for an account BEFORE its credential is checked.
 * Concurrent attempts each get their own count from Redis, so no more than
 * LOGIN_ACCOUNT_LOCKOUT_MAX credential results are honoured per window,
 * however the requests are timed. Callers still run the credential check when
 * `allowed` is false (equal work on every branch) and then deny.
 *
 * After a correct credential, call releaseAccountAttempt so the counter keeps
 * measuring failed attempts only; after a wrong one there is nothing to do
 * (the attempt is already counted). clearAccountFailures still resets the
 * counter on a completed sign-in.
 *
 * Fail-closed, as the lockout check has always been: no Redis, or a Redis
 * error, reports `allowed: false`. With LOGIN_ACCOUNT_LOCKOUT_MAX=0 the
 * feature is off and Redis is not touched.
 */
export async function reserveAccountAttempt(
  redis: Redis | null,
  email: string
): Promise<AccountAttemptReservation> {
  const maxAttempts = getAccountLockoutMax();
  if (maxAttempts <= 0) {
    return { allowed: true, count: 0, reachesLimit: false };
  }
  if (!redis) {
    console.error('[rate-limit] Redis unavailable, refusing account attempt for:', email);
    return { allowed: false, count: maxAttempts, reachesLimit: false };
  }
  try {
    const count = Number(await redis.eval(
      RESERVE_ACCOUNT_ATTEMPT_SCRIPT,
      1,
      accountFailureKey(email),
      String(getAccountLockoutWindowSeconds())
    ));
    if (!Number.isFinite(count)) {
      return { allowed: false, count: maxAttempts, reachesLimit: false };
    }
    return { allowed: count <= maxAttempts, count, reachesLimit: count === maxAttempts };
  } catch (err) {
    console.error('[rate-limit] Redis error reserving account attempt for:', email, err);
    return { allowed: false, count: maxAttempts, reachesLimit: false };
  }
}

/** Best-effort: give back an attempt reserved by reserveAccountAttempt after a correct credential. */
export async function releaseAccountAttempt(redis: Redis | null, email: string): Promise<void> {
  if (!redis || getAccountLockoutMax() <= 0) return;
  try {
    await redis.eval(RELEASE_ACCOUNT_ATTEMPT_SCRIPT, 1, accountFailureKey(email));
  } catch (err) {
    console.error('[rate-limit] Redis error releasing account attempt for:', email, err);
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
