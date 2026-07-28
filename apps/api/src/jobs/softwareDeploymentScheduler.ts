import { Job, Queue, Worker } from 'bullmq';
import { and, eq, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import * as dbModule from '../db';
import { db } from '../db';
import {
  deploymentResults,
  maintenanceWindows,
  softwareCatalog,
  softwareDeployments,
  softwareVersions,
} from '../db/schema';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import { buildAndDispatchSoftwareInstalls } from '../services/softwareDeployment';

const QUEUE_NAME = 'software-deployment-scheduler';
const JOB_NAME = 'dispatch-due-software-deployments';

// §1.3 of the 2026-07-28 software-deployment-visibility plan: scheduled and
// maintenance-window software deployments used to insert rows and sit
// `pending` forever — nothing consumed `scheduledAt`. This repeatable job
// claims due deployments (via the `dispatched_at IS NULL` conditional update,
// so multiple API instances never double-dispatch) and runs the same
// payload-building fan-out the immediate path uses.
export const SCHEDULER_INTERVAL_MS = 60 * 1000; // every 60s
export const MAX_DEPLOYMENTS_PER_TICK = 200;

// Both vocabularies are in the wild: the canonical create route stores
// 'maintenance' (routes/software.ts scheduleType enum) while the legacy
// /software/deploy route and the plan use 'maintenance_window'. Either way
// the row links a maintenance_window_id, so the scheduler accepts both.
export const MAINTENANCE_SCHEDULE_TYPES = ['maintenance_window', 'maintenance'] as const;

type SchedulerJobData = { type: typeof JOB_NAME; queuedAt: string };

const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  if (typeof withSystem !== 'function') {
    throw new Error(
      '[SoftwareDeploymentScheduler] withSystemDbAccessContext not available — scheduler cannot run without system DB access',
    );
  }
  return withSystem(fn);
};

let schedulerQueue: Queue<SchedulerJobData> | null = null;
let schedulerWorker: Worker<SchedulerJobData> | null = null;

function getQueue(): Queue<SchedulerJobData> {
  if (!schedulerQueue) {
    schedulerQueue = new Queue<SchedulerJobData>(QUEUE_NAME, {
      connection: getBullMQConnection(),
    });
  }
  return schedulerQueue;
}

export interface DueDeploymentCandidate {
  id: string;
  orgId: string;
  softwareVersionId: string;
  scheduleType: string;
  scheduledAt: Date | null;
  options: unknown;
  createdBy: string | null;
  windowStatus: string | null;
  windowStartTime: Date | null;
  windowEndTime: Date | null;
}

/**
 * Whether the deployment's linked maintenance window is currently OPEN.
 * Mirrors System B's interpretation (jobs/deploymentWorker.ts →
 * services/deploymentEngine.ts isDeviceInMaintenanceWindow): a window counts
 * as open while `status = 'scheduled'` and `startTime <= now <= endTime` —
 * start/end are absolute timestamps, so recurrence/timezone need no extra
 * evaluation here, exactly as in the System B gate.
 */
export function isMaintenanceWindowOpen(
  candidate: Pick<DueDeploymentCandidate, 'windowStatus' | 'windowStartTime' | 'windowEndTime'>,
  now: Date,
): boolean {
  return (
    candidate.windowStatus === 'scheduled' &&
    candidate.windowStartTime !== null &&
    candidate.windowStartTime.getTime() <= now.getTime() &&
    candidate.windowEndTime !== null &&
    candidate.windowEndTime.getTime() >= now.getTime()
  );
}

/** Dueness rule for an undispatched install deployment. Exported for tests. */
export function isDeploymentDue(candidate: DueDeploymentCandidate, now: Date): boolean {
  if (candidate.scheduleType === 'scheduled') {
    return candidate.scheduledAt !== null && candidate.scheduledAt.getTime() <= now.getTime();
  }
  if ((MAINTENANCE_SCHEDULE_TYPES as readonly string[]).includes(candidate.scheduleType)) {
    return isMaintenanceWindowOpen(candidate, now);
  }
  return false;
}

