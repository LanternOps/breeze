/**
 * AI transcript retention (#4342 W4; spec §3.3–3.4). Technician and client
 * sessions, one nightly job. REPORT-ONLY until AI_TRANSCRIPT_RETENTION_ENFORCE
 * is true (code default false: the spec's "preview release").
 *
 * Phases, per org, in order (predicates: services/aiTranscriptRetentionPredicates.ts):
 *
 *  1. STUB technician sessions past the org's effective
 *     `ai_data_policies.transcript_retention_days` (partner ceiling, org
 *     tighten-only, code default 365; `mergeAiDataPolicies`). NULL = skip.
 *  2. STUB client (AI for Office) sessions past
 *     `client_ai_org_policies.retention_days`. NULL or no row = skip; no
 *     partner fallback (the client policy is org-only).
 *  3. HARD-DELETE stubs whose `last_activity_at` is past the org's
 *     `audit_retention_policies.retention_days`. An org with NO audit policy
 *     row is SKIPPED (decision B, pending operator confirmation): the audit
 *     prune (`auditRetention.ts`) only walks policy rows, so such an org keeps
 *     its `audit_logs` forever, and the stub — the strict copy of the approval
 *     trail — is kept as long. `get_audit_retention`'s 365 for a missing row is
 *     display-only ("configured: false") and is never used as a window here.
 *     Skipped orgs are counted (`orgsWithoutAuditPolicy`).
 *
 * A stub keeps the session's accounting and review metadata (type, principal,
 * model, timestamps, turn/token/cost totals, `flagged_at`/`flagged_by`,
 * `options`) and its `ai_tool_executions` rows with input/output tombstoned and
 * `error_message` cleared (OD 1). Its content
 * goes: `ai_messages`, `ai_action_plans`, the content columns on the row
 * (`title`, `system_prompt`, `context_snapshot`, `workbook_name`,
 * `flag_reason`), the SDK session id (the transcript file is deleted after
 * commit, best effort, as `aiToolOutputRetention` does), and its screenshots
 * are EXPIRED so `helperScreenshotRetention` removes file then row (plan
 * correction 8). Flagged sessions are held while flagged (OD 2). An `active`
 * session idle a day past its window is stubbed and set to `expired` (plan
 * correction 6).
 *
 * REPORT MODE counts each phase per org with the same predicate builder the
 * enforce batch uses, through `countEligibleRows` (bounded at
 * batchSize × maxBatches per org and phase). Phase 3 counts and deletes only
 * stubs made on an earlier run (`STUB_MIN_AGE_MS`), so the report's stub-delete
 * count is what enforce deletes: the first enforcing run only stubs, and its
 * stubs are deleted (when past the audit window) from the next run on.
 *
 * Each batch is one fresh system transaction (retentionBatch.ts); never wrap
 * this job in a DB context. Per-org failures are logged and counted and do
 * not stop other orgs; one bounded Sentry event per run carries counts only
 * (org ids go to stdout, never to Sentry tags).
 */
import { Queue, Worker, type Job } from 'bullmq';
import { sql, type SQL } from 'drizzle-orm';

import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { extractRowCount } from '../db/rowCount';
import {
  aiDataPolicies,
  auditRetentionPolicies,
  clientAiOrgPolicies,
  organizations,
  type AiDataPolicyRow,
} from '../db/schema';
import { mergeAiDataPolicies } from '../services/aiDataPolicy';
import {
  AI_TRANSCRIPT_RETENTION_ENFORCE,
  stubDeletePredicate,
  stubPredicateFor,
  transcriptCutoffIso,
  type TranscriptSessionKind,
} from '../services/aiTranscriptRetentionPredicates';
import { getBullMQConnection } from '../services/redis';
import { recordRetentionRun } from '../services/retentionMetrics';
import { captureMessage } from '../services/sentry';
import { deleteSdkTranscript, tombstone, type TranscriptDeleter } from './aiToolOutputRetention';
import { countEligibleRows, parsePositiveIntEnv, utcWallTime, warnOnRetentionBacklog } from './retentionBatch';
import { jobSchedule } from './scheduleRegistry';
import { attachWorkerObservability } from './workerObservability';

