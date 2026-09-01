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
 * Scale (issue #4239): the prefix bound is an ordered early-stop
 * (`ORDER BY chain_seq LIMIT 1`) rather than a `MIN()` over a full join,
 * and the deletes run in bounded `LIMIT` batches (AUDIT_RETENTION_BATCH_SIZE
 * / AUDIT_RETENTION_MAX_BATCHES), matching the sibling retention jobs. At
 * 22M rows the previous shape planned as a per-policy Seq Scan of
 * `audit_logs`, so each policy cost the same regardless of org size.
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
import { extractRowCount } from '../db/rowCount';
import { captureException } from '../services/sentry';
import { getBullMQConnection } from '../services/redis';
import { jobSchedule } from './scheduleRegistry';

const QUEUE_NAME = 'audit-log-retention';
const JOB_NAME = 'audit-log-retention';
const REPEAT_JOB_ID = 'audit-log-retention';
// Daily at 03:30 UTC — off-peak and offset from oauthCleanup's 03:00.
const DAILY_CRON = jobSchedule('audit-retention');

function parsePositiveIntEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(`[AuditRetention] Invalid ${name}="${raw}", using default ${defaultValue}`);
    return defaultValue;
  }
  return parsed;
}

// Batched deletes (issue #4239). Same LIMIT-loop shape as the sibling retention
// jobs (mlOutputRetention, deviceMetricsRetention, eventDispatchWorker): delete a
// bounded slice, stop as soon as a batch comes back short of the limit.
const BATCH_SIZE = parsePositiveIntEnv('AUDIT_RETENTION_BATCH_SIZE', 5000);
// Per-org ceiling so one org with a large backlog cannot monopolise the nightly
// pass. Stopping early is safe: the cap leaves a shorter chain PREFIX deleted
// (see the ORDER BY note in deleteChainPrefix), and the next run advances it.
const MAX_BATCHES = parsePositiveIntEnv('AUDIT_RETENTION_MAX_BATCHES', 200);

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
  /** Rows removed by the chain-prefix cut. */
  rowsDeleted: number;
  /**
   * Rows removed by the unsealed-row sweep. Reported separately rather than
   * folded into `rowsDeleted` so the prefix-cut number keeps its existing
   * meaning, while sweep deletions stop being invisible in the job result.
   */
  unsealedRowsDeleted: number;
  /** DELETE statements issued across all policies (prefix cut + sweep). */
  batches: number;
  /** Orgs that hit the per-org batch ceiling and still have expired rows. */
  orgsWithBacklog: number;
  errors: number;
  durationMs: number;
}

/** Per-run batch tuning; falsy/absent fields fall back to the env-configured defaults. */
export interface RetentionJobData {
  batchSize?: number;
  maxBatches?: number;
}

interface PolicyRow {
  id: string;
  org_id: string;
  retention_days: number;
}

interface BatchLimits {
  batchSize: number;
  maxBatches: number;
}

interface BatchedDeleteResult {
  rowsDeleted: number;
  batches: number;
  /** True when the ceiling stopped a loop that was still deleting full batches. */
  hasMore: boolean;
}

interface PrunePolicyResult {
  rowsDeleted: number;
  unsealedRowsDeleted: number;
  batches: number;
  hasMore: boolean;
}

// Minimal shape of the postgres-js / drizzle handle we need. Both the
// dedicated audit-admin pool and the request-scoped breeze_app tx expose
// `.execute(sql)`, so the prune routine is agnostic to which one it runs on.
interface SqlExecutor {
  execute: (query: ReturnType<typeof sql>) => Promise<unknown>;
}

/**
 * Run one DELETE repeatedly until a batch comes back short of `batchSize` or the
 * `maxBatches` ceiling is reached. Mirrors the sibling retention jobs' loop
 * (`mlOutputRetention.pruneMetricAnomalies`, `deviceMetricsRetention`).
 *
 * `buildStatement` is a thunk because each iteration needs a fresh `sql`
 * fragment — drizzle's tagged template objects are not safely re-executable.
 */
async function runBatchedDelete(
  exec: SqlExecutor,
  limits: BatchLimits,
  buildStatement: () => ReturnType<typeof sql>,
): Promise<BatchedDeleteResult> {
  let rowsDeleted = 0;
  let batches = 0;
  let lastBatchDeleted = 0;

  while (batches < limits.maxBatches) {
    const result = await exec.execute(buildStatement());
    lastBatchDeleted = extractRowCount(result);
    rowsDeleted += lastBatchDeleted;
    batches += 1;
    if (lastBatchDeleted < limits.batchSize) break;
  }

  return {
    rowsDeleted,
    batches,
    hasMore: batches >= limits.maxBatches && lastBatchDeleted >= limits.batchSize,
  };
}

