import { Job, Queue, Worker } from 'bullmq';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import { safeErrorMessage } from '../services/aiModels/safeDbError';
import { bullmqJobId } from '../services/bullmqUtils';
import {
  isDriftReportClean,
  reconcilePortalUserIdentities,
  type PortalIdentityDriftReport,
} from '../services/portalUserIdentities';
import { attachWorkerObservability } from './workerObservability';
import { jobSchedule } from './scheduleRegistry';

/**
 * Daily drift report between `portal_user_identities` and the legacy
 * `portal_users.entra_*` columns (portal registration W3, identities release B).
 *
 * REPORT ONLY (plan D10, Todd OD5): it never repairs. Repair happened once, at
 * deploy, in the migration that re-ran the release-A backfill. A scheduled
 * repair could resurrect an identity that a later wave's unlink writer removed
 * while the legacy columns were still set. Drift needs a human: the run logs
 * one JSON line with the four counts and, when anything drifted, raises one
 * Sentry event (fixed fingerprint, no counts or ids in it). The samples are
 * printed on demand by `scripts/portal-identity-reconcile.ts`.
 *
 * `reconcilePortalUserIdentities` opens its own read-only system context and
 * throws when one is already held, so this job deliberately holds none (unlike
 * the `agreementRequestExpiryReaper` template, which wraps its sweep in
 * `withSystemDbAccessContext`).
 */

const QUEUE_NAME = 'portal-identity-reconcile';
const JOB_NAME = 'portal-identity-reconcile';

type ReconcileJobData = { type: typeof JOB_NAME; queuedAt: string };

export type PortalIdentityReconcileResult = {
  clean: boolean;
  counts: PortalIdentityDriftReport['counts'];
};

let reconcileQueue: Queue<ReconcileJobData> | null = null;
let reconcileWorker: Worker<ReconcileJobData> | null = null;

function getQueue(): Queue<ReconcileJobData> {
  if (!reconcileQueue) {
    reconcileQueue = new Queue<ReconcileJobData>(QUEUE_NAME, { connection: getBullMQConnection() });
  }
  return reconcileQueue;
}

/** One report over the whole deployment: a JSON log line, plus a Sentry event when not clean. */
export async function runPortalIdentityReconcile(): Promise<PortalIdentityDriftReport> {
  const report = await reconcilePortalUserIdentities();
  const clean = isDriftReportClean(report);
  console.log(JSON.stringify({
    event: 'portal_identity_drift_report',
    clean,
    checkedAt: report.checkedAt,
    counts: report.counts,
  }));
  if (!clean) {
    captureException(
      new Error('portal identity drift'),
      undefined,
      { eventCode: 'portal_identity_drift' },
      { fingerprint: ['portal_identity_drift'] },
    );
  }
  return report;
}

/** The worker's handler body. */
export async function processPortalIdentityReconcileJob(
  _job?: Job<ReconcileJobData>,
): Promise<PortalIdentityReconcileResult> {
  const report = await runPortalIdentityReconcile();
  return { clean: isDriftReportClean(report), counts: report.counts };
}

function createWorker(): Worker<ReconcileJobData> {
  return new Worker<ReconcileJobData>(
    QUEUE_NAME,
    async (job: Job<ReconcileJobData>) => {
      try {
        return await processPortalIdentityReconcileJob(job);
      } catch (err) {
        // Rethrow only: BullMQ then emits `failed`, and that listener is the
        // single Sentry reporter (capturing here as well double-reported).
        console.error('[PortalIdentityReconcile] Run failed:', safeErrorMessage(err));
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
    if (job.name === JOB_NAME) {
      await queue.removeRepeatableByKey(job.key);
    }
  }
  await queue.add(
    JOB_NAME,
    { type: JOB_NAME, queuedAt: new Date().toISOString() },
    {
      jobId: bullmqJobId(QUEUE_NAME),
      repeat: { pattern: jobSchedule('portal-identity-reconcile') },
      removeOnComplete: { count: 30 },
      removeOnFail: { count: 30 },
    },
  );
}

export async function initializePortalIdentityReconcileJob(): Promise<void> {
  if (reconcileWorker) return;
  reconcileWorker = createWorker();
  attachWorkerObservability(reconcileWorker, 'portalIdentityReconcile');
  reconcileWorker.on('error', (error) => {
    console.error('[PortalIdentityReconcile] Worker error:', safeErrorMessage(error));
    captureException(error);
  });
  reconcileWorker.on('failed', (job, error) => {
    console.error(`[PortalIdentityReconcile] Job ${job?.id} failed:`, safeErrorMessage(error));
    captureException(error);
  });
  try {
    await scheduleRepeatableJob();
  } catch (err) {
    await shutdownPortalIdentityReconcileJob();
    throw err;
  }
  console.log('[PortalIdentityReconcile] Initialized');
}

export async function shutdownPortalIdentityReconcileJob(): Promise<void> {
  const worker = reconcileWorker;
  const queue = reconcileQueue;
  reconcileWorker = null;
  reconcileQueue = null;
  if (worker) {
    try { await worker.close(); } catch (err) { console.error('[PortalIdentityReconcile] Error closing worker:', safeErrorMessage(err)); }
  }
  if (queue) {
    try { await queue.close(); } catch (err) { console.error('[PortalIdentityReconcile] Error closing queue:', safeErrorMessage(err)); }
  }
}
