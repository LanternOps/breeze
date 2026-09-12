import { Queue } from 'bullmq';
import { and, desc, eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { scriptProposalReviews, type ScriptProposalReviewRow } from '../../db/schema/scriptProposals';
import { getBullMQConnection } from '../redis';
import { captureException } from '../sentry';

export const SCRIPT_REVIEW_QUEUE = 'script-review';

export type ScriptReviewJobData = { proposalId: string; orgId: string; attempt: number };

const POLL_INTERVAL_MS = 2_000;
const MAX_CONSECUTIVE_ERRORS = 5;
const MAX_ATTEMPTS = 3;

let queue: Queue<ScriptReviewJobData> | null = null;

export function getScriptReviewQueue(): Queue<ScriptReviewJobData> {
  if (!queue) queue = new Queue<ScriptReviewJobData>(SCRIPT_REVIEW_QUEUE, { connection: getBullMQConnection() });
  return queue;
}

/**
 * Enqueue one review attempt. The worker lands in W02.
 *
 * The job id carries the ATTEMPT because BullMQ retains a completed job's hash
 * under `removeOnComplete`, which makes a re-add under the same id a silent
 * no-op — a retried review would never run. Colons are forbidden in job ids
 * (repo rule, jobs/quoteSendQueue.ts), so this is `-` separated, unlike the
 * budget reservation key, which is not a job id.
 */
export async function enqueueScriptReview(data: ScriptReviewJobData): Promise<void> {
  await getScriptReviewQueue().add('review', data, {
    jobId: `script-review-${data.proposalId}-${data.attempt}`,
    attempts: MAX_ATTEMPTS,
    backoff: { type: 'exponential', delay: 10_000 },
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 200 },
  });
}

/**
 * Poll the reviews table for a terminal MODEL review of this proposal.
 *
 * `reviewer_kind = 'model'` is load-bearing: the W02 worker writes the
 * `static_scan` row at job START (so the chain is complete even if the model
 * call never completes), and that row is `completed` — without the filter the
 * inline wait would return it instantly and `propose_script` would report
 * `reviewed` with a null risk tier while the proposal was still `proposed`.
 *
 * Modelled on `waitForApproval` (services/aiAgent.ts) with two deliberate
 * differences: a flat 2 s interval rather than a 500 ms→3 s ramp (a model
 * review never completes in under a second, so a fast first poll only costs
 * a query), and NO terminal write on timeout — the reviewer worker owns the
 * proposal's status, and a wait that expired has learned nothing about the
 * review. A `null` here means "not yet", never "failed".
 */
export async function waitForReviewCompletion(
  proposalId: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ScriptProposalReviewRow | null> {
  const startedAt = Date.now();
  let consecutiveErrors = 0;

  while (Date.now() - startedAt < timeoutMs) {
    if (signal?.aborted) return null;
    try {
      // Per-QUERY context, not one around the loop: holding a pooled
      // connection across a 2 s sleep is how a wait at concurrency ≥ pool size
      // becomes a hang.
      const [review] = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
        db.select().from(scriptProposalReviews)
          .where(and(
            eq(scriptProposalReviews.proposalId, proposalId),
            eq(scriptProposalReviews.reviewerKind, 'model'),
          ))
          .orderBy(desc(scriptProposalReviews.createdAt))
          .limit(1)));
      consecutiveErrors = 0;
      if (review) return review;
    } catch (err) {
      consecutiveErrors++;
      console.error(`[script-review] review poll error (attempt ${consecutiveErrors}):`, err);
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        // The breaker tripping is an infrastructure fault, not review latency:
        // the caller will report `pending`, which is indistinguishable from a
        // slow reviewer, so this is the only alarm that fires.
        captureException(err instanceof Error ? err : new Error(String(err)), undefined, {
          service: 'scriptReviewQueue',
        });
        return null;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  return null;
}
