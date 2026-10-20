/**
 * PAM Evidence Retention Worker — PAM ownership epochs W5 (#8207), spec §7.2.
 *
 * When an org is merged away while it still owns PAM evidence-chain rows, the
 * loser is kept as a "held shell" (a row in `org_evidence_holds`). The hold is
 * released only when the shell's chain is empty (`releaseEmptyEvidenceHolds`,
 * driven by the offboarding sweeper). Nothing else deletes those rows by age,
 * so without this job a hold never releases. This is "the existing PAM
 * retention path, breeze_audit_admin plus breeze.allow_audit_retention" the
 * spec names.
 *
 * SCOPE: HELD SHELLS ONLY. The job considers exactly the orgs named by
 * `org_evidence_holds.loser_org_id` and never deletes chain rows of any other
 * org. Retention of LIVE orgs' PAM evidence is a separate product decision and
 * is deliberately NOT implemented here.
 *
 * TTL: `PAM_EVIDENCE_RETENTION_DAYS`, default 400 (a little over a year of
 * evidence). The spec names no TTL; 400 is a DEFAULT TO BE CONFIRMED BY THE
 * OWNER, not a ruling. Values below 30 days are clamped to 30 and an invalid
 * value falls back to the default; both are reported to Sentry once per process.
 *
 * UNIT OF DELETION: one elevation-request chain — an `elevation_requests` row,
 * its `elevation_audit` rows, its `pam_actuations` and those actuations'
 * `pam_actuation_results`. A chain expires only when the later of its NEWEST
 * activity (request created/updated, newest audit row, newest actuation
 * created/updated, newest result received/observed) and the shell's
 * `org_evidence_holds.created_at` (the merge) is older than the TTL, so a chain
 * that is still being written to is never half-deleted and merging an org with
 * already-old evidence does not delete it on the next run. Each shell's delete
 * transaction re-checks the hold still exists and skips the shell if not. Deletion is FK-safe:
 * results -> actuations -> audit -> requests, all scoped to the shell's
 * `org_id` and the expired request ids. `pam_actuations.elevation_request_id`
 * is NOT NULL and results hang off actuations, so every chain row belongs to
 * a request chain; there is no orphan shape to sweep. `intent_outbox` rows
 * cascade from pam_actuations via FK (referential actions run as the table
 * owner, so breeze_audit_admin needs no grant on it).
 *
 * PRIVILEGE: identical to auditRetention. With AUDIT_ADMIN_DATABASE_URL set the
 * DELETEs run on the dedicated breeze_audit_admin pool (system-scope GUCs set
 * by hand: that pool is outside the AsyncLocalStorage db context). Otherwise
 * the legacy path does `SET LOCAL ROLE breeze_audit_admin` on the app pool
 * inside withSystemDbAccessContext. Both set
 * `SET LOCAL breeze.allow_audit_retention = '1'`, which the append-only
 * trigger on pam_actuation_results requires. Grants:
 * migrations/2026-12-30-210000-pam-epoch-transfer-flag.sql section 4.
 *
 * Per-shell transaction isolation: one shell's failure does not abort the pass,
 * but the job always records the run and then throws a summary error when any
 * shell failed, so the BullMQ job shows as failed.
 *
 * Schedule: daily (see `pam-evidence-retention` in scheduleRegistry).
 * Kill switch: `PAM_EVIDENCE_RETENTION_ENABLED=false` skips schedule
 * registration without disabling the worker (manual `add()` still drains).
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
import { captureException, captureMessage } from '../services/sentry';
import { getBullMQConnection } from '../services/redis';
import { recordRetentionRun } from '../services/retentionMetrics';
import { jobSchedule } from './scheduleRegistry';
import { attachWorkerObservability } from './workerObservability';

const QUEUE_NAME = 'pam-evidence-retention';
const JOB_NAME = 'pam-evidence-retention';
const REPEAT_JOB_ID = 'pam-evidence-retention';
const DAILY_CRON = jobSchedule('pam-evidence-retention');

const DEFAULT_RETENTION_DAYS = 400;
/** A typo ("3", "1") must never wipe evidence: shorter TTLs are clamped to this. */
const MIN_RETENTION_DAYS = 30;
const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_MAX_BATCHES = 100;

