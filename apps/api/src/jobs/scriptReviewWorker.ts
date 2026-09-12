// apps/api/src/jobs/scriptReviewWorker.ts
//
// The `script-review` BullMQ queue consumer (W02, #5612, roadmap §3.4).
// Per-org concurrency (spec §4.4: "per-org concurrency 3") is enforced
// INSIDE the processor via reviewConcurrency.ts's Redis-counted slot, not
// via this Worker's own `concurrency` option — open-source BullMQ has no
// per-tenant-group concurrency. See reviewConcurrency.ts's header for the
// full rationale (in short: a Postgres advisory lock held across the up-to-
// 60 s Anthropic call would pin a pooled connection per in-flight review).
//
// A job that finds its org's slot full re-delays ITSELF under its own lock
// token via `job.moveToDelayed` + `DelayedError` — the same mechanism
// `fixWatchWorker.ts` uses for its own still-pending re-check, and BullMQ's
// documented way for a processor to defer without a fresh `queue.add()`
// (which would collide with this job's existing lock/id). BullMQ's
// `handleFailed` special-cases `DelayedError`, so a deferral never counts
// against the job's `attempts`.
import { DelayedError, UnrecoverableError, Worker, type Job } from 'bullmq';
import { getBullMQConnection } from '../services/redis';
import { assertQueueJobName, parseQueueJobData } from '../services/bullmqValidation';
import { scriptReviewQueueJobDataSchema } from './queueSchemas';
import { SCRIPT_REVIEW_JOB_NAME, SCRIPT_REVIEW_QUEUE } from '../services/scriptProposals/reviewQueue';
import { ProposalNotReviewableError, runScriptReview } from '../services/scriptProposals/reviewer';
import { releaseOrgReviewSlot, tryAcquireOrgReviewSlot } from '../services/scriptProposals/reviewConcurrency';
import { attachWorkerObservability } from './workerObservability';

const WORKER_NAME = 'scriptReviewWorker';

// Deliberately higher than SCRIPT_REVIEW_ORG_CONCURRENCY (3): this bounds
// TOTAL concurrent reviews across every org, while the per-org gate bounds
// any ONE org. 10 lets roughly three different orgs review at once without
// any single org exceeding its cap.
const WORKER_CONCURRENCY = 10;

// A review can legitimately take up to SCRIPT_REVIEW_TIMEOUT_MS (60 s) plus
// DB round-trips. BullMQ's default lock (30 s) would otherwise expire mid-job
// and the job would be reassigned to another worker while still running —
// same class of fix as maintenanceRebootWorker.ts's lockDuration: 120_000.
const LOCK_DURATION_MS = 90_000;

const CONCURRENCY_RETRY_DELAY_MS = 5_000;

export async function processScriptReviewJob(job: Job<unknown>, token?: string): Promise<void> {
  assertQueueJobName(SCRIPT_REVIEW_QUEUE, job, SCRIPT_REVIEW_JOB_NAME);
  const data = parseQueueJobData(SCRIPT_REVIEW_QUEUE, job, scriptReviewQueueJobDataSchema);

  const acquired = await tryAcquireOrgReviewSlot(data.orgId);
  if (!acquired) {
    if (!token) {
      console.error(`[${WORKER_NAME}] cannot re-delay a concurrency-capped job without a lock token`, {
        proposalId: data.proposalId,
        orgId: data.orgId,
      });
      return;
    }
    await job.moveToDelayed(Date.now() + CONCURRENCY_RETRY_DELAY_MS, token);
    throw new DelayedError();
  }

  try {
    await runScriptReview(data);
  } catch (error) {
    // The proposal left `proposed` with no model review (superseded/expired
    // before we got to it): nothing a retry could change, and no spend.
    if (error instanceof ProposalNotReviewableError) {
      console.error(`[${WORKER_NAME}] ${error.message}`);
      throw new UnrecoverableError(error.message);
    }
    throw error;
  } finally {
    await releaseOrgReviewSlot(data.orgId);
  }
}

let scriptReviewWorker: Worker | null = null;

export async function initializeScriptReviewWorker(): Promise<void> {
  if (scriptReviewWorker) return;
  scriptReviewWorker = new Worker(
    SCRIPT_REVIEW_QUEUE,
    (job: Job, token?: string) => processScriptReviewJob(job, token),
    { connection: getBullMQConnection(), concurrency: WORKER_CONCURRENCY, lockDuration: LOCK_DURATION_MS },
  );
  attachWorkerObservability(scriptReviewWorker, WORKER_NAME);
}

export async function shutdownScriptReviewWorker(): Promise<void> {
  if (scriptReviewWorker) {
    await scriptReviewWorker.close();
    scriptReviewWorker = null;
  }
}
