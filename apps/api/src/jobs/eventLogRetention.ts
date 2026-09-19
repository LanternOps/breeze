/**
 * Event Log Retention Worker
 *
 * BullMQ worker that prunes old event log entries in bounded ctid batches.
 * Resolves per-org retention from event_log configuration policies.
 * Skips orgs on failure to avoid premature data deletion.
 *
 * Batch bounds: EVENT_LOG_RETENTION_BATCH_SIZE / EVENT_LOG_RETENTION_MAX_BATCHES
 * (applied PER ORG). Previously one unbounded DELETE per org, preceded by a
 * `SELECT DISTINCT org_id` across the whole of `device_event_logs` — a full scan
 * of one of the largest tables on every single run, just to learn a list the
 * `organizations` table already holds (#4343).
 *
 * Reading the org list from `organizations` is safe rather than merely cheaper:
 * `device_event_logs.org_id` is `NOT NULL REFERENCES organizations(id)`, so no
 * event log can exist for an org that is absent from that table. Orgs are NOT
 * filtered by status — an archived org's logs still need pruning.
 */

import { Queue, Worker, Job } from 'bullmq';
import { sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { organizations } from '../db/schema';
import { getBullMQConnection } from '../services/redis';
import { recordRetentionRun } from '../services/retentionMetrics';
import { getOrgEventLogRetentionDays } from '../routes/agents/helpers';
import { attachWorkerObservability } from './workerObservability';
import { jobSchedule } from './scheduleRegistry';
import {
  parsePositiveIntEnv,
  pruneInCtidBatches,
  resolveRetentionDays,
  warnOnRetentionBacklog,
} from './retentionBatch';

const LOG_PREFIX = '[EventLogRetention]';

/**
 * Short-lived system context for one read.
 *
 * Deliberately NOT wrapped around the whole sweep: `withDbAccessContext` opens
 * a transaction, so one outer context would hold a connection across every org
 * and every batch — the failure this job is being fixed for.
 */
const inSystemContext = <T>(label: string, fn: () => Promise<T>): Promise<T> =>
  runOutsideDbContext(() => withSystemDbAccessContext(fn, label));

const QUEUE_NAME = 'event-log-retention';
const MAX_RETENTION_DAYS = 365;
// Matches the eventLogInlineSettings validator default (min 7, max 365) and the
// fallback inside getOrgEventLogRetentionDays.
const FALLBACK_RETENTION_DAYS = 30;
const BATCH_SIZE = parsePositiveIntEnv(LOG_PREFIX, 'EVENT_LOG_RETENTION_BATCH_SIZE', 10000);
const MAX_BATCHES = parsePositiveIntEnv(LOG_PREFIX, 'EVENT_LOG_RETENTION_MAX_BATCHES', 200);

let retentionQueue: Queue | null = null;

export function getEventLogRetentionQueue(): Queue {
  if (!retentionQueue) {
    retentionQueue = new Queue(QUEUE_NAME, {
      connection: getBullMQConnection()
    });
  }
  return retentionQueue;
}

interface RetentionJobData {
  retentionDays?: number;
  batchSize?: number;
  maxBatches?: number;
}

export function createEventLogRetentionWorker(): Worker<RetentionJobData> {
  return new Worker<RetentionJobData>(
    QUEUE_NAME,
    // Each read and each delete batch opens its OWN short context — never one
    // spanning the whole sweep. See `inSystemContext` above.
    async (job: Job<RetentionJobData>) => {
      {
        const startTime = Date.now();
        const batchSize = Math.max(1, job.data.batchSize ?? BATCH_SIZE);
        const maxBatches = Math.max(1, job.data.maxBatches ?? MAX_BATCHES);

        // The org list comes from `organizations`, not a DISTINCT scan over
        // device_event_logs — see the module header.
        const orgRows = await inSystemContext('eventLogRetention.orgList', () =>
          db.select({ orgId: organizations.id }).from(organizations));

        let deletedTotal = 0;
        let orgsPruned = 0;
        let orgsSkipped = 0;
        let orgsFailed = 0;
        const orgsWithBacklog: string[] = [];

        for (const { orgId } of orgRows) {
          let retentionDays: number;
          try {
            retentionDays = await inSystemContext('eventLogRetention.resolvePolicy', () =>
              getOrgEventLogRetentionDays(orgId));
          } catch (err) {
            console.error(`${LOG_PREFIX} Failed to resolve retention for org ${orgId}, SKIPPING org to avoid premature data deletion:`, err);
            orgsSkipped += 1;
            continue; // Skip this org — better to retain too much than too little
          }

          // Defence in depth: the validator bounds this to 7..365, so a 0 or
          // negative here is a corrupt/hand-edited row, not a request to delete
          // every event this org has.
          retentionDays = resolveRetentionDays(retentionDays, FALLBACK_RETENTION_DAYS, MAX_RETENTION_DAYS);

          // postgres-js does not coerce JS Date in template-literal params; pass an ISO string.
          const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
          try {
            const result = await pruneInCtidBatches({
              table: 'device_event_logs',
              // `timestamp` is timestamptz here, unlike the other log tables.
              where: sql`org_id = ${orgId}::uuid AND "timestamp" < ${cutoff}::timestamptz`,
              batchSize,
              maxBatches,
              label: 'eventLogRetention.prune',
            });
            deletedTotal += result.deleted;
            orgsPruned += 1;
            if (result.hasMore) {
              orgsWithBacklog.push(orgId);
              // The org id goes in `detail` (console only) — never in the
              // target, which becomes a Sentry tag and must stay bounded.
              warnOnRetentionBacklog(LOG_PREFIX, 'device_event_logs', result, `org=${orgId}`);
            }
          } catch (err) {
            console.error(`${LOG_PREFIX} Failed to prune events for org ${orgId}:`, err);
            orgsFailed += 1;
          }
        }

        const durationMs = Date.now() - startTime;
        console.log(
          `${LOG_PREFIX} Pruned ${deletedTotal} event log rows across ${orgsPruned}/${orgRows.length} orgs ` +
          `(skipped=${orgsSkipped}, failed=${orgsFailed}, backlog=${orgsWithBacklog.length}) in ${durationMs}ms`,
        );

        // A failed OR skipped org's rows certainly remain, so both count as a
        // backlog — otherwise a run where every policy lookup threw deletes
        // nothing and still reports a clean drain. A skipped org is not
        // pruned at all (see the `continue` above), so it is exactly as
        // un-drained as a failed one.
        const incomplete = orgsWithBacklog.length > 0 || orgsFailed > 0 || orgsSkipped > 0;
        recordRetentionRun('event_log_retention', { rowsDeleted: deletedTotal, incomplete });

        return {
          durationMs,
          orgsProcessed: orgRows.length,
          orgsPruned,
          orgsSkipped,
          orgsFailed,
          deleted: deletedTotal,
          hasMore: incomplete,
        };
      }
    },
    {
      connection: getBullMQConnection(),
      concurrency: 1
    }
  );
}

let retentionWorker: Worker<RetentionJobData> | null = null;

export async function initializeEventLogRetention(): Promise<void> {
  try {
    retentionWorker = createEventLogRetentionWorker();
    attachWorkerObservability(retentionWorker, 'eventLogRetention');

    retentionWorker.on('error', (error) => {
      console.error('[EventLogRetention] Worker error:', error);
    });

    const queue = getEventLogRetentionQueue();

    // Remove existing repeatable jobs
    const existingJobs = await queue.getRepeatableJobs();
    for (const job of existingJobs) {
      await queue.removeRepeatableByKey(job.key);
    }

    // Daily at a registry-allocated slot (jobs/scheduleRegistry.ts).
    await queue.add(
      'cleanup',
      { batchSize: BATCH_SIZE, maxBatches: MAX_BATCHES },
      {
        // Daily at a registry-allocated slot. NOT `every: 24h` — BullMQ anchors
        // `every` to the Unix epoch, so every 24h job fires at 00:00:00.000 UTC
        // together (see jobs/scheduleRegistry.ts).
        repeat: { pattern: jobSchedule('event-log-retention') },
        removeOnComplete: { count: 5 },
        removeOnFail: { count: 10 }
      }
    );

    console.log('[EventLogRetention] Retention worker initialized');
  } catch (error) {
    console.error('[EventLogRetention] Failed to initialize:', error);
    throw error;
  }
}

export async function shutdownEventLogRetention(): Promise<void> {
  if (retentionWorker) {
    await retentionWorker.close();
    retentionWorker = null;
  }
  if (retentionQueue) {
    await retentionQueue.close();
    retentionQueue = null;
  }
}

export const __testOnly = {
  QUEUE_NAME,
  BATCH_SIZE,
  MAX_BATCHES,
  FALLBACK_RETENTION_DAYS,
};
