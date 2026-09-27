/**
 * Accounting provider call limiter (spec W01 "Rate limiting"): a per-connection
 * sliding window, an optional per-provider app-wide window, an optional
 * per-connection concurrency cap, and an optional daily budget — all specified
 * by `provider.limits.rate`, all on the shared Redis client (`getRedis`) and the
 * shared sliding-window helper (`rateLimiter`). Providers wrap every outbound
 * API call in `withProviderCallSlot`; a refusal is an
 * AccountingProviderError{kind:'rate_limited'} that the workers turn into a
 * delayed retry that consumes no attempt (jobs/accountingJobDelay.ts).
 *
 * Failure policy (deliberate):
 * - `getRedis()` null (Redis known down) → FAIL OPEN, warn once per process.
 *   The provider's own 429 is the backstop; pushes must not stop because the
 *   limiter's store is down.
 * - Redis throws mid-acquisition → FAIL CLOSED as `rate_limited` with
 *   RATE_LIMIT_FALLBACK_RETRY_MS (never a raw ioredis error), after releasing
 *   whatever was already acquired. `rateLimiter` already fails closed itself.
 *
 * Keys share the `acct-rl:` prefix (the bucket label `rateLimiter` logs) and
 * carry provider + connection ids only, no PII.
 */
import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { getRedis } from '../redis';
import { rateLimiter } from '../rate-limit';
import { runOutsideDbContext } from '../../db';
import { AccountingProviderError } from './accountingProviderError';
import type { AccountingProviderId, RateLimitSpec } from './types';

export const RATE_LIMIT_FALLBACK_RETRY_MS = 5_000;
export const BACKGROUND_DEFER_RATIO = 0.2;
const DAY_MS = 24 * 60 * 60 * 1000;
const CONCURRENCY_RETRY_MS = 2_000;
/**
 * Lifetime of one concurrency lease. A slot a crashed process never released
 * is reclaimed this long after it was taken, however busy the connection is.
 * Far above any provider HTTP timeout, so a live call keeps its slot.
 */
const INFLIGHT_LEASE_MS = 120_000;

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

const keyFor = (provider: AccountingProviderId, part: string, connectionId?: string): string =>
  connectionId === undefined ? `acct-rl:${provider}:${part}` : `acct-rl:${provider}:${part}:${connectionId}`;

function refused(provider: AccountingProviderId, what: string, retryAfterMs: number, cause?: unknown): AccountingProviderError {
  return new AccountingProviderError({
    kind: 'rate_limited',
    provider,
    operation: `accounting call slot (${what})`,
    message: `Accounting provider rate limit reached (${what}); retrying automatically`,
    retryAfterMs: Math.max(1_000, Math.ceil(retryAfterMs)),
    cause,
  });
}

/** One direct Redis round trip during acquisition: any throw becomes a fail-closed refusal. */
async function store<T>(provider: AccountingProviderId, op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (err) {
    console.error('[accountingRateLimit] limiter store error; refusing the call', err instanceof Error ? err.message : err);
    throw refused(provider, 'limiter store unavailable', RATE_LIMIT_FALLBACK_RETRY_MS, err);
  }
}

async function checkWindow(
  redis: Redis, provider: AccountingProviderId, key: string, limit: number, windowSeconds: number, what: string,
): Promise<void> {
  const result = await rateLimiter(redis, key, limit, windowSeconds, 1, { refundOnReject: true });
  if (!result.allowed) {
    const wait = result.resetAt.getTime() - Date.now();
    throw refused(provider, what, wait > 0 ? wait : RATE_LIMIT_FALLBACK_RETRY_MS);
  }
}

/** Spend one unit of today's budget. Runs LAST: the unit is not refundable. */
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
 * Throws AccountingProviderError{kind:'rate_limited', retryAfterMs} when any
 * slot is refused. Check order: per-connection window → app-wide window →
 * concurrency → daily budget (last, because it is the scarcest unit and is
 * not refundable).
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

  const inflightKey = keyFor(provider, 'inflight', connectionId);
  const cap = spec.maxConcurrentPerConnection;
  let token: string | null = null;
  try {
    await runOutsideDbContext(async () => {
      await checkWindow(redis, provider, keyFor(provider, 'conn', connectionId),
        spec.perConnection.limit, spec.perConnection.windowSeconds, 'per connection');
      if (spec.appWide) {
        await checkWindow(redis, provider, keyFor(provider, 'app'), spec.appWide.limit, spec.appWide.windowSeconds, 'app-wide');
      }
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
      if (spec.dailyPerConnection) {
        await spendDaily(redis, provider, spec.dailyPerConnection.limit(), connectionId);
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
 * no daily budget — or when it cannot be read (Redis down or erroring): a sweep
 * must never crash on a limiter read, so "unknown" is reported, not thrown.
 */
export async function dailyBudgetRemainingRatio(
  provider: AccountingProviderId, spec: RateLimitSpec, connectionId: string,
): Promise<number | null> {
  if (!spec.dailyPerConnection) return null;
  const redis = getRedis();
  if (!redis) return null;
  const limit = spec.dailyPerConnection.limit();
  if (limit <= 0) return 0;
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
