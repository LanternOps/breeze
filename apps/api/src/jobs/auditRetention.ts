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
 * Idempotent for orgs that finished: re-running the same day matches zero
 * rows once an org's whole expired prefix is gone. An org that stopped at the
 * AUDIT_RETENTION_MAX_BATCHES ceiling is deliberately NOT idempotent — the
 * next run (same day or not) continues its prefix. See `orgsWithBacklog`.
 *
 * Scale (issue #4239): the prefix bound is an ordered early-stop
 * (`ORDER BY chain_seq LIMIT 1`) rather than a `MIN()` over a full join,
 * and the deletes run in bounded `LIMIT` batches (AUDIT_RETENTION_BATCH_SIZE
 * / AUDIT_RETENTION_MAX_BATCHES), matching the sibling retention jobs. The
 * reporter of #4239 observed the previous shape planning as a per-policy Seq
 * Scan of `audit_logs` on their ~17.8M-row tables, so each policy cost the
 * same regardless of org size. Those numbers are REPORTED, not reproduced
 * here — see the detail in `deleteChainPrefix`.
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
import { recordRetentionRun } from '../services/retentionMetrics';
import { jobSchedule } from './scheduleRegistry';

const QUEUE_NAME = 'audit-log-retention';
const JOB_NAME = 'audit-log-retention';
const REPEAT_JOB_ID = 'audit-log-retention';
// Daily at 03:30 UTC — off-peak and offset from oauthCleanup's 03:00.
const DAILY_CRON = jobSchedule('audit-retention');

function parsePositiveIntEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return defaultValue;
  // Validate the WHOLE string. `Number.parseInt` truncates at the first invalid
  // character and the remainder still passes a `> 0` check, so "1e9" would
  // silently become 1 — batches of a single row, with no warning, on the exact
  // knob an operator reaches for when draining a backlog.
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    console.warn(`[AuditRetention] Invalid ${name}="${raw}" (not a plain integer), using default ${defaultValue}`);
    return defaultValue;
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    console.warn(`[AuditRetention] Invalid ${name}="${raw}", using default ${defaultValue}`);
    return defaultValue;
  }
  return parsed;
}

/**
 * Resolve a per-run batch limit from untrusted job payload data.
 *
 * BullMQ job data is JSON off Redis — an operator hand-enqueuing a drain can put
 * anything in it, and `RetentionJobData` constrains nothing at runtime. The
 * previous `Math.max(1, value ?? DEFAULT)` turned a non-numeric value into `NaN`,
 * and `batches < NaN` is false on the first check, so the loop issued ZERO
 * DELETEs and the pass reported `orgsPruned: 1, errors: 0` — a silent
 * no-op wearing a success. Validate and fall back loudly instead of clamping.
 */
function resolveLimit(name: string, value: number | undefined, defaultValue: number): number {
  if (value === undefined || value === null) return defaultValue;
  if (!Number.isSafeInteger(value) || value <= 0) {
    console.warn(
      `[AuditRetention] Ignoring invalid job-data ${name}=${JSON.stringify(value)}; using ${defaultValue}`,
    );
    return defaultValue;
  }
  return value;
}