const LOG = '[AiTranscriptRetention]';
const QUEUE_NAME = 'ai-transcript-retention';
const ENFORCE_VAR = 'AI_TRANSCRIPT_RETENTION_ENFORCE';

const BATCH_SIZE = parsePositiveIntEnv(LOG, 'AI_TRANSCRIPT_RETENTION_BATCH_SIZE', 200);
const MAX_BATCHES = parsePositiveIntEnv(LOG, 'AI_TRANSCRIPT_RETENTION_MAX_BATCHES', 50);

const inFreshSystemContext = <T>(label: string, fn: () => Promise<T>): Promise<T> =>
  runOutsideDbContext(() => withSystemDbAccessContext(fn, label));

export interface OrgTranscriptWindows {
  /** Effective technician window; null = keep forever. */
  technicianDays: number | null;
  /** `client_ai_org_policies.retention_days`; null (or no row) = keep forever. */
  clientDays: number | null;
  /** `audit_retention_policies.retention_days`; null = the org has NO policy row → phase 3 skipped. */
  auditDays: number | null;
}

/**
 * Every org's three windows from ONE system-context read of organizations,
 * ai_data_policies, client_ai_org_policies and audit_retention_policies.
 */
export async function loadTranscriptWindowsByOrg(): Promise<Map<string, OrgTranscriptWindows>> {
  const { orgRows, policyRows, clientRows, auditRows } = await inFreshSystemContext(
    'aiTranscriptRetention.policies',
    async () => ({
      orgRows: await db.select({ id: organizations.id, partnerId: organizations.partnerId }).from(organizations),
      policyRows: await db.select().from(aiDataPolicies),
      clientRows: await db
        .select({ orgId: clientAiOrgPolicies.orgId, retentionDays: clientAiOrgPolicies.retentionDays })
        .from(clientAiOrgPolicies),
      auditRows: await db
        .select({ orgId: auditRetentionPolicies.orgId, retentionDays: auditRetentionPolicies.retentionDays })
        .from(auditRetentionPolicies),
    }),
  );
  const partnerRows = new Map<string, AiDataPolicyRow>();
  const orgPolicyRows = new Map<string, AiDataPolicyRow>();
  for (const row of policyRows) {
    if (row.orgId) orgPolicyRows.set(row.orgId, row);
    else if (row.partnerId) partnerRows.set(row.partnerId, row);
  }
  const clientDays = new Map(clientRows.map((r) => [r.orgId, r.retentionDays ?? null] as const));
  const auditDays = new Map(auditRows.map((r) => [r.orgId, r.retentionDays] as const));

  const out = new Map<string, OrgTranscriptWindows>();
  for (const org of orgRows) {
    const partner = org.partnerId ? partnerRows.get(org.partnerId) ?? null : null;
    out.set(org.id, {
      technicianDays: mergeAiDataPolicies(partner, orgPolicyRows.get(org.id) ?? null).transcriptRetentionDays,
      clientDays: clientDays.get(org.id) ?? null,
      auditDays: auditDays.has(org.id) ? auditDays.get(org.id)! : null,
    });
  }
  return out;
}

function uuidArray(ids: readonly string[]): SQL {
  return sql`ARRAY[${sql.join(ids.map((id) => sql`${id}`), sql`, `)}]::uuid[]`;
}

/**
 * One stub batch, one transaction (plan W4 "Stub batch"): lock up to
 * `batchSize` eligible sessions, delete their messages and plans, expire their
 * screenshots, tombstone their tool executions, then null the session's
 * content columns and stamp `transcript_purged_at`. Returns the old SDK
 * session ids so the caller deletes the transcript files AFTER commit.
 */
