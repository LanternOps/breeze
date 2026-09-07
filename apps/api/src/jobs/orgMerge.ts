/**
 * Org merge worker (org-lifecycle Wave 2, Task 4).
 *
 * Runs Phase C ("dispose") of the merge, described but deliberately NOT
 * implemented by `services/orgMerge.ts`'s `executeOrgMerge` (Task 3): once
 * the merge transaction has committed and `executeOrgMerge`'s follow-up
 * transaction has stamped the loser org `deleted_at`, leaving it
 * `status='merging'` as a terminal shell, this worker
 *
 *   1. audits `org.merge.completed` (org-less: the loser's own audit trail is
 *      erased with it, so the record of the merge cannot live scoped to it),
 *   2. hands the loser off to the tenant-erasure queue so its now-empty shell
 *      gets the same GDPR-grade cascade delete a manual erasure would run,
 *   3. audits `org.merge.erasure_enqueued`, and
 *   4. best-effort removes the loser from the partner's saved organization
 *      order (cosmetic — a stale id left there is merely ignored by the list
 *      endpoint's ordering, matching no row, never a correctness bug).
 *
 * Module shape mirrors `jobs/tenantErasure.ts` verbatim: a lazily-created
 * Queue/Worker singleton pair, `jobId = org-merge-<loserOrgId>` so a
 * double-trigger (a second admin click, a route retry) collapses into the
 * same job, `attempts: 1` because a partial retry could re-run
 * `executeOrgMerge` against an already-merging/-merged org and mask a real
 * structural bug, and the same error-handler wiring on init.
 *
 * On failure: `executeOrgMerge` throws BEFORE this worker's Phase-C code
 * below ever runs — it has already unfenced the loser back to its prior
 * status and written its own org-less `org.merge.failed` audit internally
 * (see orgMerge.ts). This worker does not catch that throw: it must
 * propagate untouched so BullMQ records the job failed and — critically —
 * so NO erasure job is ever enqueued for a merge that never committed. The
 * three failure modes this can't self-heal are the `tenantOffboarding.ts`
 * sweeper's job, not this worker's retry (see `sweepOffboardingTenants`):
 *
 *   case 1  merge committed and stamped, but this worker died before
 *           finishing Phase C            -> re-enqueue the erasure
 *   case 2  fence set, but the worker died before Phase B ever opened
 *           (no merge event exists)      -> unfence back to the prior status
 *   case 3  Phase B committed (merge event exists) but the follow-up
 *           terminal-shell stamp never landed
 *                                        -> stamp it, then enqueue erasure
 *
 * Cases 2 and 3 look identical on the `organizations` row (`merging` +
 * `deleted_at IS NULL`); only the `org_merge_events` row tells them apart, and
 * getting that backwards would resurrect an already-emptied org.
 */

import { Queue, Worker, Job } from 'bullmq';
import { captureException } from '../services/sentry';
import { getBullMQConnection } from '../services/redis';
import { enqueueOrReplaceStale } from '../services/bullmqUtils';
import { executeOrgMerge, type ExecuteOrgMergeInput, type OrgMergeResult } from '../services/orgMerge';
import { enqueueTenantErasure } from './tenantErasure';
import { createAuditLog, type CreateAuditLogParams } from '../services/auditService';
import { removeOrgFromPartnerOrder } from '../services/orgOrdering';
import { attachWorkerObservability } from './workerObservability';

const QUEUE_NAME = 'org-merge';
const JOB_NAME = 'org-merge';

export interface OrgMergeJobPayload {
  loserOrgId: string;
  survivorOrgId: string;
  partnerId: string;
  performedBy: string;
  performedByEmail?: string;
}

let mergeQueue: Queue | null = null;
let mergeWorker: Worker | null = null;

export function getOrgMergeQueue(): Queue {
  if (!mergeQueue) {
    mergeQueue = new Queue(QUEUE_NAME, {
      connection: getBullMQConnection(),
    });
  }
  return mergeQueue;
}

