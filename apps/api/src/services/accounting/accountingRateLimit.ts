/**
 * Accounting provider call limiter (spec W01 "Rate limiting"): a per-connection
 * sliding window, an optional per-provider app-wide window, an optional
 * per-connection concurrency cap, and an optional daily budget — all specified
 * by `provider.limits.rate`, all on the shared Redis client (`getRedis`) and the
 * shared sliding-window helper (`rateLimiter`). Providers wrap every realm API
 * call in `withProviderCallSlot` (the OAuth token endpoint is deliberately
 * outside it: it is not a realm call and a refresh must never wait on the
 * realm's own traffic). A refusal is an AccountingProviderError{kind:
 * 'rate_limited'} carrying its `throttleSource`, which the workers turn into a
 * delayed retry that consumes no attempt (jobs/accountingJobDelay.ts).
 *
 * Failure policy (deliberate):
 * - `getRedis()` null (Redis known down) → FAIL OPEN, warn once per process.
 *   The provider's own 429 is the backstop; pushes must not stop because the
 *   limiter's store is down.
 * - Otherwise the limiter FAILS CLOSED as `rate_limited` with
 *   RATE_LIMIT_FALLBACK_RETRY_MS and `throttleSource: 'limiter_unavailable'`
 *   (never a raw ioredis error), after releasing whatever was already acquired,
 *   when: the client is not usable before acquiring (reconnecting / closed); a
 *   direct Redis round trip throws (`store`); or a window check refuses while
 *   the client has dropped (`rateLimiter` fails closed itself, and its result
 *   is otherwise indistinguishable from a real refusal). The first such failure
 *   in LIMITER_UNAVAILABLE_REPORT_INTERVAL_MS reaches Sentry — it is a Breeze
 *   infrastructure problem, unlike a `local` or `provider` throttle.
 *   Residual: a server-side error on a window check while the client stays
 *   `ready` (READONLY/OOM) still reads as `local`; `rateLimiter` logs it. Both
 *   shipped providers declare a concurrency cap, whose lease is a direct
 *   round trip taken FIRST, so such an error surfaces there as
 *   `limiter_unavailable` before any window check runs.
 *
 * Keys share the `acct-rl:` prefix (the bucket label `rateLimiter` logs) and
 * carry provider + connection ids only, no PII.
 */
import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { getRedis } from '../redis';
import { rateLimiter } from '../rate-limit';
import { runOutsideDbContext } from '../../db';
import { captureException } from '../sentry';
import { AccountingProviderError, type AccountingThrottleSource } from './accountingProviderError';
import type { AccountingProviderId, RateLimitSpec } from './types';

export const RATE_LIMIT_FALLBACK_RETRY_MS = 5_000;
export const BACKGROUND_DEFER_RATIO = 0.2;
/** At most one Sentry event per process per this interval for a limiter-store outage. */
export const LIMITER_UNAVAILABLE_REPORT_INTERVAL_MS = 10 * 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const CONCURRENCY_RETRY_MS = 2_000;
/**
 * Lifetime of one concurrency lease. A slot a crashed process never released
 * is reclaimed this long after it was taken, however busy the connection is.
 * Far above any provider HTTP timeout, so a live call keeps its slot.
 */
const INFLIGHT_LEASE_MS = 120_000;
/**
 * ioredis statuses in which a command cannot be served now. `wait` (lazyConnect,
 * never used) and the first `connecting`/`connect` handshake are usable: the
 * offline queue carries the command and it connects the client.
 */
const UNUSABLE_CLIENT_STATUSES: ReadonlySet<string> = new Set(['reconnecting', 'close', 'end']);

/**
 * Concurrency semaphore: a ZSET of lease tokens scored by expiry time.
 * KEYS[1] = lease set, ARGV[1] = cap, ARGV[2] = lease ms, ARGV[3] = token,
 * ARGV[4] = now (ms). Returns 1 = acquired, 0 = refused.
 *
 * `now` is the CLIENT clock (as `rateLimiter` already uses for its window
 * scores) rather than Redis TIME, which older self-hosted Redis versions refuse
 * before a write in a script. This assumes every API instance is NTP-synced;
 * skew only shifts when an abandoned lease is reclaimed, by the skew amount.
 */
