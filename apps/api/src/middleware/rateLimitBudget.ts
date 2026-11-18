import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { getRedis } from '../services/redis';
import { rateLimiter, type RateLimiterOptions } from '../services/rate-limit';
import { envInt } from '../utils/envInt';

/**
 * Bucket metering shared by the front-door limiter (globalRateLimit) and the
 * per-user dashboard budget charged from authMiddleware (#10962).
 *
 * Lives apart from globalRateLimit.ts so authMiddleware, imported by nearly
 * every route module, does not pull in the tunnel-host dispatch that file
 * depends on.
 */

export const TOO_MANY_REQUESTS = 'Too many requests';

/**
 * Requests globalRateLimit metered as a valid session, which is what makes
 * authMiddleware charge the per-user budget. Requests the front door routed
 * elsewhere (an isolated bucket, a tunnel host, a skip prefix, E2E mode) never
 * owe it: a remote-desktop viewer polling through its own bucket must not drain
 * its operator's dashboard budget.
 *
 * Keyed on the raw Request rather than a context variable because the extension
 * gateway dispatches through `wrapper.app.fetch(c.req.raw, ...)`, which builds a
 * new Hono context. A context variable would not reach the authMiddleware
 * inside, and extension routes would silently escape the budget.
 */
const requestsOwingUserRateBudget = new WeakSet<Request>();

export function markUserRateBudgetOwed(c: Context): void {
  requestsOwingUserRateBudget.add(c.req.raw);
}

const MAX_IN_MEMORY_ENTRIES = 100_000;
const CLEANUP_INTERVAL_MS = 60_000; // prune expired entries every 60s

const inMemoryCounters = new Map<string, { count: number; resetAt: number }>();
let lastCleanup = Date.now();
let inMemoryFallbackLogged = false;

/**
 * Clear the in-memory fallback counters so each test starts from a clean
 * budget. Only meaningful when Redis is stubbed out.
 */
export function __resetInMemoryCountersForTests(): void {
  inMemoryCounters.clear();
}

function cleanupExpiredEntries(): void {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_INTERVAL_MS) return;
  lastCleanup = now;
  for (const [key, entry] of inMemoryCounters) {
    if (entry.resetAt <= now) {
      inMemoryCounters.delete(key);
    }
  }
}

/**
 * Spend one request from `key`, setting the X-RateLimit-* headers and, on a
 * denial, `Retry-After`. Returns whether the request may proceed; the caller
 * decides how to answer a denial.
 *
 * No Redis client: per-process in-memory counters, so requests are still
 * metered. A Redis client whose commands fail: rateLimiter fails closed.
 */
export async function spendFromBucket(
  c: Context,
  key: string,
  limit: number,
  windowSeconds: number,
  options?: RateLimiterOptions,
): Promise<boolean> {
  const redis = getRedis();

  if (!redis) {
    if (!inMemoryFallbackLogged) {
      console.warn('[RateLimit] Redis unavailable, using in-memory fallback');
      inMemoryFallbackLogged = true;
    }
    cleanupExpiredEntries();

    const now = Date.now();
    const entry = inMemoryCounters.get(key);

    if (entry && entry.resetAt > now) {
      if (entry.count >= limit) {
        c.header('X-RateLimit-Limit', String(limit));
        c.header('X-RateLimit-Remaining', '0');
        c.header('X-RateLimit-Reset', String(Math.ceil(entry.resetAt / 1000)));
        c.header('Retry-After', String(windowSeconds));
        return false;
      }
      entry.count++;
    } else {
      if (inMemoryCounters.size >= MAX_IN_MEMORY_ENTRIES) {
        // Map full — reject to prevent OOM. Still advertise Retry-After:
        // clients that honour it (the remote-desktop viewer poll does) would
        // otherwise have no signal and keep retrying at full rate.
        c.header('Retry-After', String(windowSeconds));
        return false;
      }
      inMemoryCounters.set(key, { count: 1, resetAt: now + windowSeconds * 1000 });
    }

    return true;
  }

  const result = options
    ? await rateLimiter(redis, key, limit, windowSeconds, 1, options)
    : await rateLimiter(redis, key, limit, windowSeconds);

  // Always set rate limit headers so clients can self-throttle
  c.header('X-RateLimit-Limit', String(limit));
  c.header('X-RateLimit-Remaining', String(result.remaining));
  c.header('X-RateLimit-Reset', String(Math.ceil(result.resetAt.getTime() / 1000)));

  if (!result.allowed) {
    c.header('Retry-After', String(windowSeconds));
    return false;
  }

  return true;
}

const DEFAULT_USER_RATE_BUDGET_PER_MINUTE = 600;
const USER_RATE_BUDGET_WINDOW_SECONDS = 60;

/** USER_RATE_LIMIT_PER_MINUTE, or 600 when unset, empty, invalid or non-positive. */
export function userRateBudgetPerMinute(): number {
  const configured = envInt('USER_RATE_LIMIT_PER_MINUTE', DEFAULT_USER_RATE_BUDGET_PER_MINUTE);
  return configured > 0 ? configured : DEFAULT_USER_RATE_BUDGET_PER_MINUTE;
}

/**
 * Charge one request to the user's dashboard budget. Called by authMiddleware
 * once the token is known good and before its own Postgres reads, so a runaway
 * client is refused without the per-request auth queries. Rejected attempts are
 * refunded: the holder is already authenticated, the budget advertises
 * Retry-After, and raw volume stays bounded by the front door's session ceiling.
 *
 * Throws rather than returning a Response because several callers discard
 * authMiddleware's return value (`await authMiddleware(c, async () => {})`), and
 * a denial they dropped would surface as a 403 or a 500 instead of a 429. The
 * exception carries the headers in `res` because a throw out of the extension
 * gateway's inner app leaves the context they were set on behind;
 * httpExceptionResponse copies them back.
 */
export async function chargeUserRateBudget(c: Context, userId: string): Promise<void> {
  if (!requestsOwingUserRateBudget.has(c.req.raw)) return;

  const allowed = await spendFromBucket(
    c,
    `rl:session:${userId}`,
    userRateBudgetPerMinute(),
    USER_RATE_BUDGET_WINDOW_SECONDS,
    { refundOnReject: true },
  );
  if (!allowed) {
    c.set('rejectReason', 'user_rate_budget');
    throw new HTTPException(429, {
      message: TOO_MANY_REQUESTS,
      res: c.json({ error: TOO_MANY_REQUESTS }, 429),
    });
  }
}