async function findDueCandidates(now: Date): Promise<DueDeploymentCandidate[]> {
  const rows = await db
    .select({
      id: softwareDeployments.id,
      orgId: softwareDeployments.orgId,
      softwareVersionId: softwareDeployments.softwareVersionId,
      scheduleType: softwareDeployments.scheduleType,
      scheduledAt: softwareDeployments.scheduledAt,
      options: softwareDeployments.options,
      createdBy: softwareDeployments.createdBy,
      windowStatus: maintenanceWindows.status,
      windowStartTime: maintenanceWindows.startTime,
      windowEndTime: maintenanceWindows.endTime,
    })
    .from(softwareDeployments)
    .leftJoin(maintenanceWindows, eq(maintenanceWindows.id, softwareDeployments.maintenanceWindowId))
    .where(
      and(
        // Undispatched only — a set dispatched_at (immediate path, or a prior
        // scheduler claim) permanently excludes the row.
        isNull(softwareDeployments.dispatchedAt),
        // Only 'install' ever dispatches; 'uninstall'/'update' are rejected at
        // create (§1.4) and legacy rows must not start firing now.
        eq(softwareDeployments.deploymentType, 'install'),
        or(
          and(
            eq(softwareDeployments.scheduleType, 'scheduled'),
            isNotNull(softwareDeployments.scheduledAt),
          ),
          and(
            inArray(softwareDeployments.scheduleType, [...MAINTENANCE_SCHEDULE_TYPES]),
            isNotNull(softwareDeployments.maintenanceWindowId),
          ),
        ),
      ),
    )
    .limit(MAX_DEPLOYMENTS_PER_TICK);

  // Precise dueness (scheduledAt <= now; window currently open) is evaluated
  // in JS so the window interpretation stays in one reviewed place.
  return (rows as DueDeploymentCandidate[]).filter((row) => isDeploymentDue(row, now));
}

/** Fail every still-pending result row of a deployment with one message. */
async function failAllPendingResults(deploymentId: string, errorMessage: string): Promise<void> {
  await db
    .update(deploymentResults)
    .set({ status: 'failed', errorMessage, completedAt: new Date() })
    .where(
      and(
        eq(deploymentResults.deploymentId, deploymentId),
        eq(deploymentResults.status, 'pending'),
      ),
    );
}

/**
 * Claim + dispatch one due deployment. Returns true when this instance won
 * the claim (regardless of dispatch outcome), false when another instance
 * already claimed it.
 */
export async function processDueDeployment(candidate: DueDeploymentCandidate): Promise<boolean> {
  // Conditional claim: only one API instance flips dispatched_at from NULL.
  const claimedRows = await db
    .update(softwareDeployments)
    .set({ dispatchedAt: new Date() })
    .where(
      and(
        eq(softwareDeployments.id, candidate.id),
        isNull(softwareDeployments.dispatchedAt),
      ),
    )
    .returning({ id: softwareDeployments.id });

  if (claimedRows.length === 0) {
    return false; // lost the claim race — another instance dispatches
  }

  // Only still-pending result rows are dispatched (cancelled rows stay cancelled).
  const pendingRows = await db
    .select({ deviceId: deploymentResults.deviceId })
    .from(deploymentResults)
    .where(
      and(
        eq(deploymentResults.deploymentId, candidate.id),
        eq(deploymentResults.status, 'pending'),
      ),
    );

  const deviceIds = pendingRows.map((r) => r.deviceId);
  if (deviceIds.length === 0) {
    console.log(
      `[SoftwareDeploymentScheduler] Deployment ${candidate.id} claimed but has no pending result rows — nothing to dispatch`,
    );
    return true;
  }

  const [versionRecord] = await db
    .select()
    .from(softwareVersions)
    .where(eq(softwareVersions.id, candidate.softwareVersionId));
  if (!versionRecord) {
    await failAllPendingResults(candidate.id, 'Software version no longer exists');
    return true;
  }

  const [catalogItem] = await db
    .select({
      id: softwareCatalog.id,
      name: softwareCatalog.name,
      integrationProvider: softwareCatalog.integrationProvider,
    })
    .from(softwareCatalog)
    .where(eq(softwareCatalog.id, versionRecord.catalogId));
  if (!catalogItem) {
    await failAllPendingResults(candidate.id, 'Software catalog item no longer exists');
    return true;
  }

  // Shared payload-building + dispatch fan-out (presign, EDR resolution,
  // {{...}} variables, detection rules, failure pre-writes, WS-vs-queue).
  // markDispatched=false: the conditional claim above already stamped it.
  const fanout = await buildAndDispatchSoftwareInstalls({
    deploymentId: candidate.id,
    orgId: candidate.orgId,
    versionRecord,
    catalogItem,
    deviceIds,
    options: (candidate.options as Record<string, unknown> | null) ?? null,
    createdBy: candidate.createdBy,
    markDispatched: false,
  });

  console.log(
    `[SoftwareDeploymentScheduler] Dispatched deployment ${candidate.id} (${candidate.scheduleType}): status=${fanout.status}, devices=${fanout.dispatchedDeviceIds.length}/${deviceIds.length}`,
  );
  return true;
}

