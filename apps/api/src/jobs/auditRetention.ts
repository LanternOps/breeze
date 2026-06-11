/**
 * Audit-Log Retention Worker (Task 29; hardened for issue #915)
 *
 * Walks `audit_retention_policies` daily and deletes `audit_logs` rows
 * older than each policy's `retention_days`.
 *
 * SECURE PATH (AUDIT_ADMIN_DATABASE_URL set, post-#915):
 *   The DELETE runs on a *dedicated* pool that logs in directly as the
 *   `breeze_audit_admin` role (db/auditAdminPool.ts). That role holds the
 *   DELETE privilege; the main `breeze_app` pool does not and — once
 *   `breeze_audit_admin` is REVOKEd from `breeze_app` — cannot acquire it.
 *   Only the trigger-bypass GUC (layer 2 below) is still set; no SET ROLE
 *   is needed because the connection already *is* the admin role. This is
 *   the privilege-separation fix: an attacker inside the API process,
 *   holding only a breeze_app connection, can no longer delete audit rows.
 *
 * LEGACY FALLBACK (AUDIT_ADMIN_DATABASE_URL unset, pre-#915 behavior):
 *   The DELETE runs on the shared breeze_app pool and defeats the
 *   append-only protections via two stacked layers (both required):
 *
 *     1. `SET LOCAL ROLE breeze_audit_admin` — breeze_app is a member of
 *        the role (migration 2026-05-25-i), so a SET LOCAL ROLE inside the
 *        transaction clears the privilege check.
 *     2. `SET LOCAL breeze.allow_audit_retention = '1'` — the
 *        `audit_log_immutable` trigger refuses every DELETE unless this
 *        session GUC is '1'.
 *
 *   This mode is reachable from the breeze_app connection (issue #915) and
 *   logs a loud startup warning. Existing deploys keep working here until
 *   they provision AUDIT_ADMIN_DATABASE_URL.
 *
 * In BOTH paths the trigger still requires `breeze.allow_audit_retention`:
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
import {
  getAuditAdminDb,
  hasDedicatedAuditAdminPool,
  logAuditAdminPoolMode,
} from '../db/auditAdminPool';
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

// Minimal shape of the postgres-js / drizzle handle we need. Both the
// dedicated audit-admin pool and the request-scoped breeze_app tx expose
// `.execute(sql)`, so the prune routine is agnostic to which one it runs on.
interface SqlExecutor {
  execute: (query: ReturnType<typeof sql>) => Promise<unknown>;
}

function extractRowCount(result: unknown): number {
  const raw = result as { rowCount?: number; count?: number };
  if (typeof raw.rowCount === 'number') return raw.rowCount;
  if (typeof raw.count === 'number') return raw.count;
  return Array.isArray(result) ? (result as unknown[]).length : 0;
}

/**
 * The retention DELETE for a single org, parameterized over the executor so
 * it can run on either pool. Assumes the caller has already armed the
 * trigger-bypass GUC (`breeze.allow_audit_retention = '1'`) on the same
 * transaction/connection.
 */