export async function stubSessionsBatch(
  kind: TranscriptSessionKind,
  orgId: string,
  cutoffIso: string,
  now: Date,
  batchSize: number,
): Promise<{ stubbed: number; clearedSdkSessionIds: string[] }> {
  const where = stubPredicateFor(kind, orgId, cutoffIso, now);
  const nowIso = now.toISOString();
  const markerJson = JSON.stringify(tombstone(now));
  return inFreshSystemContext(`aiTranscriptRetention.stub.${kind}`, async () => {
    const picked = (await db.execute(sql`
      SELECT id, sdk_session_id
      FROM ai_sessions
      WHERE ${where}
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    `)) as unknown as Array<{ id: string; sdk_session_id: string | null }>;
    if (!Array.isArray(picked)) throw new Error(`${LOG} stub select returned no rows array`);
    if (picked.length === 0) return { stubbed: 0, clearedSdkSessionIds: [] };

    const ids = uuidArray(picked.map((r) => r.id));
    await db.execute(sql`DELETE FROM ai_messages WHERE session_id = ANY(${ids})`);
    await db.execute(sql`DELETE FROM ai_action_plans WHERE session_id = ANY(${ids})`);
    await db.execute(sql`
      UPDATE ai_screenshots
      SET expires_at = LEAST(expires_at, ${utcWallTime(nowIso)})
      WHERE session_id = ANY(${ids})
    `);
    // tool_input is NOT NULL, so it gets the tombstone, never NULL.
    await db.execute(sql`
      UPDATE ai_tool_executions
      SET tool_input = ${markerJson}::jsonb, tool_output = ${markerJson}::jsonb, error_message = NULL
      WHERE session_id = ANY(${ids})
    `);
    const updated = await db.execute(sql`
      UPDATE ai_sessions
      SET title = NULL,
          system_prompt = NULL,
          context_snapshot = NULL,
          workbook_name = NULL,
          flag_reason = NULL,
          sdk_session_id = NULL,
          transcript_purged_at = now(),
          status = CASE WHEN status = 'active' THEN 'expired'::ai_session_status ELSE status END,
          updated_at = (now() AT TIME ZONE 'UTC')
      WHERE id = ANY(${ids})
    `);
    const stubbed = extractRowCount(updated);
    if (stubbed !== picked.length) {
      // The rows are locked FOR UPDATE; a mismatch means something is badly
      // wrong. Throwing rolls the whole batch back.
      throw new Error(`${LOG} stubbed ${stubbed} of ${picked.length} locked sessions; rolled back`);
    }
    return {
      stubbed,
      clearedSdkSessionIds: picked.flatMap((r) => (r.sdk_session_id ? [r.sdk_session_id] : [])),
    };
  });
}

/** One stub hard-delete batch, one transaction. Cascades tool executions, messages, plans, screenshots, wisp links. */
export async function deleteStubsBatch(orgId: string, auditCutoffIso: string, now: Date, batchSize: number): Promise<number> {
  const where = stubDeletePredicate(orgId, auditCutoffIso, now);
  const result = await inFreshSystemContext('aiTranscriptRetention.stubDelete', () => db.execute(sql`
    DELETE FROM ai_sessions
    WHERE id IN (
      SELECT id FROM ai_sessions
      WHERE ${where}
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    )
  `));
  return extractRowCount(result);
}

export interface TranscriptRetentionSummary {
  mode: 'report' | 'enforce';
  orgsScanned: number;
  /** Orgs where at least one phase threw (see `phasesFailed`). */
  orgsFailed: number;
  /** Phases that threw; each phase of an org runs even when another failed. */
  phasesFailed: number;
  /** Orgs with an unusable window value (not a positive integer); that phase was skipped. */
  orgsInvalidWindow: number;
  /** Orgs with no `audit_retention_policies` row: phase 3 skipped (decision B). */
  orgsWithoutAuditPolicy: number;
  /** Report mode: rows eligible now. `capped` = some org/phase count hit its cap. */
  eligible: { technician: number; client: number; stubDelete: number; capped: boolean };
  stubbed: { technician: number; client: number };
  stubsDeleted: number;
  transcripts: { deleted: number; notFound: number; failed: number };
  incomplete: boolean;
  durationMs: number;
}

export interface TranscriptRetentionOps {
  loadWindows: typeof loadTranscriptWindowsByOrg;
  countEligible: typeof countEligibleRows;
  stubBatch: typeof stubSessionsBatch;
  deleteStubs: typeof deleteStubsBatch;
}