/**
 * One scheduler tick: find due undispatched install deployments, claim each,
 * dispatch its pending result rows. One deployment failing never aborts the
 * tick — each is processed in its own system DB context with its own
 * try/catch (mirrors staleCommandReaper's per-domain isolation).
 */
export async function runSoftwareDeploymentSchedulerTick(): Promise<{
  claimed: number;
  skipped: number;
  errors: number;
}> {
  const now = new Date();
  const candidates = await runWithSystemDbAccess(() => findDueCandidates(now));

  let claimed = 0;
  let skipped = 0;
  let errors = 0;

  for (const candidate of candidates) {
    try {
      const won = await runWithSystemDbAccess(() => processDueDeployment(candidate));
      if (won) claimed++;
      else skipped++;
    } catch (err) {
      errors++;
      console.error(
        `[SoftwareDeploymentScheduler] Error dispatching deployment ${candidate.id}:`,
        err,
      );
      captureException(err instanceof Error ? err : new Error(String(err)));
    }
  }

  if (claimed > 0 || errors > 0) {
    console.log(
      `[SoftwareDeploymentScheduler] Tick complete: claimed=${claimed}, skipped=${skipped}, errors=${errors}`,
    );
  }

  return { claimed, skipped, errors };
}

// ── Worker & queue management ─────────────────────────────────────

function createWorker(): Worker<SchedulerJobData> {
  return new Worker<SchedulerJobData>(
    QUEUE_NAME,
    async (_job: Job<SchedulerJobData>) => runSoftwareDeploymentSchedulerTick(),
    {
      connection: getBullMQConnection(),
      concurrency: 1,
    },
  );
}

async function scheduleRepeatableJob(): Promise<void> {
  const queue = getQueue();

  // Remove any existing repeatable jobs (in case interval changed)
  const repeatables = await queue.getRepeatableJobs();
  for (const job of repeatables) {
    if (job.name === JOB_NAME) {
      await queue.removeRepeatableByKey(job.key);
    }
  }

  await queue.add(
    JOB_NAME,
    { type: JOB_NAME, queuedAt: new Date().toISOString() },
    {
      jobId: 'software-deployment-scheduler',
      repeat: { every: SCHEDULER_INTERVAL_MS },
      removeOnComplete: { count: 20 },
      removeOnFail: { count: 200 },
    },
  );
}

export async function initializeSoftwareDeploymentScheduler(): Promise<void> {
  if (schedulerWorker) return;

  schedulerWorker = createWorker();
  schedulerWorker.on('error', (error) => {
    console.error('[SoftwareDeploymentScheduler] Worker error:', error);
    captureException(error);
  });
  schedulerWorker.on('failed', (job, error) => {
    console.error(`[SoftwareDeploymentScheduler] Job ${job?.id} failed:`, error);
    captureException(error);
  });

  try {
    await scheduleRepeatableJob();
  } catch (err) {
    await schedulerWorker.close();
    schedulerWorker = null;
    throw err;
  }

  console.log('[SoftwareDeploymentScheduler] Initialized');
}

export async function shutdownSoftwareDeploymentScheduler(): Promise<void> {
  const worker = schedulerWorker;
  const queue = schedulerQueue;
  schedulerWorker = null;
  schedulerQueue = null;

  if (worker) {
    try { await worker.close(); } catch (err) {
      console.error('[SoftwareDeploymentScheduler] Error closing worker:', err);
    }
  }
  if (queue) {
    try { await queue.close(); } catch (err) {
      console.error('[SoftwareDeploymentScheduler] Error closing queue:', err);
    }
  }
}