/**
 * The retention DELETE for a single org, parameterized over the executor so
 * it can run on either pool. Assumes the caller has already armed the
 * trigger-bypass GUC (`breeze.allow_audit_retention = '1'`) on the same
 * transaction/connection.
 */
async function deleteChainPrefix(
  exec: SqlExecutor,
  policy: PolicyRow,
  limits: BatchLimits,
): Promise<PrunePolicyResult> {
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

  // Step 1 — the prefix bound, hoisted out of the DELETE and rewritten as an
  // ordered early-stop (issue #4239). The old form was
  // `MIN(c2.chain_seq)` over the same filtered join. MIN has to consume the
  // WHOLE join before it can answer, and because the arm never constrains
  // `a2.org_id`, `audit_logs_org_timestamp_idx (org_id, timestamp DESC)` is
  // unusable — at 22M rows the planner chose a Seq Scan of audit_logs hash
  // joined to a Seq Scan of audit_log_chain, ~3.3 min and ~14.8 GiB of block
  // reads for ONE org, repeated per policy.
  //
  // `ORDER BY c2.chain_seq LIMIT 1` returns the identical value (the smallest
  // chain_seq in the same filtered set, or NULL) — it is a pure plan change,
  // not a semantic one, and it does not depend on timestamps being monotonic in
  // chain order. But it lets the planner walk audit_log_chain in ascending
  // chain_seq order and PK-probe audit_logs per candidate, stopping at the FIRST
  // young row: ~(deletable prefix + 1) rows instead of the whole table. Which
  // index carries that walk is the planner's choice — measured at 270k rows it
  // took audit_log_chain_pkey with an org_id filter; with many orgs a backward
  // scan of audit_log_chain_org_seq_idx (org_id, chain_seq DESC) is the more
  // selective option. Either way the shape is an ordered early stop, not a scan.
  //
  // chain_seq is bigserial (int8); round-trip it as text so neither the driver's
  // int8 handling nor JS number precision can round a large sequence value.
  const cutoffRows = (await exec.execute(sql`
    SELECT COALESCE(
      (
        SELECT c2.chain_seq
        FROM audit_log_chain c2
        JOIN audit_logs a2 ON a2.id = c2.audit_id
        WHERE c2.org_id = ${policy.org_id}
          AND a2.timestamp >= (now() - (${policy.retention_days}::int * interval '1 day'))
        ORDER BY c2.chain_seq
        LIMIT 1
      ),
      (
        SELECT MAX(c3.chain_seq) + 1
        FROM audit_log_chain c3
        WHERE c3.org_id = ${policy.org_id}
      )
    )::text AS cutoff_seq
  `)) as unknown as Array<{ cutoff_seq: string | null }>;
  // NULL only when the org has no chain entries at all — nothing to prefix-cut.
  const cutoffSeq = cutoffRows[0]?.cutoff_seq ?? null;

  // Step 2 — delete that prefix in bounded batches instead of one unbounded
  // statement (issue #4239). `ORDER BY c.chain_seq` is load-bearing, not
  // cosmetic: each batch must take the LOWEST remaining chain_seq values so
  // that whatever has been deleted is always a contiguous prefix. Without it
  // `LIMIT` would pick an arbitrary subset, and stopping at `maxBatches` would
  // leave holes in the middle of the chain — exactly the permanent linkage
  // break the prefix-cut design exists to prevent.
  const prefix = cutoffSeq === null
    ? { rowsDeleted: 0, batches: 0, hasMore: false }
    : await runBatchedDelete(exec, limits, () => sql`
        DELETE FROM audit_logs
        WHERE id IN (
          SELECT c.audit_id
          FROM audit_log_chain c
          WHERE c.org_id = ${policy.org_id}
            AND c.chain_seq < ${cutoffSeq}::bigint
          ORDER BY c.chain_seq
          LIMIT ${limits.batchSize}
        )
      `);

  // Step 3 — sweep any UNSEALED old rows too (shouldn't exist post-backfill;
  // keeps retention complete if one ever appears). The chain has no entry for
  // them, so deleting them can't affect linkage and needs no ordering. Batched
  // for the same reason as the prefix cut: this is the same 22M-row table.
  const sweep = await runBatchedDelete(exec, limits, () => sql`
    DELETE FROM audit_logs
    WHERE ctid IN (
      SELECT a.ctid
      FROM audit_logs a
      WHERE a.org_id = ${policy.org_id}
        AND a.timestamp < (now() - (${policy.retention_days}::int * interval '1 day'))
        AND NOT EXISTS (SELECT 1 FROM audit_log_chain c WHERE c.audit_id = a.id)
      LIMIT ${limits.batchSize}
    )
  `);

  return {
    rowsDeleted: prefix.rowsDeleted,
    unsealedRowsDeleted: sweep.rowsDeleted,
    batches: prefix.batches + sweep.batches,
    hasMore: prefix.hasMore || sweep.hasMore,
  };
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
async function pruneOrg(policy: PolicyRow, limits: BatchLimits): Promise<PrunePolicyResult> {
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
      return deleteChainPrefix(tx as unknown as SqlExecutor, policy, limits);
    });
  }

  // Legacy shared-credential fallback (issue #915 not yet remediated).
  return runWithSystemDbAccess(async () => {
    // Both bypass layers are SET LOCAL — they apply only to this
    // transaction and revert on commit/rollback automatically.
    await dbModule.db.execute(sql`SET LOCAL ROLE breeze_audit_admin`);
    await dbModule.db.execute(sql`SET LOCAL breeze.allow_audit_retention = '1'`);
    return deleteChainPrefix(dbModule.db as unknown as SqlExecutor, policy, limits);
  });
}