function parsePositiveIntEnv(name: string, defaultValue: number, onInvalid?: () => void): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return defaultValue;
  const trimmed = raw.trim();
  // Whole-string validation: parseInt("1e9") would silently become 1.
  if (!/^\d+$/.test(trimmed)) {
    console.warn(`[PamEvidenceRetention] Invalid ${name}="${raw}" (not a plain integer), using default ${defaultValue}`);
    onInvalid?.();
    return defaultValue;
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    console.warn(`[PamEvidenceRetention] Invalid ${name}="${raw}", using default ${defaultValue}`);
    onInvalid?.();
    return defaultValue;
  }
  return parsed;
}

// Config problems are reported to Sentry once per process: the job runs daily
// and a misconfigured env var would otherwise page on every run.
const reported = { invalid: false, floor: false };

function resetConfigReports(): void {
  reported.invalid = false;
  reported.floor = false;
}

function resolveRetentionDays(override: number | undefined): number {
  const requested = resolveLimit(
    'retentionDays',
    override,
    parsePositiveIntEnv('PAM_EVIDENCE_RETENTION_DAYS', DEFAULT_RETENTION_DAYS, () => {
      if (reported.invalid) return;
      reported.invalid = true;
      captureMessage(
        `[PamEvidenceRetention] PAM_EVIDENCE_RETENTION_DAYS is not a positive integer; using the ${DEFAULT_RETENTION_DAYS}-day default`,
        { eventCode: 'pam_evidence_retention_config', level: 'warning' },
      );
    }),
  );
  if (requested >= MIN_RETENTION_DAYS) return requested;
  console.warn(
    `[PamEvidenceRetention] retention ${requested}d is below the ${MIN_RETENTION_DAYS}-day floor; clamping to ${MIN_RETENTION_DAYS}`,
  );
  if (!reported.floor) {
    reported.floor = true;
    captureMessage(
      `[PamEvidenceRetention] retention TTL ${requested}d is below the ${MIN_RETENTION_DAYS}-day floor; clamped to ${MIN_RETENTION_DAYS}`,
      { eventCode: 'pam_evidence_retention_config', level: 'warning' },
    );
  }
  return MIN_RETENTION_DAYS;
}

function isRetentionEnabled(): boolean {
  const raw = process.env.PAM_EVIDENCE_RETENTION_ENABLED;
  if (raw === undefined || raw === '') return true; // default ON
  const v = raw.trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'no' || v === 'off');
}

const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  if (typeof dbModule.withSystemDbAccessContext !== 'function') {
    throw new Error(
      '[PamEvidenceRetention] withSystemDbAccessContext is not available — DB module may not have loaded correctly',
    );
  }
  return dbModule.withSystemDbAccessContext(fn);
};

export interface PamEvidenceRetentionOptions {
  /** Override the TTL (days) for this run; defaults to PAM_EVIDENCE_RETENTION_DAYS. */
  retentionDays?: number;
  /** Request chains deleted per transaction batch. */
  batchSize?: number;
  /** Per-shell ceiling on batches. */
  maxBatches?: number;
}

export interface PamEvidenceRetentionStats {
  shells: number;
  shellsPruned: number;
  chainsDeleted: number;
  resultsDeleted: number;
  actuationsDeleted: number;
  auditRowsDeleted: number;
  requestsDeleted: number;
  /** Shells that stopped at the batch ceiling with more expired chains. */
  shellsWithBacklog: number;
  /** Shells whose prune failed; their expired chains are still on disk. */
  errors: number;
  durationMs: number;
}

interface SqlExecutor {
  execute: (query: ReturnType<typeof sql>) => Promise<unknown>;
}

interface ShellPruneResult {
  chains: number;
  results: number;
  actuations: number;
  audit: number;
  requests: number;
  hasMore: boolean;
}

function resolveLimit(name: string, value: number | undefined, defaultValue: number): number {
  if (value === undefined || value === null) return defaultValue;
  if (!Number.isSafeInteger(value) || value <= 0) {
    console.warn(`[PamEvidenceRetention] Ignoring invalid ${name}=${JSON.stringify(value)}; using ${defaultValue}`);
    return defaultValue;
  }
  return value;
}

function requireCount(result: unknown, label: string): number {
  const raw = result as { rowCount?: unknown; count?: unknown } | null | undefined;
  if (!raw || (typeof raw.rowCount !== 'number' && typeof raw.count !== 'number')) {
    throw new Error(`[PamEvidenceRetention] ${label} DELETE returned no driver row count`);
  }
  return extractRowCount(result);
}