const ACQUIRE_LUA = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[4])
if redis.call('ZCARD', KEYS[1]) < tonumber(ARGV[1]) then
  redis.call('ZADD', KEYS[1], tonumber(ARGV[4]) + tonumber(ARGV[2]), ARGV[3])
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  return 1
end
return 0`;
// KEYS[1] = lease set, ARGV[1] = token. Removing an absent token is a no-op.
const RELEASE_LUA = `return redis.call('ZREM', KEYS[1], ARGV[1])`;

let warnedRedisDown = false;
let lastLimiterUnavailableReportAt = Number.NEGATIVE_INFINITY;
const warnedBadDailyLimit = new Set<AccountingProviderId>();

/** Test-only: reset the once-per-process latches. */
export function __resetAccountingRateLimitStateForTests(): void {
  warnedRedisDown = false;
  lastLimiterUnavailableReportAt = Number.NEGATIVE_INFINITY;
  warnedBadDailyLimit.clear();
}

const keyFor = (provider: AccountingProviderId, part: string, connectionId?: string): string =>
  connectionId === undefined ? `acct-rl:${provider}:${part}` : `acct-rl:${provider}:${part}:${connectionId}`;

/**
 * A LOCAL refusal: Breeze's own limiter said no before anything was sent. The
 * message states what happened only — whether anything retries is up to the
 * caller (a delayed job does; a manual route call does not).
 */
function refused(provider: AccountingProviderId, what: string, retryAfterMs: number): AccountingProviderError {
  return new AccountingProviderError({
    kind: 'rate_limited',
    provider,
    operation: `accounting call slot (${what})`,
    message: `Accounting call slot refused by Breeze's rate limiter (${what})`,
    retryAfterMs: Number.isFinite(retryAfterMs) ? Math.max(1_000, Math.ceil(retryAfterMs)) : RATE_LIMIT_FALLBACK_RETRY_MS,
    throttleSource: 'local',
  });
}

/**
 * The limiter's store could not be used, so the call is refused fail-closed.
 * Reported to Sentry at most once per LIMITER_UNAVAILABLE_REPORT_INTERVAL_MS
 * per process: an outage refuses every call, and one event is the signal.
 */
function limiterUnavailable(provider: AccountingProviderId, what: string, cause?: unknown): AccountingProviderError {
  const err = new AccountingProviderError({
    kind: 'rate_limited',
    provider,
    operation: `accounting call slot (${what})`,
    message: `Breeze's accounting rate limiter is unavailable (${what})`,
    retryAfterMs: RATE_LIMIT_FALLBACK_RETRY_MS,
    throttleSource: 'limiter_unavailable',
    cause,
  });
  const now = Date.now();
  if (now - lastLimiterUnavailableReportAt >= LIMITER_UNAVAILABLE_REPORT_INTERVAL_MS) {
    lastLimiterUnavailableReportAt = now;
    captureException(err, undefined, { service: 'accountingRateLimit' });
  }
  return err;
}

const clientUnusable = (redis: Redis): boolean => UNUSABLE_CLIENT_STATUSES.has(redis.status);

/** One direct Redis round trip during acquisition: any throw becomes a fail-closed refusal. */
async function store<T>(provider: AccountingProviderId, op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (err) {
    console.error('[accountingRateLimit] limiter store error; refusing the call', err instanceof Error ? err.message : err);
    throw limiterUnavailable(provider, 'limiter store error', err);
  }
}