/**
 * Walk all retention policies and prune expired audit_logs rows.
 *
 * Exported for direct invocation (tests, manual incident response).
 * The worker processor below calls this and surfaces the stats in the
 * job return value.
 */
export async function pruneExpiredAuditLogs(
  options: RetentionJobData = {},
): Promise<RetentionStats> {
  const startedAt = Date.now();
  const limits: BatchLimits = {
    batchSize: Math.max(1, options.batchSize ?? BATCH_SIZE),
    maxBatches: Math.max(1, options.maxBatches ?? MAX_BATCHES),
  };
  const stats: RetentionStats = {
    policies: 0,
    orgsPruned: 0,
    rowsDeleted: 0,
    unsealedRowsDeleted: 0,
    batches: 0,
    orgsWithBacklog: 0,
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
      const pruned = await pruneOrg(policy, limits);

      stats.rowsDeleted += pruned.rowsDeleted;
      stats.unsealedRowsDeleted += pruned.unsealedRowsDeleted;
      stats.batches += pruned.batches;
      if (pruned.hasMore) stats.orgsWithBacklog += 1;
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
    `[AuditRetention] Pruned ${stats.rowsDeleted} row(s) (+${stats.unsealedRowsDeleted} unsealed) across ${stats.orgsPruned}/${stats.policies} polic(ies) in ${stats.batches} batch(es) of ${limits.batchSize} in ${stats.durationMs}ms (errors=${stats.errors}, backlogged=${stats.orgsWithBacklog})`,
  );
  if (stats.orgsWithBacklog > 0) {
    // Not an error: the ceiling did its job. Say so loudly anyway, because the
    // only other signal that a backlog is draining across nights is watching
    // rowsDeleted stay pinned at maxBatches * batchSize.
    console.warn(
      `[AuditRetention] ${stats.orgsWithBacklog} org(s) hit the ${limits.maxBatches}-batch ceiling and still have expired rows; the next run continues the prefix.`,
    );
  }
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

export function createAuditRetentionWorker(): Worker<RetentionJobData> {
  return new Worker<RetentionJobData>(
    QUEUE_NAME,
    async (job: Job<RetentionJobData>) => {
      if (job.name !== JOB_NAME) {
        console.warn(`[AuditRetention] Ignoring unknown job name: ${job.name}`);
        return { skipped: true, rowsDeleted: 0 };
      }
      // Batch overrides come off the job payload so an operator draining a
      // backlog by hand can widen the ceiling for one run without a redeploy.
      return pruneExpiredAuditLogs({
        batchSize: job.data?.batchSize,
        maxBatches: job.data?.maxBatches,
      });
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
  BATCH_SIZE,
  MAX_BATCHES,
  isRetentionEnabled,
  parsePositiveIntEnv,
};