/**
 * Delete one shell's expired request chains, in bounded batches. Assumes the
 * caller armed system scope + `breeze.allow_audit_retention` on the same
 * transaction/connection.
 */
async function deleteExpiredChains(
  exec: SqlExecutor,
  shellOrgId: string,
  retentionDays: number,
  batchSize: number,
  maxBatches: number,
): Promise<ShellPruneResult> {
  const out: ShellPruneResult = { chains: 0, results: 0, actuations: 0, audit: 0, requests: 0, hasMore: false };

  // Re-check inside the delete transaction that the shell is still held: the
  // shell list was read earlier, and a hold released since then means the org
  // is no longer a retention target.
  const heldRows = (await exec.execute(sql`
    SELECT EXISTS (SELECT 1 FROM org_evidence_holds WHERE loser_org_id = ${shellOrgId}::uuid) AS held
  `)) as unknown as Array<{ held: boolean }> | undefined;
  if (!Array.isArray(heldRows)) {
    throw new Error(`[PamEvidenceRetention] hold re-check returned no result for org=${shellOrgId}`);
  }
  if (heldRows[0]?.held !== true) return out;

  for (let batch = 0; batch < maxBatches; batch++) {
    // A chain expires when the later of (its newest activity across all four
    // tables) and (the hold's creation, i.e. the merge) is past the TTL, so
    // merging an org whose evidence is already old does not delete it at once.
    const idRows = (await exec.execute(sql`
      SELECT r.id::text AS id
        FROM elevation_requests r
        JOIN org_evidence_holds h ON h.loser_org_id = r.org_id
       WHERE r.org_id = ${shellOrgId}::uuid
         AND GREATEST(
               h.created_at,
               r.created_at,
               r.updated_at,
               COALESCE((SELECT max(e.created_at) FROM elevation_audit e
                          WHERE e.org_id = r.org_id AND e.elevation_request_id = r.id), '-infinity'::timestamptz),
               COALESCE((SELECT max(GREATEST(a.created_at, a.updated_at)) FROM pam_actuations a
                          WHERE a.org_id = r.org_id AND a.elevation_request_id = r.id), '-infinity'::timestamptz),
               COALESCE((SELECT max(GREATEST(x.received_at, x.observed_at))
                           FROM pam_actuation_results x
                           JOIN pam_actuations a2 ON a2.id = x.actuation_id AND a2.org_id = x.org_id
                          WHERE a2.org_id = r.org_id AND a2.elevation_request_id = r.id), '-infinity'::timestamptz)
             ) < (now() - (${retentionDays}::int * interval '1 day'))
       ORDER BY r.created_at, r.id
       LIMIT ${batchSize}
    `)) as unknown as Array<{ id: string }> | undefined;
    if (!Array.isArray(idRows)) {
      throw new Error(`[PamEvidenceRetention] expired-chain query returned no result for org=${shellOrgId}`);
    }
    if (idRows.length === 0) return out;

    const ids = sql.join(idRows.map((r) => sql`${r.id}::uuid`), sql`, `);

    out.results += requireCount(await exec.execute(sql`
      DELETE FROM pam_actuation_results
       WHERE org_id = ${shellOrgId}::uuid
         AND actuation_id IN (
           SELECT a.id FROM pam_actuations a
            WHERE a.org_id = ${shellOrgId}::uuid AND a.elevation_request_id IN (${ids}))
    `), 'pam_actuation_results');
    out.actuations += requireCount(await exec.execute(sql`
      DELETE FROM pam_actuations
       WHERE org_id = ${shellOrgId}::uuid AND elevation_request_id IN (${ids})
    `), 'pam_actuations');
    out.audit += requireCount(await exec.execute(sql`
      DELETE FROM elevation_audit
       WHERE org_id = ${shellOrgId}::uuid AND elevation_request_id IN (${ids})
    `), 'elevation_audit');
    out.requests += requireCount(await exec.execute(sql`
      DELETE FROM elevation_requests
       WHERE org_id = ${shellOrgId}::uuid AND id IN (${ids})
    `), 'elevation_requests');
    out.chains += idRows.length;

    if (idRows.length < batchSize) return out;
  }
  // Ceiling reached after a full final batch: more expired chains may remain.
  out.hasMore = true;
  return out;
}

/**
 * Prune one held shell. SECURE path: transaction on the dedicated
 * breeze_audit_admin pool. LEGACY path: SET LOCAL ROLE on the app pool.
 */