async function deleteChainPrefix(exec: SqlExecutor, policy: PolicyRow): Promise<number> {
  // Prefix-cut delete (issue #1002 redesign): chain_seq order is COMMIT order,
  // which can disagree with timestamp order around long transactions, so a raw
  // `timestamp < cutoff` delete could remove a mid-chain entry and leave a
  // permanent linkage hole. Instead delete the maximal chain PREFIX that is
  // entirely older than the cutoff — everything below the first "young" row in
  // chain order. Old stragglers sitting behind a young row survive one extra
  // nightly cycle and are caught as the prefix advances.
  //
  // No re-anchor follows: audit_log_verify_chain treats the first surviving
  // entry's prev_chain_checksum as the trusted anchor (it references the
  // legitimately pruned prefix), so retention never UPDATEs the chain — or
  // audit_logs — at all. The FK ON DELETE CASCADE removes the pruned rows'
  // chain entries; their BEFORE DELETE trigger passes because both call paths
  // set breeze.allow_audit_retention='1' SET LOCAL before calling this.
  const result = await exec.execute(sql`
    DELETE FROM audit_logs
    WHERE id IN (
      SELECT c.audit_id
      FROM audit_log_chain c
      WHERE c.org_id = ${policy.org_id}
        AND c.chain_seq < COALESCE(
          (
            SELECT MIN(c2.chain_seq)
            FROM audit_log_chain c2
            JOIN audit_logs a2 ON a2.id = c2.audit_id
            WHERE c2.org_id = ${policy.org_id}
              AND a2.timestamp >= (now() - (${policy.retention_days}::int * interval '1 day'))
          ),
          (
            SELECT MAX(c3.chain_seq) + 1
            FROM audit_log_chain c3
            WHERE c3.org_id = ${policy.org_id}
          )
        )
    )
  `);
  const count = extractRowCount(result);

  // Sweep any UNSEALED old rows too (shouldn't exist post-backfill; keeps
  // retention complete if one ever appears). The chain has no entry for them,
  // so deleting them can't affect linkage.
  await exec.execute(sql`
    DELETE FROM audit_logs a
    WHERE a.org_id = ${policy.org_id}
      AND a.timestamp < (now() - (${policy.retention_days}::int * interval '1 day'))
      AND NOT EXISTS (SELECT 1 FROM audit_log_chain c WHERE c.audit_id = a.id)
  `);

  return count;
}

/**
 * Prune one org's expired audit rows.
 *
 *  - SECURE path (AUDIT_ADMIN_DATABASE_URL set): open a transaction on the
 *    dedicated breeze_audit_admin pool, arm only the bypass GUC, and run
 *    the DELETE. No SET ROLE — the connection already holds DELETE.
 *  - LEGACY path: run on the breeze_app pool via withSystemDbAccessContext,
 *    arming BOTH the SET LOCAL ROLE and the bypass GUC (pre-#915 behavior).
 */
async function pruneOrg(policy: PolicyRow): Promise<number> {
  if (hasDedicatedAuditAdminPool()) {
    const adminDb = getAuditAdminDb();
    // Run inside a transaction so SET LOCAL is scoped to this prune. The
    // dedicated pool is NOT under the AsyncLocalStorage db-context, so we
    // drive its own transaction directly.
    return adminDb.transaction(async (tx) => {
      // The dedicated pool is OUTSIDE the AsyncLocalStorage db-context, so it
      // has none of the RLS GUCs set. audit_logs has RLS forced and
      // breeze_audit_admin has no BYPASSRLS, so without system scope the
      // DELETE policy `breeze_has_org_access(org_id)` would filter every row
      // out (silent zero-delete). Establish system scope on this tx so the
      // policy passes — same GUCs withSystemDbAccessContext sets.
      await tx.execute(sql`select set_config('breeze.scope', 'system', true)`);
      await tx.execute(sql`select set_config('breeze.org_id', '', true)`);
      await tx.execute(sql`select set_config('breeze.accessible_org_ids', '*', true)`);
      await tx.execute(sql`select set_config('breeze.accessible_partner_ids', '*', true)`);
      await tx.execute(sql`select set_config('breeze.user_id', '', true)`);
      // Trigger bypass; the connection logs in AS breeze_audit_admin, which
      // already holds the DELETE privilege (no SET ROLE needed).
      await tx.execute(sql`SET LOCAL breeze.allow_audit_retention = '1'`);
      return deleteChainPrefix(tx as unknown as SqlExecutor, policy);
    });
  }

  // Legacy shared-credential fallback (issue #915 not yet remediated).
  return runWithSystemDbAccess(async () => {
    // Both bypass layers are SET LOCAL — they apply only to this
    // transaction and revert on commit/rollback automatically.
    await dbModule.db.execute(sql`SET LOCAL ROLE breeze_audit_admin`);
    await dbModule.db.execute(sql`SET LOCAL breeze.allow_audit_retention = '1'`);
    return deleteChainPrefix(dbModule.db as unknown as SqlExecutor, policy);
  });
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
      const rowsDeleted = await pruneOrg(policy);

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
    // Log secure-vs-legacy mode loudly so operators running pre-#915
    // shared-credential retention are nudged to provision the dedicated
    // AUDIT_ADMIN_DATABASE_URL credential.
    logAuditAdminPoolMode();

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
