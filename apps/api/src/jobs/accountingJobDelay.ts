/**
 * Throttling is a delay, not a failure (spec W01 "Rate limiting"): a job refused
 * by the limiter or by a provider 429 goes back to `delayed` at Retry-After and
 * keeps its attempt budget — same mechanism as scriptReviewWorker's concurrency
 * cap (moveToDelayed + DelayedError). BullMQ's `moveToDelayed` passes
 * `skipAttempt`, and the worker special-cases `DelayedError`, so the job is
 * neither failed nor counted and no `failed` event fires.
 */
import { DelayedError, type Job } from 'bullmq';
import {
  DEFAULT_RATE_LIMIT_DELAY_MS,
  isAccountingProviderError,
  rateLimitRetryAfterMs,
  rateLimitSourceOf,
} from '../services/accounting/accountingProviderError';

export { DEFAULT_RATE_LIMIT_DELAY_MS, rateLimitRetryAfterMs };

export const MAX_RATE_LIMIT_DELAY_MS = 24 * 60 * 60 * 1000;
/** A `Retry-After: 0` (or a past HTTP-date) must still back off. */
const MIN_RATE_LIMIT_DELAY_MS = 1_000;

export interface AccountingJobContext { job?: Job; token?: string }

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * The provider operation behind a throttle: the error's own when it is the
 * provider error, else the nearest one down its `cause` chain (a coordinator
 * error wraps it, sometimes via a mapping-service error). Operation names are
 * fixed strings ("<Provider> payment create"), never tokens or PII.
 */
function throttledOperation(err: unknown): string {
  let cursor: unknown = err;
  for (let depth = 0; depth < 3 && cursor instanceof Error; depth++) {
    if (isAccountingProviderError(cursor)) return cursor.operation;
    cursor = cursor.cause;
  }
  return 'unknown';
}

/** moveToDelayed(now + retryAfter, token) + throw DelayedError; without job/token rethrows err (normal retry). */
export async function delayJobForRateLimit(
  ctx: AccountingJobContext | undefined,
  err: unknown,
  retryAfterMs: number,
): Promise<never> {
  if (!ctx?.job || !ctx.token) {
    console.error('[accountingJobDelay] cannot delay a rate-limited job without its lock token; falling back to a normal retry');
    throw err;
  }
  // NaN would clamp to NaN and schedule the job at "now": an immediate retry
  // that consumes no attempt, i.e. an unbounded loop. Non-finite → default.
  const requested = Number.isFinite(retryAfterMs) ? retryAfterMs : DEFAULT_RATE_LIMIT_DELAY_MS;
  const delay = Math.min(Math.max(requested, MIN_RATE_LIMIT_DELAY_MS), MAX_RATE_LIMIT_DELAY_MS);
  const context = [
    `job=${ctx.job.name ?? 'unknown'}`, `jobId=${ctx.job.id ?? 'unknown'}`, `delayMs=${delay}`,
    `source=${rateLimitSourceOf(err) ?? 'unknown'}`, `operation=${throttledOperation(err)}`, `message=${messageOf(err)}`,
  ];
  try {
    await ctx.job.moveToDelayed(Date.now() + delay, ctx.token);
  } catch (moveErr) {
    // Not delayed after all (lost lock, Redis down): the normal BullMQ retry
    // applies to the move failure, and the log must not claim otherwise.
    console.error('[accountingJobDelay] failed to delay throttled job', ...context, `moveError=${messageOf(moveErr)}`);
    throw moveErr;
  }
  // Not an error: an observable line only, so sustained throttling is visible in logs.
  console.warn('[accountingJobDelay] rate limited; job delayed without consuming an attempt', ...context);
  throw new DelayedError();
}
