/**
 * Workspace orphan reaper (spec §6 step 6, §9 "Worker crash mid-run").
 *
 * Every 60 seconds, destroys any `ai_run_workspaces` row past
 * `deadline_at + 120s` that is not yet `destroyed`, records the outcome, and
 * pages on `destroy_failed`.
 *
 * WHY IT EXISTS: a run's own `finally` destroys its sandbox. A worker that
 * dies mid-run has no `finally`, and the sandbox then bills until its
 * provider-side deadline with nothing in Breeze recording that it is alive.
 * `provider_ref` is precisely what makes that recoverable from another
 * process, which is why §6.2 puts it in the table.
 *
 * WHY IT IS NOT FLAG-GATED: with BREEZE_AI_WORKSPACE_ENABLED off nothing
 * writes this table, so the poll finds nothing and the job is free. Gating it
 * on the flag would mean turning the feature OFF strands every live sandbox —
 * "off" must mean "start nothing new", never "stop watching what already
 * happened" (the same rule aiOperatorTasksEnabled states for the reconciler).
 *
 * Structure deliberately mirrors jobs/approvalExpiryReaper.ts: same queue /
 * worker / repeatable-job shape, same observability attachment, same
 * shutdown pair, same `placement: 'global'` registry entry.
 */
import { Job, Queue, Worker } from 'bullmq';
import { eq, sql } from 'drizzle-orm';

import { db, withSystemDbAccessContext } from '../db';
import { aiRunWorkspaces } from '../db/schema/aiWorkspace';
import type { AiWorkspaceBackend, AiWorkspaceRegion } from '../db/schema/aiWorkspace';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import { incWorkspaceDestroyFailed } from '../services/aiWorkspaceMetrics';
import { getSandboxBackendByName } from '../services/workspace/sandboxBackend';
import { attachWorkerObservability } from './workerObservability';

const QUEUE_NAME = 'workspace-reaper';
const REAP_INTERVAL_MS = 60 * 1000;
/**
 * Grace after the provider deadline before the reaper takes a row. Long enough
 * that a healthy run's own `finally` always wins the race; short enough that a
 * dead worker's sandbox is reclaimed inside the same minute. Spec §6 step 6.
 */
const REAP_GRACE_SECONDS = 120;
const MAX_REAP_PER_RUN = 100;

type ReaperJobData = { type: 'reap-expired-workspaces'; queuedAt: string };

type ClaimedRow = {
  id: string;
  org_id: string;
  run_id: string;
  backend: AiWorkspaceBackend;
  provider_ref: string;
  region: AiWorkspaceRegion;
};

let reaperQueue: Queue<ReaperJobData> | null = null;
let reaperWorker: Worker<ReaperJobData> | null = null;

function getQueue(): Queue<ReaperJobData> {
  if (!reaperQueue) {
    reaperQueue = new Queue<ReaperJobData>(QUEUE_NAME, { connection: getBullMQConnection() });
  }
  return reaperQueue;
}

function rowsOf(result: unknown): ClaimedRow[] {
  const maybe = result as { rows?: ClaimedRow[] } | ClaimedRow[];
  const rows = Array.isArray(maybe) ? maybe : maybe?.rows;
  return Array.isArray(rows) ? rows : [];
}

/**
 * One pass. Claims up to MAX_REAP_PER_RUN overdue rows by flipping them to
 * `destroying` under FOR UPDATE SKIP LOCKED — so two API instances never call
 * destroy() on the same sandbox — then destroys each one.
 */