async function checkWindow(
  redis: Redis, provider: AccountingProviderId, key: string, limit: number, windowSeconds: number, what: string,
): Promise<void> {
  const result = await rateLimiter(redis, key, limit, windowSeconds, 1, { refundOnReject: true });
  if (!result.allowed) {
    // `rateLimiter` swallows its own Redis errors into a refusal. A client
    // that dropped meanwhile means this "refusal" is the store failing.
    if (clientUnusable(redis)) throw limiterUnavailable(provider, `${what} window: client ${redis.status}`);
    const wait = result.resetAt.getTime() - Date.now();
    throw refused(provider, what, wait > 0 ? wait : RATE_LIMIT_FALLBACK_RETRY_MS);
  }
}

/**
 * The spec's daily limit, or null for "no daily budget". A limit() that throws
 * or returns a non-finite or non-positive number is a provider misconfiguration;
 * treating it as a budget would refuse every call on the connection forever, so
 * it is treated as absent and warned about once per provider per process.
 */
function resolveDailyLimit(provider: AccountingProviderId, spec: RateLimitSpec): number | null {
  if (!spec.dailyPerConnection) return null;
  let limit: number;
  let detail: string;
  try {
    limit = spec.dailyPerConnection.limit();
    detail = String(limit);
  } catch (err) {
    limit = Number.NaN;
    detail = `limit() threw: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (Number.isFinite(limit) && limit > 0) return limit;
  if (!warnedBadDailyLimit.has(provider)) {
    warnedBadDailyLimit.add(provider);
    console.warn(`[accountingRateLimit] ${provider} daily limit is not a positive number (${detail}); treating it as no daily budget`);
  }
  return null;
}

/**
 * Spend one unit of today's budget. Runs LAST because it is the scarcest unit:
 * it is only spent once every other check has passed, and — like the window
 * units already spent — it is never refunded.
 */
async function spendDaily(redis: Redis, provider: AccountingProviderId, limit: number, connectionId: string): Promise<void> {
  const key = keyFor(provider, 'day', connectionId);
  const used = await store(provider, () => redis.incr(key));
  if (used === 1) await store(provider, () => redis.pexpire(key, DAY_MS));
  if (used <= limit) return;
  const ttl = await store(provider, () => redis.pttl(key));
  if (ttl > 0) throw refused(provider, 'daily budget', ttl);
  if (ttl === -1) {
    // The PEXPIRE after the first INCR was lost: without a TTL this counter
    // would never reset and the connection would stay refused forever.
    await store(provider, () => redis.pexpire(key, DAY_MS));
    throw refused(provider, 'daily budget', DAY_MS);
  }
  // -2: the day window rolled over between INCR and PTTL.
  throw refused(provider, 'daily budget', RATE_LIMIT_FALLBACK_RETRY_MS);
}

async function releaseSlot(redis: Redis, key: string, token: string): Promise<void> {
  try {
    await runOutsideDbContext(() => redis.eval(RELEASE_LUA, 1, key, token));
  } catch (err) {
    // The lease expiry reclaims a missed release; never let it replace the caller's outcome.
    console.error('[accountingRateLimit] concurrency release failed', err instanceof Error ? err.message : err);
  }
}

/**
 * Acquire every slot the spec declares, run fn, release the concurrency slot.
 * Throws AccountingProviderError{kind:'rate_limited', retryAfterMs,
 * throttleSource} when any slot is refused.
 *
 * Check order (ruling P2a): concurrency lease → per-connection window →
 * app-wide window → daily budget. The lease goes FIRST because a concurrency
 * refusal (retried every CONCURRENCY_RETRY_MS) must not spend window units —
 * only the window that itself refuses is refunded (`refundOnReject`); units an
 * EARLIER window already granted are spent. Daily goes last as the scarcest.
 * Any refusal or store error after the lease is taken releases it.
 */
export async function withProviderCallSlot<T>(
  provider: AccountingProviderId,
  spec: RateLimitSpec,
  connectionId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const redis = getRedis();
  if (!redis) {
    if (!warnedRedisDown) {
      warnedRedisDown = true;
      console.warn('[accountingRateLimit] Redis unavailable; accounting calls are not locally rate limited (provider 429s still apply)');
    }
    return fn();
  }
  if (clientUnusable(redis)) throw limiterUnavailable(provider, `client ${redis.status}`);

  const inflightKey = keyFor(provider, 'inflight', connectionId);
  const cap = spec.maxConcurrentPerConnection;
  const dailyLimit = resolveDailyLimit(provider, spec);
  let token: string | null = null;
  try {
    await runOutsideDbContext(async () => {
      if (cap !== null) {
        const leaseToken = randomUUID();
        // Set before the round trip: if the reply is lost after the script ran,
        // the catch below still removes the lease it may have added.
        token = leaseToken;
        const ok = await store(provider, () =>
          redis.eval(ACQUIRE_LUA, 1, inflightKey, cap, INFLIGHT_LEASE_MS, leaseToken, Date.now()));
        if (Number(ok) !== 1) {
          token = null;
          throw refused(provider, 'concurrency', CONCURRENCY_RETRY_MS);
        }
      }
      await checkWindow(redis, provider, keyFor(provider, 'conn', connectionId),
        spec.perConnection.limit, spec.perConnection.windowSeconds, 'per connection');
      if (spec.appWide) {
        await checkWindow(redis, provider, keyFor(provider, 'app'), spec.appWide.limit, spec.appWide.windowSeconds, 'app-wide');
      }
      if (dailyLimit !== null) {
        await spendDaily(redis, provider, dailyLimit, connectionId);
      }
    });
  } catch (err) {
    if (token !== null) await releaseSlot(redis, inflightKey, token);
    throw err;
  }

  try {
    return await fn();
  } finally {
    if (token !== null) await releaseSlot(redis, inflightKey, token);
  }
}

/** Record a provider-reported "calls left today" (e.g. Xero X-DayLimit-Remaining, W02). Never throws. */
export async function noteDailyRemaining(provider: AccountingProviderId, connectionId: string, remaining: number): Promise<void> {
  const redis = getRedis();
  if (!redis || !Number.isFinite(remaining)) return;
  try {
    await runOutsideDbContext(() => redis.set(
      keyFor(provider, 'day-remaining', connectionId), String(Math.max(0, Math.floor(remaining))), 'PX', DAY_MS,
    ));
  } catch (err) {
    console.error('[accountingRateLimit] could not record daily remaining', err instanceof Error ? err.message : err);
  }
}

/**
 * 0..1 remaining fraction of today's budget, or null when the provider declares
 * no (usable) daily budget — or when it cannot be read (Redis down or erroring):
 * a sweep must never crash on a limiter read, so "unknown" is reported, not thrown.
 */
export async function dailyBudgetRemainingRatio(
  provider: AccountingProviderId, spec: RateLimitSpec, connectionId: string,
): Promise<number | null> {
  const limit = resolveDailyLimit(provider, spec);
  if (limit === null) return null;
  const redis = getRedis();
  if (!redis) return null;
  let reported: string | null;
  let used: string | null;
  try {
    [reported, used] = await runOutsideDbContext(() => Promise.all([
      redis.get(keyFor(provider, 'day-remaining', connectionId)),
      redis.get(keyFor(provider, 'day', connectionId)),
    ]));
  } catch (err) {
    console.error('[accountingRateLimit] could not read the daily budget', err instanceof Error ? err.message : err);
    return null;
  }
  const usedCount = Number(used ?? 0);
  const reportedCount = reported === null ? Number.NaN : Number(reported);
  const fromCounter = Number.isFinite(usedCount) ? (limit - usedCount) / limit : 1;
  const fromHeader = Number.isFinite(reportedCount) ? reportedCount / limit : 1;
  return Math.max(0, Math.min(fromCounter, fromHeader, 1));
}

/** True when background sweeps for this connection must wait (remaining below BACKGROUND_DEFER_RATIO). */
export async function shouldDeferBackgroundWork(
  provider: AccountingProviderId, spec: RateLimitSpec, connectionId: string,
): Promise<boolean> {
  const ratio = await dailyBudgetRemainingRatio(provider, spec, connectionId);
  return ratio !== null && ratio < BACKGROUND_DEFER_RATIO;
}
