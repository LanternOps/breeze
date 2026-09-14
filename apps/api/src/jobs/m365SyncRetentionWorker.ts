/**
 * M365 tenant sync retention (spec §3.7).
 *
 * Two sweeps, both bounded and both index-driven:
 *
 *  1. Entity rows the tenant no longer has: DELETE where `is_stale` and
 *     `stale_since` is more than 30 days old, in 10k `ctid` batches via each
 *     table's `(stale_since) WHERE is_stale` partial index.
 *  2. Secure Score detail past 90 days: SET `control_scores = NULL` in 10k
 *     batches via `m365_secure_score_snapshots_prunable_idx`
 *     (`(score_date) WHERE control_scores IS NOT NULL`). Partial on purpose —
 *     the predicate stops matching once a row is pruned, so the sweep never
 *     rescans history it has already handled. The row itself is KEPT: the
 *     score numbers are the trend line and are retained indefinitely.
 *
 * Runs under a system DB access context: it is a cross-org sweep with no
 * request to inherit tenancy from. Deliberately NOT gated on
 * `M365_TENANT_SYNC_ENABLED` — that flag guards sync ENTRY points (spec §10),
 * and a sweep over empty tables is a no-op.
 */

import { Job, Queue, Worker } from 'bullmq';
import { sql } from 'drizzle-orm';

import { db, withSystemDbAccessContext } from '../db';
import { extractRowCount } from '../db/rowCount';
import { getBullMQConnection } from '../services/redis';
import { recordRetentionRun } from '../services/retentionMetrics';
import { captureException } from '../services/sentry';
import { jobSchedule } from './scheduleRegistry';
import { attachWorkerObservability } from './workerObservability';

const QUEUE_NAME = 'm365-sync-retention';
const BATCH_SIZE = 10000;
const STALE_RETENTION_DAYS = 30;
const SCORE_DETAIL_RETENTION_DAYS = 90;

/** Entity tables whose stale rows expire. Fixed list, not schema-derived. */
const STALE_ENTITY_TABLES = [
  'm365_users',
  'm365_intune_devices',
  'm365_ca_policies',
  'm365_license_skus',
] as const;

export interface M365SyncRetentionResult {
  deletedEntities: number;
  prunedScoreControls: number;
  durationMs: number;
}

async function deleteStaleEntities(table: string): Promise<number> {
  let deleted = 0;
  for (;;) {
    const result = await db.execute(sql`
      DELETE FROM ${sql.identifier(table)}
      WHERE ctid IN (
        SELECT ctid FROM ${sql.identifier(table)}
        WHERE is_stale
          AND stale_since < now() - make_interval(days => ${STALE_RETENTION_DAYS}::int)
        LIMIT ${BATCH_SIZE}
      )
    `);
    const n = extractRowCount(result);
    deleted += n;
    if (n < BATCH_SIZE) break;
  }
  return deleted;
}

async function pruneScoreControlDetail(): Promise<number> {
  let pruned = 0;
  for (;;) {
    const result = await db.execute(sql`
      UPDATE m365_secure_score_snapshots
      SET control_scores = NULL
      WHERE ctid IN (
        SELECT ctid FROM m365_secure_score_snapshots
        WHERE score_date < current_date - ${SCORE_DETAIL_RETENTION_DAYS}::int
          AND control_scores IS NOT NULL
        LIMIT ${BATCH_SIZE}
      )
    `);
    const n = extractRowCount(result);
    pruned += n;
    if (n < BATCH_SIZE) break;
  }
  return pruned;
}

export async function pruneM365SyncRetention(): Promise<M365SyncRetentionResult> {
  return withSystemDbAccessContext(async () => {
    const startedAt = Date.now();
    let deletedEntities = 0;
    for (const table of STALE_ENTITY_TABLES) {
      deletedEntities += await deleteStaleEntities(table);
    }
    const prunedScoreControls = await pruneScoreControlDetail();
    const durationMs = Date.now() - startedAt;

    console.log(
      `[M365SyncRetention] Deleted ${deletedEntities} stale entity row(s) and pruned `
      + `${prunedScoreControls} score control_scores blob(s) in ${durationMs}ms`,
    );
    // rowsDeleted is the counter's contract (breeze_retention_rows_deleted_total):
    // only the entity DELETEs count. The score-detail prune is an UPDATE that
    // keeps every row, so it is not folded in — it surfaces in the log line
    // above and in the returned job result (prunedScoreControls), and the
    // run itself still stamps the job's last-run gauge.
    recordRetentionRun('m365_sync_retention', { rowsDeleted: deletedEntities });
    return { deletedEntities, prunedScoreControls, durationMs };
  });
}

let retentionQueue: Queue | null = null;
let retentionWorker: Worker | null = null;

export function getM365SyncRetentionQueue(): Queue {
  if (!retentionQueue) {
    retentionQueue = new Queue(QUEUE_NAME, { connection: getBullMQConnection() });
  }
  return retentionQueue;
}

export function createM365SyncRetentionWorker(): Worker {
  return new Worker(
    QUEUE_NAME,
    async (_job: Job) => pruneM365SyncRetention(),
    { connection: getBullMQConnection(), concurrency: 1 },
  );
}

export async function initializeM365SyncRetention(): Promise<void> {
  try {
    retentionWorker = createM365SyncRetentionWorker();
    attachWorkerObservability(retentionWorker, 'm365SyncRetention');
    retentionWorker.on('error', (error) => {
      console.error('[M365SyncRetention] Worker error:', error);
      captureException(error);
    });
    retentionWorker.on('failed', (job, error) => {
      console.error(`[M365SyncRetention] Job ${job?.id} failed after ${job?.attemptsMade} attempts:`, error);
      captureException(error);
    });

    const queue = getM365SyncRetentionQueue();
    for (const existing of await queue.getRepeatableJobs()) {
      await queue.removeRepeatableByKey(existing.key);
    }

    // Daily at a registry-allocated slot. NOT `every: 24h` — BullMQ anchors
    // `every` to the Unix epoch, so every 24h job fires at 00:00:00.000 UTC
    // together (see jobs/scheduleRegistry.ts).
    await queue.add(
      'prune',
      {},
      {
        repeat: { pattern: jobSchedule('m365-sync-retention') },
        removeOnComplete: { count: 5 },
        removeOnFail: { count: 10 },
      },
    );

    console.log('[M365SyncRetention] Retention worker initialized');
  } catch (error) {
    console.error('[M365SyncRetention] Failed to initialize:', error);
    throw error;
  }
}

export async function shutdownM365SyncRetention(): Promise<void> {
  if (retentionWorker) { await retentionWorker.close(); retentionWorker = null; }
  if (retentionQueue) { await retentionQueue.close(); retentionQueue = null; }
}