const DEFAULT_OPS: TranscriptRetentionOps = {
  loadWindows: loadTranscriptWindowsByOrg,
  countEligible: countEligibleRows,
  stubBatch: stubSessionsBatch,
  deleteStubs: deleteStubsBatch,
};

function usableDays(days: number | null): days is number {
  return days !== null && Number.isSafeInteger(days) && days >= 1;
}

export async function runAiTranscriptRetention(
  opts: { batchSize: number; maxBatches: number; enforce: boolean; now?: Date; deleteTranscript?: TranscriptDeleter },
  ops: TranscriptRetentionOps = DEFAULT_OPS,
): Promise<TranscriptRetentionSummary> {
  const startedAt = Date.now();
  const now = opts.now ?? new Date();
  const batchSize = Math.max(1, opts.batchSize);
  const maxBatches = Math.max(1, opts.maxBatches);
  const cap = batchSize * maxBatches;
  const deleteTranscript = opts.deleteTranscript ?? deleteSdkTranscript;
  const summary: TranscriptRetentionSummary = {
    mode: opts.enforce ? 'enforce' : 'report',
    orgsScanned: 0, orgsFailed: 0, phasesFailed: 0, orgsInvalidWindow: 0, orgsWithoutAuditPolicy: 0,
    eligible: { technician: 0, client: 0, stubDelete: 0, capped: false },
    stubbed: { technician: 0, client: 0 },
    stubsDeleted: 0,
    transcripts: { deleted: 0, notFound: 0, failed: 0 },
    incomplete: false,
    durationMs: 0,
  };

  const deleteCleared = async (ids: string[]) => {
    for (const id of ids) {
      // The id is already gone from the DB: a throwing deleter must not fail the org.
      const outcome = await deleteTranscript(id).catch((err: unknown) => {
        console.warn(`${LOG} Transcript deleter threw for ${id}:`, err);
        return 'failed' as const;
      });
      if (outcome === 'deleted') summary.transcripts.deleted += 1;
      else if (outcome === 'not_found') summary.transcripts.notFound += 1;
      else summary.transcripts.failed += 1;
    }
  };

  /**
   * Batches until a short batch or maxBatches. `onCommitted` books each
   * batch as soon as it returns (it has committed), so rows changed before a
   * later batch throws are still counted.
   */
  const drain = async (run: () => Promise<number>, onCommitted: (n: number) => void) => {
    let total = 0;
    let batches = 0;
    let last = 0;
    while (batches < maxBatches) {
      last = await run();
      onCommitted(last);
      total += last;
      batches += 1;
      if (last < batchSize) break;
    }
    return { deleted: total, batches, hasMore: batches >= maxBatches && last >= batchSize };
  };

  /** Runs one phase; a throw is logged with the phase and does not stop the org's other phases. */
  const phase = async (orgId: string, name: string, failed: { any: boolean }, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      console.error(`${LOG} Phase ${name} failed for org ${orgId}; its other phases still run:`, err);
      summary.phasesFailed += 1;
      failed.any = true;
    }
  };

  const windows = await ops.loadWindows();
  for (const [orgId, w] of windows) {
    summary.orgsScanned += 1;
    const orgCounts = { technician: 0, client: 0, stubDelete: 0 };
    const failed = { any: false };
    for (const kind of ['technician', 'client'] as const) {
      await phase(orgId, `${kind}_stub`, failed, async () => {
        const days = kind === 'technician' ? w.technicianDays : w.clientDays;
        if (days === null) return;
        if (!usableDays(days)) {
          console.error(`${LOG} Org ${orgId} has an unusable ${kind} transcript window of ${String(days)} days; skipping that phase`);
          summary.orgsInvalidWindow += 1;
          return;
        }
        const cutoffIso = transcriptCutoffIso(days, now);
        if (!opts.enforce) {
          const r = await ops.countEligible({
            table: 'ai_sessions',
            where: stubPredicateFor(kind, orgId, cutoffIso, now),
            cap,
            label: `aiTranscriptRetention.count.${kind}`,
          });
          orgCounts[kind] = r.eligible;
          summary.eligible[kind] += r.eligible;
          if (r.capped) summary.eligible.capped = true;
          return;
        }
        const result = await drain(async () => {
          const { stubbed, clearedSdkSessionIds } = await ops.stubBatch(kind, orgId, cutoffIso, now, batchSize);
          // After the batch committed: the ids are gone from the DB.
          if (clearedSdkSessionIds.length > 0) await deleteCleared(clearedSdkSessionIds);
          return stubbed;
        }, (n) => { summary.stubbed[kind] += n; });
        if (result.hasMore) {
          summary.incomplete = true;
          warnOnRetentionBacklog(LOG, `ai_sessions.${kind}_stub`, result, `org=${orgId}`);
        }
      });
    }

    await phase(orgId, 'stub_delete', failed, async () => {
      if (w.auditDays === null) {
        // Decision B: no audit policy row → audit_logs are kept forever → so is the stub.
        summary.orgsWithoutAuditPolicy += 1;
      } else if (!usableDays(w.auditDays)) {
        console.error(`${LOG} Org ${orgId} has an unusable audit window of ${String(w.auditDays)} days; skipping stub delete`);
        summary.orgsInvalidWindow += 1;
      } else {
        const auditCutoffIso = transcriptCutoffIso(w.auditDays, now);
        if (!opts.enforce) {
          const r = await ops.countEligible({
            table: 'ai_sessions',
            where: stubDeletePredicate(orgId, auditCutoffIso, now),
            cap,
            label: 'aiTranscriptRetention.count.stubDelete',
          });
          orgCounts.stubDelete = r.eligible;
          summary.eligible.stubDelete += r.eligible;
          if (r.capped) summary.eligible.capped = true;
        } else {
          const result = await drain(
            () => ops.deleteStubs(orgId, auditCutoffIso, now, batchSize),
            (n) => { summary.stubsDeleted += n; },
          );
          if (result.hasMore) {
            summary.incomplete = true;
            warnOnRetentionBacklog(LOG, 'ai_sessions.stub_delete', result, `org=${orgId}`);
          }
        }
      }
    });
    if (failed.any) summary.orgsFailed += 1;
    if (!opts.enforce && (orgCounts.technician || orgCounts.client || orgCounts.stubDelete)) {
      // stdout only: org ids never go to Sentry tags.
      console.log(
        `${LOG} REPORT-ONLY org=${orgId} technician=${orgCounts.technician} client=${orgCounts.client} ` +
        `stubDelete=${orgCounts.stubDelete}`,
      );
    }
  }

  if (summary.orgsFailed > 0 || summary.orgsInvalidWindow > 0 || summary.transcripts.failed > 0) {
    summary.incomplete = true;
    try {
      captureMessage(
        `${LOG} Run incomplete (${summary.mode}): orgsFailed=${summary.orgsFailed} phasesFailed=${summary.phasesFailed} ` +
        `orgsInvalidWindow=${summary.orgsInvalidWindow} transcriptDeletesFailed=${summary.transcripts.failed}`,
        { eventCode: 'ai_transcript_retention_incomplete' },
      );
    } catch (err) {
      console.warn(`${LOG} Failed to report the incomplete run to Sentry:`, err);
    }
  }

  summary.durationMs = Date.now() - startedAt;
  const scope =
    `across ${summary.orgsScanned} orgs (failed=${summary.orgsFailed}, invalidWindow=${summary.orgsInvalidWindow}, ` +
    `withoutAuditPolicy=${summary.orgsWithoutAuditPolicy}) in ${summary.durationMs}ms`;
  if (!opts.enforce) {
    const { technician, client, stubDelete, capped } = summary.eligible;
    const plus = capped ? '+' : '';
    console.log(
      `${LOG} REPORT-ONLY: ${technician + client}${plus} sessions eligible to stub ` +
      `(technician=${technician}, client=${client}) and ${stubDelete}${plus} existing stubs eligible to delete ` +
      `${scope}; set ${ENFORCE_VAR}=true to act`,
    );
    // A report with a failed phase or org would publish an understated count
    // as current evidence (and the recorder drops `incomplete` whenever
    // `rowsEligible` is set). Same rule as runRetentionTargets for a failed
    // target: record only that the run is incomplete.
    const countsMissing = summary.orgsFailed > 0 || summary.orgsInvalidWindow > 0;
    recordRetentionRun(
      'ai_transcript_retention',
      countsMissing ? { incomplete: true } : { rowsEligible: technician + client + stubDelete },
    );
  } else {
    const { stubbed, transcripts } = summary;
    console.log(
      `${LOG} Stubbed technician=${stubbed.technician} client=${stubbed.client}, deleted stubs=${summary.stubsDeleted} ` +
      `(transcripts deleted=${transcripts.deleted} notFound=${transcripts.notFound} failed=${transcripts.failed}) ${scope}`,
    );
    recordRetentionRun('ai_transcript_retention', {
      rowsDeleted: stubbed.technician + stubbed.client + summary.stubsDeleted,
      incomplete: summary.incomplete,
    });
  }
  return summary;
}