/**
 * Enqueue a merge job. `jobId = org-merge-<loserOrgId>` so a double-trigger (a
 * second admin click, a route retry) coalesces into the same job.
 *
 * The bare `queue.add` this used to be was a WEDGE. BullMQ's jobId dedup does
 * not distinguish "already running" from "sitting in the failed set": with
 * `attempts: 1` and `removeOnFail: { count: 50 }`, a merge that fails leaves
 * its job behind, and every subsequent `add` under the same jobId is silently
 * DROPPED — `add` returns the stale failed job, the route happily reports a job
 * id, and nothing ever runs. Since `executeOrgMerge` unfences the loser on
 * failure, the org looks perfectly mergeable and the admin has no signal at all
 * beyond "I clicked merge and nothing happened", for the next 50 failures of
 * any merge on this queue.
 *
 * `enqueueOrReplaceStale` (services/bullmqUtils) is the repo's established
 * answer, lifted from `jobs/alertWorker.ts`'s `triggerDeviceEvaluation`: reuse a
 * live job, replace a spent record. A genuine in-flight merge is still
 * collapsed, not restarted.
 *
 * `completed` counts as spent, and that is deliberate: a merge that already ran
 * for this loser can only be re-requested against a DIFFERENT survivor (the
 * same pair is refused by `loadAndValidate`, which sees the terminal shell), so
 * the request must reach the engine and be judged there rather than swallowed
 * by a queue record that expires after 50 jobs anyway.
 */
export async function enqueueOrgMerge(payload: OrgMergeJobPayload): Promise<{ id: string }> {
  return enqueueOrReplaceStale(
    getOrgMergeQueue(),
    JOB_NAME,
    `org-merge-${payload.loserOrgId}`,
    payload,
    {
      attempts: 1,
      removeOnComplete: { count: 50 },
      removeOnFail: { count: 50 },
    },
    '[OrgMerge]',
  );
}

/** Never throws — a lost audit must not turn a successful step into a failed job. */
async function writeAudit(entry: CreateAuditLogParams): Promise<void> {
  try {
    await createAuditLog(entry);
  } catch (err) {
    console.error(`[OrgMerge] audit write for '${entry.action}' failed:`, err);
  }
}

export function createOrgMergeWorker(): Worker {
  return new Worker(
    QUEUE_NAME,
    async (job: Job<OrgMergeJobPayload>) => {
      if (job.name !== JOB_NAME) {
        console.warn(`[OrgMerge] Ignoring unknown job name: ${job.name}`);
        return { skipped: true };
      }
      const { loserOrgId, survivorOrgId, partnerId, performedBy, performedByEmail } = job.data;
      const input: ExecuteOrgMergeInput = { loserOrgId, survivorOrgId, partnerId, performedBy, performedByEmail };

      // Phase B. A throw here propagates untouched — see the failure-mode
      // note in the module docstring. Nothing below this line may run for a
      // merge that did not commit.
      const result: OrgMergeResult = await executeOrgMerge(input);

      // Phase C — dispose.
      await writeAudit({
        orgId: null,
        actorType: 'user',
        actorId: performedBy,
        actorEmail: performedByEmail,
        action: 'org.merge.completed',
        resourceType: 'organization',
        resourceId: loserOrgId,
        details: {
          survivorOrgId,
          mergeEventId: result.mergeEventId,
          tables: result.tables,
          warnings: result.warnings,
        },
        result: 'success',
      });

      const erasureJob = await enqueueTenantErasure({ orgId: loserOrgId, performedBy, performedByEmail });

      await writeAudit({
        orgId: null,
        actorType: 'user',
        actorId: performedBy,
        actorEmail: performedByEmail,
        action: 'org.merge.erasure_enqueued',
        resourceType: 'organization',
        resourceId: loserOrgId,
        details: { erasureJobId: erasureJob.id },
        result: 'success',
      });

      // Cosmetic, best-effort: never lets a failure here mask a completed
      // merge + enqueued erasure, which are the parts that actually matter.
      try {
        await removeOrgFromPartnerOrder(partnerId, loserOrgId);
      } catch (err) {
        console.error(
          `[OrgMerge] failed to remove org ${loserOrgId} from partner ${partnerId}'s saved order:`,
          err,
        );
      }

      return { ...result, jobId: job.id };
    },
    {
      connection: getBullMQConnection(),
      concurrency: 1,
    },
  );
}

export async function initializeOrgMergeWorker(): Promise<void> {
  try {
    mergeWorker = createOrgMergeWorker();
    attachWorkerObservability(mergeWorker, 'orgMerge');
    mergeWorker.on('error', (error) => {
      console.error('[OrgMerge] Worker error:', error);
      captureException(error);
    });
    mergeWorker.on('failed', (job, error) => {
      console.error(`[OrgMerge] Job ${job?.id} failed:`, error);
      captureException(error);
    });
    console.log('[OrgMerge] Worker initialized');
  } catch (error) {
    console.error('[OrgMerge] Failed to initialize:', error);
    throw error;
  }
}

export async function shutdownOrgMergeWorker(): Promise<void> {
  if (mergeWorker) {
    await mergeWorker.close();
    mergeWorker = null;
  }
  if (mergeQueue) {
    await mergeQueue.close();
    mergeQueue = null;
  }
}

// Exported for test introspection.
export const __testOnly = {
  QUEUE_NAME,
  JOB_NAME,
};
