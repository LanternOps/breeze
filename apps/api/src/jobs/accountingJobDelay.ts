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
  rateLimitRetryAfterMs,
} from '../services/accounting/accountingProviderError';

export { DEFAULT_RATE_LIMIT_DELAY_MS, rateLimitRetryAfterMs };

export const MAX_RATE_LIMIT_DELAY_MS = 24 * 60 * 60 * 1000;
/** A `Retry-After: 0` (or a past HTTP-date) must still back off. */
const MIN_RATE_LIMIT_DELAY_MS = 1_000;

export interface AccountingJobContext { job?: Job; token?: string }

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
  const delay = Math.min(Math.max(retryAfterMs, MIN_RATE_LIMIT_DELAY_MS), MAX_RATE_LIMIT_DELAY_MS);
  // Not an error: an observable line only, so sustained throttling is visible in logs.
  console.warn(
    '[accountingJobDelay] rate limited; job delayed without consuming an attempt',
    `job=${ctx.job.name ?? 'unknown'}`, `jobId=${ctx.job.id ?? 'unknown'}`, `delayMs=${delay}`,
  );
  await ctx.job.moveToDelayed(Date.now() + delay, ctx.token);
  throw new DelayedError();
}