// --------------------------------------------------------------------------
// BullMQ wiring (same shape as scriptExecutionRetention)
// --------------------------------------------------------------------------

export interface AiTranscriptRetentionJobData {
  batchSize?: number;
  maxBatches?: number;
  /** The only payload switch: it can turn enforcement OFF, never on. */
  forceReport?: boolean;
}

let retentionQueue: Queue | null = null;
let retentionWorker: Worker<AiTranscriptRetentionJobData> | null = null;

export function getAiTranscriptRetentionQueue(): Queue {
  if (!retentionQueue) retentionQueue = new Queue(QUEUE_NAME, { connection: getBullMQConnection() });
  return retentionQueue;
}

export function createAiTranscriptRetentionWorker(): Worker<AiTranscriptRetentionJobData> {
  return new Worker<AiTranscriptRetentionJobData>(
    QUEUE_NAME,
    // No context wrapper: every read and batch opens its own (retentionBatch.ts).
    async (job: Job<AiTranscriptRetentionJobData>) => runAiTranscriptRetention({
      batchSize: Math.max(1, job.data?.batchSize ?? BATCH_SIZE),
      maxBatches: Math.max(1, job.data?.maxBatches ?? MAX_BATCHES),
      enforce: AI_TRANSCRIPT_RETENTION_ENFORCE && !job.data?.forceReport,
    }),
    { connection: getBullMQConnection(), concurrency: 1 },
  );
}