// Batched deletes (issue #4239). Same LIMIT-loop shape as the sibling retention
// jobs (mlOutputRetention, deviceMetricsRetention, eventDispatchWorker): delete a
// bounded slice, stop as soon as a batch comes back short of the limit.
//
// SCOPE OF THE WIN, precisely: this bounds each STATEMENT, not the transaction.
// Every batch for one org still commits as a single transaction (SET LOCAL only
// has meaning inside one), so this buys no lock-duration or xmin-horizon relief
// over the previous single unbounded DELETE — it trades one huge statement for
// many small ones and adds a per-run ceiling. The actual #4239 fix is the cutoff
// hoist in deleteChainPrefix; the batching is what keeps any one statement's
// plan index-driven and caps per-run work.
const BATCH_SIZE = parsePositiveIntEnv('AUDIT_RETENTION_BATCH_SIZE', 5000);
// Per-org ceiling so one org with a large backlog cannot monopolise the nightly
// pass. Applied INDEPENDENTLY to the prefix loop and the unsealed sweep, so one
// org can issue up to 2 * MAX_BATCHES statements. Stopping early is safe: the cap
// leaves a shorter chain PREFIX deleted (see the ORDER BY note in
// deleteChainPrefix), and the next run advances it.
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
  /**
   * Orgs whose final batch came back FULL at the ceiling — i.e. almost certainly
   * still have expired rows below the cutoff. A heuristic, not a guarantee: a
   * remainder that is an exact multiple of `batchSize` is counted too. And it
   * says nothing about expired stragglers sitting ABOVE the first young row,
   * which are never in scope for the prefix cut — so `0` is not an all-clear.
   */
  orgsWithBacklog: number;
  /** The org ids behind `orgsWithBacklog`, so a non-draining org is identifiable. */
  backloggedOrgIds: string[];
  /** Policies whose prune failed; their expired rows are still on disk. */
  errors: number;
  /** Policies that pruned successfully but whose last_cleanup_at UPDATE failed. */
  bookkeepingErrors: number;
  durationMs: number;
}

/**
 * Per-run batch tuning. ABSENT (null/undefined) fields fall back to the
 * env-configured defaults; a supplied value must be a positive safe integer or
 * it is rejected with a warning and the default is used (see `resolveLimit`).
 * Note this is a compile-time shape only — BullMQ delivers it as untrusted JSON.
 */
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
 * `buildStatement` is a thunk so each call site can close over its own
 * parameters. A drizzle `sql` object is in fact re-executable — `execute` only
 * reads `queryChunks` — so this is a convenience, not a correctness requirement.
 */
