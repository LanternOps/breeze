/**
 * Audit-Log Retention Worker (Task 29)
 *
 * Walks `audit_retention_policies` daily and deletes `audit_logs` rows
 * older than each policy's `retention_days`. Bypasses Task 1's
 * append-only protections via two stacked layers (both required):
 *
 *   1. `SET LOCAL ROLE breeze_audit_admin` — `breeze_app` has no DELETE
 *      privilege on `audit_logs` (migration 2026-05-25-a). The
 *      `breeze_audit_admin` role (migration 2026-05-25-i) does, and
 *      breeze_app is a member, so a SET LOCAL ROLE inside the
 *      transaction is sufficient to clear the privilege check.
 *
 *   2. `SET LOCAL breeze.allow_audit_retention = '1'` — the
 *      `audit_log_immutable` trigger refuses every DELETE unless this
 *      session GUC is '1'. The bypass is per-transaction (SET LOCAL)
 *      and is never set outside this worker. Even another bug that
 *      somehow obtained the role membership cannot delete without
 *      explicitly setting this GUC in the same transaction.
 *
 * Per-policy transaction isolation: each policy runs in its own
 * `withSystemDbAccessContext` so a failure deleting for one org does
 * not abort the whole job. Postgres aborts the current transaction on
 * SQL error ("current transaction is aborted, commands ignored until
 * end of transaction block"), so a single outer transaction would
 * cascade-fail the entire pass.
 *
 * Idempotent: re-running the same day matches zero rows because the
 * previous run already deleted everything older than the cutoff.
 *
 * Schedule: daily at 03:30 UTC, half-hour offset from oauthCleanup
 * (03:00 UTC) so the two crons don't pile onto the same minute.
 *
 * Kill switch: `AUDIT_RETENTION_ENABLED=false` skips schedule
 * registration without disabling the worker (so manual `add()` calls
 * for incident response still drain).
 */

import { Queue, Worker, Job } from 'bullmq';
import { sql } from 'drizzle-orm';
import * as dbModule from '../db';
import { captureException } from '../services/sentry';
import { getBullMQConnection } from '../services/redis';

const QUEUE_NAME = 'audit-log-retention';
const JOB_NAME = 'audit-log-retention';
const REPEAT_JOB_ID = 'audit-log-retention';
// Daily at 03:30 UTC — off-peak and offset from oauthCleanup's 03:00.
const DAILY_CRON = '30 3 * * *';

function isRetentionEnabled(): boolean {
  const raw = process.env.AUDIT_RETENTION_ENABLED;
  if (raw === undefined || raw === '') return true; // default ON
  const v = raw.trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'no' || v === 'off');
}

const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  if (typeof dbModule.withSystemDbAccessContext !== 'function') {
    throw new Error(
      '[AuditRetention] withSystemDbAccessContext is not available — DB module may not have loaded correctly',
    );
  }
  return dbModule.withSystemDbAccessContext(fn);
};

export interface RetentionStats {
  policies: number;
  orgsPruned: number;
  rowsDeleted: number;
  errors: number;
  durationMs: number;
}

interface PolicyRow {
  id: string;
  org_id: string;
  retention_days: number;
}

/**
 * Walk all retention policies and prune expired audit_logs rows.
 *
 * Exported for direct invocation (tests, manual incident response).
 * The worker processor below calls this and surfaces the stats in the
 * job return value.
 */