export async function initializeAiTranscriptRetention(): Promise<void> {
  try {
    retentionWorker = createAiTranscriptRetentionWorker();
    // Logs and captures the worker's `error` and `failed` events itself.
    attachWorkerObservability(retentionWorker, 'aiTranscriptRetention');

    // Daily cron slot from the registry — NOT `every: 24h` (epoch-anchored).
    await getAiTranscriptRetentionQueue().upsertJobScheduler(
      QUEUE_NAME,
      { pattern: jobSchedule('ai-transcript-retention') },
      {
        name: 'sweep',
        data: { batchSize: BATCH_SIZE, maxBatches: MAX_BATCHES },
        opts: { removeOnComplete: { count: 5 }, removeOnFail: { count: 10 } },
      },
    );

    console.log(`${LOG} Retention worker initialized (${AI_TRANSCRIPT_RETENTION_ENFORCE ? 'ENFORCING' : 'report-only'})`);
  } catch (error) {
    console.error(`${LOG} Failed to initialize:`, error);
    throw error;
  }
}

export async function shutdownAiTranscriptRetention(): Promise<void> {
  if (retentionWorker) {
    await retentionWorker.close();
    retentionWorker = null;
  }
  if (retentionQueue) {
    await retentionQueue.close();
    retentionQueue = null;
  }
}

export const __testOnly = { QUEUE_NAME, BATCH_SIZE, MAX_BATCHES, ENFORCE: AI_TRANSCRIPT_RETENTION_ENFORCE };