export async function reapExpiredWorkspaces(): Promise<{ destroyed: number; failed: number }> {
  const claimed = await db.execute<ClaimedRow>(sql`
    WITH due AS (
      SELECT id
      FROM ai_run_workspaces
      WHERE status <> 'destroyed'
        AND status <> 'destroying'
        AND deadline_at < now() - interval '120 seconds'
      ORDER BY deadline_at ASC
      LIMIT ${MAX_REAP_PER_RUN}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE ai_run_workspaces AS w
    SET status = 'destroying'
    FROM due
    WHERE w.id = due.id
    RETURNING w.id, w.org_id, w.run_id, w.backend, w.provider_ref, w.region;
  `);

  const rows = rowsOf(claimed);
  let destroyed = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      const backend = getSandboxBackendByName(row.backend);
      await backend.destroy({
        backend: row.backend,
        providerRef: row.provider_ref,
        region: row.region,
        createdAt: new Date(0),
      });
      await db
        .update(aiRunWorkspaces)
        .set({ status: 'destroyed', destroyedAt: new Date(), lastError: null })
        .where(eq(aiRunWorkspaces.id, row.id));
      destroyed += 1;
    } catch (err) {
      failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      // Spec §9: the row is marked destroy_failed and PAGED. The reaper picks
      // it up again next minute (status <> 'destroyed'), which is the backoff.
      // Never rethrow: one stuck vendor row must not stop the rest draining.
      await db
        .update(aiRunWorkspaces)
        .set({
          status: 'destroy_failed',
          destroyAttempts: sql`${aiRunWorkspaces.destroyAttempts} + 1`,
          lastError: message.slice(0, 2000),
        })
        .where(eq(aiRunWorkspaces.id, row.id))
        .catch((updateErr) => {
          console.error('[WorkspaceReaper] Failed to record destroy_failed:', updateErr);
        });
      incWorkspaceDestroyFailed({ backend: row.backend, region: row.region });
      console.error(
        `[WorkspaceReaper] destroy failed for workspace ${row.id} (${row.backend}/${row.provider_ref}):`,
        err,
      );
      captureException(err instanceof Error ? err : new Error(message), undefined, {
        job: 'workspaceReaper',
        backend: row.backend,
        region: row.region,
      });
    }
  }

  if (rows.length === MAX_REAP_PER_RUN) {
    console.warn(`[WorkspaceReaper] Hit ${MAX_REAP_PER_RUN}-item cap — backlog may be growing`);
  }

  return { destroyed, failed };
}

function createWorker(): Worker<ReaperJobData> {
  return new Worker<ReaperJobData>(
    QUEUE_NAME,
    async (_job: Job<ReaperJobData>) => {
      try {
        const result = await withSystemDbAccessContext(reapExpiredWorkspaces);
        if (result.destroyed > 0 || result.failed > 0) {
          console.log(
            `[WorkspaceReaper] destroyed ${result.destroyed}, failed ${result.failed}`,
          );
        }
        return result;
      } catch (err) {
        console.error('[WorkspaceReaper] Run failed:', err);
        captureException(err instanceof Error ? err : new Error(String(err)));
        throw err;
      }
    },
    { connection: getBullMQConnection(), concurrency: 1 },
  );
}

async function scheduleRepeatableJob(): Promise<void> {
  const queue = getQueue();
  const repeatables = await queue.getRepeatableJobs();
  for (const job of repeatables) {
    if (job.name === 'reap-expired-workspaces') {
      await queue.removeRepeatableByKey(job.key);
    }
  }
  await queue.add(
    'reap-expired-workspaces',
    { type: 'reap-expired-workspaces', queuedAt: new Date().toISOString() },
    {
      jobId: 'workspace-reaper',
      repeat: { every: REAP_INTERVAL_MS },
      removeOnComplete: { count: 20 },
      removeOnFail: { count: 200 },
    },
  );
}

export async function initializeWorkspaceReaper(): Promise<void> {
  if (reaperWorker) return;
  reaperWorker = createWorker();
  attachWorkerObservability(reaperWorker, 'workspaceReaper');
  reaperWorker.on('error', (error) => {
    console.error('[WorkspaceReaper] Worker error:', error);
    captureException(error);
  });
  reaperWorker.on('failed', (job, error) => {
    console.error(`[WorkspaceReaper] Job ${job?.id} failed:`, error);
    captureException(error);
  });
  try {
    await scheduleRepeatableJob();
  } catch (err) {
    await reaperWorker.close();
    reaperWorker = null;
    throw err;
  }
  console.log('[WorkspaceReaper] Initialized');
}

export async function shutdownWorkspaceReaper(): Promise<void> {
  const worker = reaperWorker;
  const queue = reaperQueue;
  reaperWorker = null;
  reaperQueue = null;
  if (worker) {
    try {
      await worker.close();
    } catch (err) {
      console.error('[WorkspaceReaper] Error closing worker:', err);
    }
  }
  if (queue) {
    try {
      await queue.close();
    } catch (err) {
      console.error('[WorkspaceReaper] Error closing queue:', err);
    }
  }
}