async function runBatchedDelete(
  exec: SqlExecutor,
  limits: BatchLimits,
  label: string,
  buildStatement: () => ReturnType<typeof sql>,
): Promise<BatchedDeleteResult> {
  let rowsDeleted = 0;
  let batches = 0;
  let lastBatchDeleted = 0;

  while (batches < limits.maxBatches) {
    const result = await exec.execute(buildStatement());
    // `extractRowCount` is loud only for null/undefined: for any OTHER
    // unrecognised shape it returns 0 (pinned by db/rowCount.test.ts, and
    // relied on there for SELECTs). A 0 here does not merely under-report — it
    // ENDS the loop and the org is recorded as fully pruned, so a driver,
    // pooler or adapter change that alters the result shape would silently
    // retain expired audit rows while reporting success. A DELETE always
    // carries a driver row count, so demand one rather than inferring "nothing
    // left to delete" from an unreadable result. Same principle as the cutoff
    // guard below and as db/rowCount.ts's deliberate non-null-safety.
    const raw = result as { rowCount?: unknown; count?: unknown };
    if (typeof raw.rowCount !== 'number' && typeof raw.count !== 'number') {
      throw new Error(
        `[AuditRetention] ${label} DELETE returned no driver row count (batch ${batches + 1}) — ` +
          'refusing to read an unreadable count as "nothing left to delete"',
      );
    }
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
  // permanent linkage hole. Instead delete a chain PREFIX that is entirely
  // older than the cutoff — everything below the first "young" row in chain
  // order — either the maximal such prefix or as much of it as the per-run
  // batch ceiling allows (see MAX_BATCHES).
  //
  // Old stragglers sitting behind a young row survive until that BLOCKER itself
  // ages past the cutoff, which can be up to a full `retention_days` later —
  // not "one extra cycle", and on a busy org the blocker is continuously
  // replaced. Worth stating plainly: this job is compliance-facing and those
  // rows are expired-but-retained the whole time.
  //
  // No re-anchor follows: audit_log_verify_chain treats the first surviving
  // entry's prev_chain_checksum as the trusted anchor (it references the
  // legitimately pruned prefix), so retention never UPDATEs the chain — or
  // audit_logs — at all. The FK ON DELETE CASCADE removes the pruned rows'
  // chain entries; their BEFORE DELETE trigger passes because both call paths
  // set breeze.allow_audit_retention='1' SET LOCAL before calling this.

  // Step 1 — the prefix bound, hoisted out of the DELETE and rewritten as an
  // ordered early-stop (issue #4239). The old form was `MIN(c2.chain_seq)` over
  // the same filtered join. MIN has to consume the WHOLE join before it can
  // answer, and because the arm never constrains `a2.org_id`,
  // `audit_logs_org_timestamp_idx (org_id, timestamp DESC)` cannot apply.
  //
  // REPORTED (issue #4239, external operator on a self-hosted single-node PG16
  // with ~14 policies — NOT reproduced on our infrastructure, we have no
  // dataset at that scale): at ~17.8M rows the planner chose a Seq Scan of
  // audit_logs hash joined to a Seq Scan of audit_log_chain — ~200s and
  // ~1.94M shared-buffer block reads (~14.8 GiB, some possibly OS-cache hits)
  // for ONE org's cutoff, repeated per policy.
  //
  // `ORDER BY c2.chain_seq LIMIT 1` returns the identical value (the smallest
  // chain_seq in the same filtered set, or NULL) — a pure plan change, not a
  // semantic one, and it does not depend on timestamps being monotonic in chain
  // order. The LIMIT is what makes an ordered index path cheap to the planner,
  // so it can walk audit_log_chain in ascending chain_seq order, PK-probe
  // audit_logs per candidate, and stop at the FIRST young row.
  //
  // CAVEAT — not verified at production scale. Locally at 270k rows the planner
  // took audit_log_chain_pkey with an org_id filter (an early stop, but in
  // GLOBAL chain order, so the walk covers other orgs' interleaved rows too).
  // #4239 reports that at ~17.8M rows the planner rejects
  // audit_log_chain_org_seq_idx for this join because it is not covering
  // (audit_id is absent) — that was measured on the MIN/hash-join shape, which
  // has no LIMIT to make an index path attractive, so it does not transfer
  // directly. Still, an early stop is not guaranteed: a Sort over a Seq Scan
  // would satisfy the ORDER BY while consuming everything. If #4239 recurs, the
  // reporter's direction 2 (denormalised `logged_at` plus
  // `(org_id, chain_seq) INCLUDE (logged_at, audit_id)`) is the follow-up. The
  // batching in step 2 bounds the DELETE either way.
  //
  // WHY HOISTING THE CUTOFF IS SAFE (load-bearing dependency — read before
  // changing either side). The bound is computed once, then reused by DELETEs in
  // LATER statements, each of which takes a fresh READ COMMITTED snapshot. That
  // is only sound because `audit_log_seal_one`
  // (migrations/2026-06-11-h-audit-chain-seal-and-verify.sql:45) takes
  // `pg_advisory_xact_lock(1000200, hashtext(org_id))` BEFORE allocating
  // chain_seq, from a DEFERRED constraint trigger, so the lock is held from
  // allocation through commit. Per org that makes chain_seq allocation order
  // identical to commit-visibility order: a row committing between our cutoff
  // read and a later batch necessarily has chain_seq above everything we could
  // see, so it can never fall inside `chain_seq < cutoffSeq` and be swept into
  // the prefix. If that advisory lock is ever relaxed, this hoist becomes unsafe
  // and the bound must move back inside each DELETE.
  //
  // (`now()` is transaction_timestamp(), and every batch runs in the one per-org
  // transaction, so the time reference is stable across batches too.)
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
  `)) as unknown as Array<{ cutoff_seq?: string | null }> | undefined;
  const cutoffRow = cutoffRows?.[0];
  if (!cutoffRow || cutoffRow.cutoff_seq === undefined) {
    // `SELECT COALESCE(...)` has no FROM, so Postgres ALWAYS returns exactly one
    // row carrying this column. Getting nothing back means the driver, the
    // executor adapter or a test double is broken — it does NOT mean the org has
    // nothing to prune. Collapsing the two (`rows[0]?.x ?? null`) would silently
    // skip the prefix DELETE and retain expired audit rows past policy, which in
    // this job is a compliance failure that reports itself as success. Fail loudly
    // instead; the per-policy catch records it and the pass continues. Same
    // principle as the deliberate non-null-safety in db/rowCount.ts.
    throw new Error(
      `[AuditRetention] cutoff query returned no row for org=${policy.org_id} — expected exactly one`,
    );
  }
  // NULL (not absent) only when the org has no chain entries at all — nothing to
  // prefix-cut, but the unsealed sweep below still runs.
  const cutoffSeq = cutoffRow.cutoff_seq;

  // Step 2 — delete that prefix in bounded batches instead of one unbounded
  // statement (issue #4239). `ORDER BY c.chain_seq` is load-bearing, not
  // cosmetic: each batch must take the LOWEST remaining chain_seq values so
  // that whatever has been deleted is always a contiguous prefix. Without it
  // `LIMIT` would pick an arbitrary subset, and stopping at `maxBatches` would
  // leave holes in the middle of the chain — exactly the permanent linkage
  // break the prefix-cut design exists to prevent.
  const prefix = cutoffSeq === null
    ? { rowsDeleted: 0, batches: 0, hasMore: false }
    : await runBatchedDelete(exec, limits, 'prefix-cut', () => sql`
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
  // for the same reason as the prefix cut: same table, and an org that somehow
  // accumulated a large unsealed backlog must not monopolise the pass.
  // The outer DELETE repeats `org_id` rather than leaning on ctid alone. ctid is
  // unique per TABLE today, but only per PARTITION — if audit_logs is ever
  // range-partitioned (a live option at this size) a bare ctid predicate becomes
  // a cross-tenant delete, and this statement runs in system scope
  // (accessible_org_ids = '*') where RLS would not catch it. Costs nothing.
  const sweep = await runBatchedDelete(exec, limits, 'unsealed-sweep', () => sql`
    DELETE FROM audit_logs
    WHERE org_id = ${policy.org_id}
      AND ctid IN (
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
    batchSize: resolveLimit('batchSize', options.batchSize, BATCH_SIZE),
    maxBatches: resolveLimit('maxBatches', options.maxBatches, MAX_BATCHES),
  };
  const stats: RetentionStats = {
    policies: 0,
    orgsPruned: 0,
    rowsDeleted: 0,
    unsealedRowsDeleted: 0,
    batches: 0,
    orgsWithBacklog: 0,
    backloggedOrgIds: [],
    errors: 0,
    bookkeepingErrors: 0,
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
    let pruned: PrunePolicyResult;
    try {
      pruned = await pruneOrg(policy, limits);
    } catch (err) {
      // The prune itself failed. Both paths are transactional, so nothing was
      // deleted — this org contributes no rows and is NOT counted as pruned.
      stats.errors += 1;
      captureException(err, undefined, {
        job: 'audit-retention',
        stage: 'prune',
        orgId: policy.org_id,
        policyId: policy.id,
      });
      console.error(
        `[AuditRetention] prune failed for org=${policy.org_id} policy=${policy.id} — expired rows retained:`,
        err instanceof Error ? err.message : err,
      );
      continue;
    }

    stats.rowsDeleted += pruned.rowsDeleted;
    stats.unsealedRowsDeleted += pruned.unsealedRowsDeleted;
    stats.batches += pruned.batches;
    if (pruned.hasMore) {
      stats.orgsWithBacklog += 1;
      stats.backloggedOrgIds.push(policy.org_id);
    }
    stats.orgsPruned += 1;

    // Bookkeeping runs in its OWN try: the prune already committed, so a failure
    // here must not be reported as "cleanup failed" (it isn't — rows really were
    // deleted) nor counted against `errors`, which would make this org both
    // pruned and errored and break `orgsPruned + errors === policies`.
    //
    // Its own transaction too (the DELETE tx already committed). breeze_app
    // retains UPDATE on audit_retention_policies via the blanket grant — no role
    // switch needed here.
    try {
      await runWithSystemDbAccess(async () => {
        await dbModule.db.execute(sql`
          UPDATE audit_retention_policies
          SET last_cleanup_at = now(), updated_at = now()
          WHERE id = ${policy.id}
        `);
      });
    } catch (err) {
      stats.bookkeepingErrors += 1;
      captureException(err, undefined, {
        job: 'audit-retention',
        stage: 'bookkeeping',
        orgId: policy.org_id,
        policyId: policy.id,
      });
      console.error(
        `[AuditRetention] prune SUCCEEDED for org=${policy.org_id} policy=${policy.id} but the last_cleanup_at bookkeeping UPDATE failed (rows WERE deleted):`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  stats.durationMs = Date.now() - startedAt;
  console.log(
    `[AuditRetention] Pruned ${stats.rowsDeleted} row(s) (+${stats.unsealedRowsDeleted} unsealed) across ${stats.orgsPruned}/${stats.policies} polic(ies) in ${stats.batches} batch(es) of ${limits.batchSize} in ${stats.durationMs}ms (errors=${stats.errors}, bookkeepingErrors=${stats.bookkeepingErrors}, backlogged=${stats.orgsWithBacklog})`,
  );

  if (stats.unsealedRowsDeleted > 0) {
    // Unsealed rows should not exist post-backfill: the seal trigger writes a
    // chain entry for every insert. A non-zero count here means rows are landing
    // in audit_logs without being sealed, which is an audit-integrity defect in
    // its own right — louder than a number buried in the log line above.
    console.warn(
      `[AuditRetention] swept ${stats.unsealedRowsDeleted} UNSEALED audit row(s) — these should not exist post-backfill; the chain seal trigger may be dropping rows`,
    );
  }

  if (stats.errors > 0) {
    // A failed policy means that org's expired rows are still on disk. The job
    // itself still resolves (one bad tenant must not abort the pass), so this
    // line plus the tagged Sentry events above are the signal.
    console.error(
      `[AuditRetention] ${stats.errors}/${stats.policies} polic(ies) FAILED — expired audit rows retained for those orgs`,
    );
  }

  if (stats.orgsWithBacklog > 0) {
    // Not an error: the ceiling did its job. Named, and routed to Sentry, so a
    // backlog that never drains across nights is visible as a recurring signal
    // rather than one line of stdout. Note this counts only rows BELOW the
    // cutoff — expired stragglers sitting above the first young row are not
    // included, so this is a floor on what remains, never an all-clear.
    const message =
      `[AuditRetention] ${stats.orgsWithBacklog} org(s) stopped at the ${limits.maxBatches}-batch ceiling ` +
      `with more rows below the cutoff; the next run continues where this one stopped: ` +
      stats.backloggedOrgIds.join(', ');
    console.warn(message);
    captureException(new Error(message), undefined, {
      job: 'audit-retention',
      reason: 'backlog_ceiling',
    });
  }

  // `stats.errors` counts policies whose DELETE threw and were skipped, so their
  // rows are still past the cutoff; `stats.orgsWithBacklog` counts policies that
  // hit the batch ceiling with more rows below the cutoff. Either means rows
  // remain — without this the degenerate run (every policy failed, rowsDeleted
  // 0, fresh last-run stamp) looks perfectly healthy on the dashboard, and only
  // Sentry knows otherwise.
  recordRetentionRun('audit_retention', {
    rowsDeleted: stats.rowsDeleted,
    incomplete: stats.errors > 0 || stats.orgsWithBacklog > 0,
  });
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
  DEFAULT_BATCH_SIZE: 5000,
  DEFAULT_MAX_BATCHES: 200,
  isRetentionEnabled,
  parsePositiveIntEnv,
  resolveLimit,
};