async function pruneShell(
  shellOrgId: string,
  retentionDays: number,
  batchSize: number,
  maxBatches: number,
): Promise<ShellPruneResult> {
  if (hasDedicatedAuditAdminPool()) {
    const adminDb = getAuditAdminDb();
    return adminDb.transaction(async (tx) => {
      // The dedicated pool is outside the AsyncLocalStorage db context, so
      // establish system scope by hand (same GUCs withSystemDbAccessContext sets).
      await tx.execute(sql`select set_config('breeze.scope', 'system', true)`);
      await tx.execute(sql`select set_config('breeze.org_id', '', true)`);
      await tx.execute(sql`select set_config('breeze.accessible_org_ids', '*', true)`);
      await tx.execute(sql`select set_config('breeze.accessible_partner_ids', '*', true)`);
      await tx.execute(sql`select set_config('breeze.user_id', '', true)`);
      await tx.execute(sql`SET LOCAL breeze.allow_audit_retention = '1'`);
      return deleteExpiredChains(tx as unknown as SqlExecutor, shellOrgId, retentionDays, batchSize, maxBatches);
    });
  }

  return runWithSystemDbAccess(async () => {
    await dbModule.db.execute(sql`SET LOCAL ROLE breeze_audit_admin`);
    await dbModule.db.execute(sql`SET LOCAL breeze.allow_audit_retention = '1'`);
    return deleteExpiredChains(dbModule.db as unknown as SqlExecutor, shellOrgId, retentionDays, batchSize, maxBatches);
  });
}

/**
 * Walk every held shell and delete its expired PAM request chains. Exported for
 * tests and manual incident response.
 */
export async function prunePamEvidence(
  options: PamEvidenceRetentionOptions = {},
): Promise<PamEvidenceRetentionStats> {
  const startedAt = Date.now();
  const retentionDays = resolveRetentionDays(options.retentionDays);
  const batchSize = resolveLimit('batchSize', options.batchSize, DEFAULT_BATCH_SIZE);
  const maxBatches = resolveLimit('maxBatches', options.maxBatches, DEFAULT_MAX_BATCHES);

  const stats: PamEvidenceRetentionStats = {
    shells: 0,
    shellsPruned: 0,
    chainsDeleted: 0,
    resultsDeleted: 0,
    actuationsDeleted: 0,
    auditRowsDeleted: 0,
    requestsDeleted: 0,
    shellsWithBacklog: 0,
    errors: 0,
    durationMs: 0,
  };

  // Every exit path records the run: a run that threw or left work behind must
  // not look like a clean one to the retention metrics.
  let incomplete = true;
  let rowsDeleted = 0;
  try {
    // Held shells only. Read under its own system context, separate from the
    // per-shell DELETE transactions.
    const shells = await runWithSystemDbAccess(async () =>
      (await dbModule.db.execute(sql`
        SELECT loser_org_id::text AS loser_org_id FROM org_evidence_holds ORDER BY created_at, loser_org_id
      `)) as unknown as Array<{ loser_org_id: string }>);
    stats.shells = shells.length;

    for (const shell of shells) {
      let pruned: ShellPruneResult;
      try {
        pruned = await pruneShell(shell.loser_org_id, retentionDays, batchSize, maxBatches);
      } catch (err) {
        // Transactional: nothing from this shell was deleted. Continue the pass.
        stats.errors += 1;
        captureException(err, undefined, {
          job: 'pam-evidence-retention',
          stage: 'prune',
          orgId: shell.loser_org_id,
        });
        console.error(
          `[PamEvidenceRetention] prune failed for shell=${shell.loser_org_id} — expired evidence retained:`,
          err instanceof Error ? err.message : err,
        );
        continue;
      }
      stats.shellsPruned += 1;
      stats.chainsDeleted += pruned.chains;
      stats.resultsDeleted += pruned.results;
      stats.actuationsDeleted += pruned.actuations;
      stats.auditRowsDeleted += pruned.audit;
      stats.requestsDeleted += pruned.requests;
      if (pruned.hasMore) stats.shellsWithBacklog += 1;
    }

    stats.durationMs = Date.now() - startedAt;
    rowsDeleted = stats.resultsDeleted + stats.actuationsDeleted + stats.auditRowsDeleted + stats.requestsDeleted;
    incomplete = stats.errors > 0 || stats.shellsWithBacklog > 0;
    console.log(
      `[PamEvidenceRetention] Deleted ${stats.chainsDeleted} chain(s) (${rowsDeleted} row(s)) across ${stats.shellsPruned}/${stats.shells} held shell(s) in ${stats.durationMs}ms (errors=${stats.errors}, backlogged=${stats.shellsWithBacklog}, ttlDays=${retentionDays})`,
    );
    if (stats.shellsWithBacklog > 0) {
      captureException(
        new Error(`[PamEvidenceRetention] ${stats.shellsWithBacklog} shell(s) stopped at the ${maxBatches}-batch ceiling; the next run continues`),
        undefined,
        { job: 'pam-evidence-retention', reason: 'backlog_ceiling' },
      );
    }
  } finally {
    recordRetentionRun('pam_evidence_retention', { rowsDeleted, incomplete });
  }

  if (stats.errors > 0) {
    // Other shells' deletes are already committed. Throw so the BullMQ job is
    // marked failed instead of reporting success with evidence left behind.
    throw new Error(
      `[PamEvidenceRetention] ${stats.errors} of ${stats.shells} held shell(s) failed to prune — expired PAM evidence retained for those shells`,
    );
  }
  return stats;
}

