import { getRedis } from '../redis';

// OAuth "still retrying" counter (spec §3, W4 plan D8). The grant.error logger
// (oauth/grantErrorLog.ts) calls recordRefreshRetry() for each
// `invalid_grant: refresh token not found` from an authenticated client; the
// oauth_grant source reads today's count for each broken grant's client and
// says so in the incident detail. Per client, because the token endpoint does
// not know which account a dead token belonged to.
//
// Decoration only: every Redis failure degrades to "no count", never to an
// error on the token endpoint or a failed reconcile.

export const RETRY_COUNTER_TTL_S = 2 * 24 * 60 * 60;
const READ_TIMEOUT_MS = 1_000;

const utcDay = (now: Date) => now.toISOString().slice(0, 10);

export function retryCounterKey(clientId: string, now: Date): string {
  return `connection-health:oauth-retry:${clientId}:${utcDay(now)}`;
}

const lastWarnAt = new Map<string, number>();
/** At most one line per operation per minute, so one failing op cannot hide another. */
function warnThrottled(op: string, err: unknown) {
  const at = Date.now();
  if (at - (lastWarnAt.get(op) ?? 0) < 60_000) return;
  lastWarnAt.set(op, at);
  console.warn(JSON.stringify({
    event: 'connection_health_oauth_retry_counter_error',
    op,
    error: (err instanceof Error ? err.message : String(err)).slice(0, 200),
  }));
}

/** Fire-and-forget; returns at once and never throws (it runs inside an oidc-provider event listener). */
export function recordRefreshRetry(clientId: string, now: Date = new Date()): void {
  try {
    const redis = getRedis();
    if (!redis) return;
    const key = retryCounterKey(clientId, now);
    // EXPIRE on every hit, not only the first: a lost EXPIRE is repaired by
    // the next retry instead of leaving a key that never expires.
    void redis.incr(key)
      .then(() => redis.expire(key, RETRY_COUNTER_TTL_S))
      .catch((err: unknown) => warnThrottled('incr', err));
  } catch (err) {
    warnThrottled('get-client', err);
  }
}

/** Today's counts (UTC) for the given clients; clients with none are absent. Never throws. */
export async function readRefreshRetryCounts(
  clientIds: readonly string[],
  now: Date,
  timeoutMs: number = READ_TIMEOUT_MS,
): Promise<Map<string, number>> {
  const ids = [...new Set(clientIds)];
  const out = new Map<string, number>();
  if (ids.length === 0) return out;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const redis = getRedis();
    if (!redis) return out;
    const values = await Promise.race([
      redis.mget(...ids.map((id) => retryCounterKey(id, now))),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('mget timed out')), timeoutMs); }),
    ]);
    ids.forEach((id, i) => {
      const n = Number(values[i] ?? 0);
      if (Number.isFinite(n) && n > 0) out.set(id, Math.floor(n));
    });
  } catch (err) {
    warnThrottled('mget', err);
  } finally {
    clearTimeout(timer);
  }
  return out;
}

export function retryingDetail(count: number): string | null {
  if (!(count > 0)) return null;
  // Worded so the shared sanitizer's `token: <value>` redaction leaves the count alone.
  return `The app keeps retrying its revoked token (${count} failed refresh${count === 1 ? '' : 'es'} today, UTC).`;
}