export async function pruneExpiredAuditLogs(): Promise<RetentionStats> {
  const startedAt = Date.now();
  const stats: RetentionStats = {
    policies: 0,
    orgsPruned: 0,
    rowsDeleted: 0,
    errors: 0,
    durationMs: 0,
  };

  // Read the policy list under its own system context. A single
  // SELECT is fast and we don't want the policy fetch to share a
  // transaction with the per-org DELETE (which we want isolated).
  const policies = await runWithSystemDbAccess(async () => {
    const rows = (await dbModule.db.execute(sql`
      SELECT id, org_id, retention_days
      FROM audit_retention_policies
    `)) as unknown as PolicyRow[];
    return rows;
  });
  stats.policies = policies.length;

  for (const policy of policies) {
    try {
      const rowsDeleted = await runWithSystemDbAccess(async () => {
        // Both bypass layers are SET LOCAL — they apply only to this
        // transaction and revert on commit/rollback automatically.
        await dbModule.db.execute(sql`SET LOCAL ROLE breeze_audit_admin`);
        await dbModule.db.execute(sql`SET LOCAL breeze.allow_audit_retention = '1'`);

        const result = await dbModule.db.execute(sql`
          DELETE FROM audit_logs
          WHERE org_id = ${policy.org_id}
            AND timestamp < (now() - (${policy.retention_days}::int * interval '1 day'))
        `);
        const raw = result as unknown as { rowCount?: number; count?: number };
        const count = typeof raw.rowCount === 'number'
          ? raw.rowCount
          : typeof raw.count === 'number'
            ? raw.count
            : Array.isArray(result) ? (result as unknown[]).length : 0;

        // Re-anchor the chain. After the DELETE the new oldest surviving
        // row still carries prev_checksum pointing at the deleted row,
        // which makes audit_log_verify_chain flag it as a break the next
        // morning — defeating the entire tamper-detection signal.
        //
        // Find the new chain head per org and rewrite prev_checksum to
        // NULL + checksum to the canonical hash with prev=NULL. The
        // WHERE filter on the existing prev_checksum makes this a no-op
        // when no rows were deleted (oldest row's prev_checksum already
        // NULL) and avoids unnecessary writes on idempotent reruns.
        if (count > 0) {
          await dbModule.db.execute(sql`
            WITH head AS (
              SELECT a.*
              FROM audit_logs a
              WHERE a.org_id IS NOT DISTINCT FROM ${policy.org_id}
              ORDER BY a.timestamp, a.id
              LIMIT 1
            )
            UPDATE audit_logs
            SET prev_checksum = NULL,
                checksum = encode(
                  sha256(audit_log_canonical_payload(head, NULL)::bytea),
                  'hex'
                )
            FROM head
            WHERE audit_logs.id = head.id
              AND head.prev_checksum IS NOT NULL
          `);
        }

        return count;
      });

      stats.rowsDeleted += rowsDeleted;
      stats.orgsPruned += 1;

      // Record last_cleanup_at in its own transaction (the DELETE tx
      // already committed). breeze_app retains UPDATE on
      // audit_retention_policies via the blanket grant — no role
      // switch needed here.
      await runWithSystemDbAccess(async () => {
        await dbModule.db.execute(sql`
          UPDATE audit_retention_policies
          SET last_cleanup_at = now(), updated_at = now()
          WHERE id = ${policy.id}
        `);
      });
    } catch (err) {
      stats.errors += 1;
      captureException(err);
      console.error(
        `[AuditRetention] cleanup failed for org=${policy.org_id} policy=${policy.id}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  stats.durationMs = Date.now() - startedAt;
  console.log(
    `[AuditRetention] Pruned ${stats.rowsDeleted} row(s) across ${stats.orgsPruned}/${stats.policies} polic(ies) in ${stats.durationMs}ms (errors=${stats.errors})`,
  );
  return stats;
}

let retentionQueue: Queue | null = null;
let retentionWorker: Worker | null = null;

export function getAuditRetentionQueue(): Queue {
  if (!retentionQueue) {
    retentionQueue = new Queue(QUEUE_NAME, {
      connection: getBullMQConnection(),
    });
  }
  return retentionQueue;
}

export function createAuditRetentionWorker(): Worker {
  return new Worker(
    QUEUE_NAME,
    async (job: Job) => {
      if (job.name !== JOB_NAME) {
        console.warn(`[AuditRetention] Ignoring unknown job name: ${job.name}`);
        return { skipped: true, rowsDeleted: 0 };
      }
      return pruneExpiredAuditLogs();
    },
    {
      connection: getBullMQConnection(),
      concurrency: 1,
    },
  );
}

export async function scheduleAuditRetention(
  queue: Queue = getAuditRetentionQueue(),
): Promise<void> {
  // Always clear any prior repeatable so a cron-pattern change takes
  // effect on redeploy (BullMQ keys repeatables by the full option
  // set; stale entries would otherwise accumulate).
  const existingJobs = await queue.getRepeatableJobs();
  for (const job of existingJobs) {
    if (job.name === JOB_NAME) {
      await queue.removeRepeatableByKey(job.key);
    }
  }

  if (!isRetentionEnabled()) {
    console.log(
      '[AuditRetention] AUDIT_RETENTION_ENABLED=false — skipping schedule registration',
    );
    return;
  }

  await queue.add(
    JOB_NAME,
    {},
    {
      // Stable jobId gives BullMQ multi-replica dedup: only one
      // replica wins the scheduled-job insert per fire time. Workers
      // on every replica still share processing — only scheduling is
      // singleton.
      jobId: REPEAT_JOB_ID,
      repeat: { pattern: DAILY_CRON },
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 25 },
    },
  );
  console.log(
    `[AuditRetention] Scheduled daily retention (cron "${DAILY_CRON}", jobId=${REPEAT_JOB_ID})`,
  );
}

export async function initializeAuditRetentionWorker(): Promise<void> {
  try {
    retentionWorker = createAuditRetentionWorker();

    retentionWorker.on('error', (error) => {
      console.error('[AuditRetention] Worker error:', error);
      captureException(error);
    });

    retentionWorker.on('failed', (job, error) => {
      console.error(`[AuditRetention] Job ${job?.id} failed:`, error);
      captureException(error);
    });

    await scheduleAuditRetention();
    console.log('[AuditRetention] Worker initialized');
  } catch (error) {
    console.error('[AuditRetention] Failed to initialize:', error);
    throw error;
  }
}

export async function shutdownAuditRetentionWorker(): Promise<void> {
  if (retentionWorker) {
    await retentionWorker.close();
    retentionWorker = null;
  }
  if (retentionQueue) {
    await retentionQueue.close();
    retentionQueue = null;
  }
}

// Exported for test introspection.
export const __testOnly = {
  QUEUE_NAME,
  JOB_NAME,
  REPEAT_JOB_ID,
  DAILY_CRON,
  isRetentionEnabled,
};
