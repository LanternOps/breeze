/**
 * W08 (#8147) — DB saturation answered as "busy, retry later", not as a crash.
 *
 * A pool-acquire timeout (#8229/#8243: no slot within DB_POOL_ACQUIRE_TIMEOUT_MS)
 * or an RLS prologue timeout means the caller's work never ran. Answering 503 +
 * Retry-After (30-45 s, jittered) lets every agent since v0.64.3 make ONE
 * attempt per cycle, where a 500 earned four in ~7 s. Retry safety is unchanged
 * from today: agents already retry a 500.
 *
 * Not reported to Sentry: saturation fails many requests at once and would
 * flood it. #8243's throttled `[db-pool-acquire]` line and
 * `breeze_admission_db_saturation_responses_total` carry the signal.
 */
import type { Context } from 'hono';
import { DbAccessContextPrologueTimeoutError, DbPoolAcquireTimeoutError } from '../db/prologueDeadline';
import { recordDbSaturationResponse } from '../services/admission/admissionMetrics';

export type DbSaturationKind = 'pool_acquire_timeout' | 'prologue_timeout';
export const DB_SATURATION_RETRY_AFTER_SECONDS = [30, 45] as const;
const MAX_CAUSE_DEPTH = 3;

export function findDbSaturationError(err: unknown): DbSaturationKind | null {
  let current: unknown = err;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH && current instanceof Error; depth += 1) {
    if (current instanceof DbPoolAcquireTimeoutError) return 'pool_acquire_timeout';
    if (current instanceof DbAccessContextPrologueTimeoutError) return 'prologue_timeout';
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

export function dbSaturationResponse(err: unknown, c: Context, random: () => number = Math.random): Response | null {
  const kind = findDbSaturationError(err);
  if (kind === null) return null;
  const [lo, hi] = DB_SATURATION_RETRY_AFTER_SECONDS;
  const retryAfterSeconds = lo + Math.floor(random() * (hi - lo + 1));
  recordDbSaturationResponse(kind);
  c.set('rejectReason', `db_${kind}`);
  c.header('Retry-After', String(retryAfterSeconds));
  c.header('Cache-Control', 'no-store');
  return c.json({ error: 'Server busy; retry later', code: 'DB_POOL_SATURATED', retryAfterSeconds }, 503);
}