let retentionQueue: Queue | null = null;
let retentionWorker: Worker | null = null;

export function getPamEvidenceRetentionQueue(): Queue {
  if (!retentionQueue) {
    retentionQueue = new Queue(QUEUE_NAME, { connection: getBullMQConnection() });
  }
  return retentionQueue;
}

export function createPamEvidenceRetentionWorker(): Worker<PamEvidenceRetentionOptions> {
  return new Worker<PamEvidenceRetentionOptions>(
    QUEUE_NAME,
    async (job: Job<PamEvidenceRetentionOptions>) => {
      if (job.name !== JOB_NAME) {
        console.warn(`[PamEvidenceRetention] Ignoring unknown job name: ${job.name}`);
        return { skipped: true, rowsDeleted: 0 };
      }
      return prunePamEvidence({
        batchSize: job.data?.batchSize,
        maxBatches: job.data?.maxBatches,
      });
    },
    { connection: getBullMQConnection(), concurrency: 1 },
  );
}

export async function schedulePamEvidenceRetention(
  queue: Queue = getPamEvidenceRetentionQueue(),
): Promise<void> {
  // Clear any prior repeatable so a cron change takes effect on redeploy.
  const existingJobs = await queue.getRepeatableJobs();
  for (const job of existingJobs) {
    if (job.name === JOB_NAME) {
      await queue.removeRepeatableByKey(job.key);
    }
  }

  if (!isRetentionEnabled()) {
    console.log('[PamEvidenceRetention] PAM_EVIDENCE_RETENTION_ENABLED=false — skipping schedule registration');
    return;
  }

  await queue.add(
    JOB_NAME,
    {},
    {
      // Stable jobId: multi-replica dedup of the scheduled insert.
      jobId: REPEAT_JOB_ID,
      repeat: { pattern: DAILY_CRON },
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 25 },
    },
  );
  console.log(`[PamEvidenceRetention] Scheduled daily retention (cron "${DAILY_CRON}", jobId=${REPEAT_JOB_ID})`);
}

export async function initializePamEvidenceRetentionWorker(): Promise<void> {
  try {
    logAuditAdminPoolMode();

    retentionWorker = createPamEvidenceRetentionWorker();
    attachWorkerObservability(retentionWorker, 'pamEvidenceRetention');

    retentionWorker.on('error', (error) => {
      console.error('[PamEvidenceRetention] Worker error:', error);
      captureException(error);
    });
    retentionWorker.on('failed', (job, error) => {
      console.error(`[PamEvidenceRetention] Job ${job?.id} failed:`, error);
      captureException(error);
    });

    await schedulePamEvidenceRetention();
    console.log('[PamEvidenceRetention] Worker initialized');
  } catch (error) {
    console.error('[PamEvidenceRetention] Failed to initialize:', error);
    throw error;
  }
}

export async function shutdownPamEvidenceRetentionWorker(): Promise<void> {
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
  JOB_NAME,
  REPEAT_JOB_ID,
  DAILY_CRON,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_BATCH_SIZE,
  DEFAULT_MAX_BATCHES,
  isRetentionEnabled,
  parsePositiveIntEnv,
  resolveLimit,
  MIN_RETENTION_DAYS,
  resetConfigReports,
  resolveRetentionDays,
};
