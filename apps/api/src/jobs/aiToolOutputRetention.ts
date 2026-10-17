/**
 * AI tool output retention (#8852 W03; spec §3 "Retention").
 *
 * Nightly, per org, tool outputs older than the org's effective
 * `tool_output_retention_days` are scrubbed:
 *
 *   - `ai_messages.tool_output` and `ai_tool_executions.tool_output` become
 *     the tombstone `{"_retention":"scrubbed","at":"<iso>"}`. The rows stay, so
 *     the audit trail (tool name, input, status, approver, timestamps) and the
 *     tool-call/result pairing (`tool_use_id` is a column, untouched) survive.
 *   - The session's resumable SDK transcript is cut loose IN THE SAME STATEMENT:
 *     `ai_sessions.sdk_session_id` is cleared for every session one of whose
 *     rows was just scrubbed, and the old id is returned so the transcript
 *     file can be deleted after commit (`deleteSdkTranscript`).
 *   - `input_capture` artifacts older than the window are expired now and
 *     their head/tail previews blanked; the hourly `aiArtifactSweeper` then
 *     deletes blob-then-row, and `read_artifact` / the REST download already
 *     refuse an expired row in the meantime. `export_dataset` artifacts are
 *     intentional user deliverables and keep their own TTL.
 *
 * EFFECTIVE POLICY (resolved per org, in SYSTEM context, never through the
 * request-path resolver): one read of every `ai_data_policies` row plus every
 * organization's partner, merged per org by the same pure
 * `mergeAiDataPolicies` the settings routes and the executeTool gate use.
 *   - No partner row  → the code default, 30 days.
 *   - Partner row NULL → keep forever: the org is skipped entirely.
 *   - Org row NULL     → inherit the partner value.
 *   - Org row N        → min(N, partner) — an org may only tighten.
 * A value that is not a positive integer skips the org (retain rather than
 * guess). Orgs are not filtered by status: an archived org's outputs age out
 * like any other.
 *
 * IDEMPOTENT AND RESUMABLE (Review Focus 4). The tombstone is the "already
 * scrubbed" predicate, so a re-run never touches a tombstone again (its `at`
 * keeps the time of the first scrub). Each batch is one statement in its own
 * fresh system transaction (lock-duration rationale: `retentionBatch.ts`), and
 * the session clear rides in that statement — an interrupted run can never
 * leave a scrubbed row behind a still-resumable raw transcript. Clearing keys
 * on "rows scrubbed by THIS statement", not "session has tombstones", so the
 * fresh transcript a user starts after a scrub is not cleared again next night.
 *
 * LIVE SESSIONS ARE DEFERRED. A session with any `ai_messages` row inside
 * `LIVE_SESSION_QUIET_MS` may be alive in some API process's memory, where the
 * raw transcript is still in the model's context. It is skipped this run and
 * picked up by a later one. The window is longer than the in-memory idle
 * eviction (`SESSION_IDLE_TIMEOUT_MS`, 2 h, streamingSessionManager.ts). The
 * init handler there only stores an SDK session id over the value its query
 * started from, so a query that resumed an id just before this job cleared it
 * cannot write the id back.
 *
 * A resumed scrubbed session starts a FRESH SDK transcript: the model does not
 * see the earlier conversation; the UI history shows the tombstones.
 *
 * TRANSCRIPT FILES are best effort. The SDK keeps them under the API process's
 * `$HOME/.claude/projects/` (`persistSession: true`). This job deletes them by
 * id with the SDK's own `deleteSession`, which only reaches the filesystem of
 * the process the job runs in — every transcript in the default single-process
 * deployment (`BREEZE_ROLE=all`), none on a split worker. A transcript the job
 * cannot reach is no longer referenced by any session, so the product can
 * never resume or read it again; it remains on that container's disk until
 * the container is replaced.
 *
 * Not covered (spec "Out of scope"): user/assistant prose, continuation
 * summaries, screenshots, run workspaces. `ai_messages.content_blocks` holds no
 * tool results: no write path persists `tool_result` blocks there (the SDK's
 * user/tool_result turns are never stored), so there is nothing to rewrite.
 */
import { Job, Queue, Worker } from 'bullmq';
import { sql } from 'drizzle-orm';
// The tombstone's discriminator; the web and mobile tool cards key on it too.
import { AI_TOOL_OUTPUT_SCRUBBED, type AiToolOutputTombstone } from '@breeze/shared';

import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { extractRowCount } from '../db/rowCount';
import { aiDataPolicies, organizations, type AiDataPolicyRow } from '../db/schema';
import { mergeAiDataPolicies } from '../services/aiDataPolicy';
import { getBullMQConnection } from '../services/redis';
import { recordRetentionRun } from '../services/retentionMetrics';
import { attachWorkerObservability } from './workerObservability';
import { cronFromEnv } from './scheduleRegistry';
import { parsePositiveIntEnv, warnOnRetentionBacklog, type BatchedPruneResult } from './retentionBatch';

const LOG = '[AiToolOutputRetention]';
const QUEUE_NAME = 'ai-tool-output-retention';
const JOB_NAME = 'ai-tool-output-retention';
const REPEAT_JOB_ID = 'ai-tool-output-retention';
const DAY_MS = 24 * 60 * 60 * 1000;

export function tombstone(at: Date): AiToolOutputTombstone {
  return { _retention: AI_TOOL_OUTPUT_SCRUBBED, at: at.toISOString() };
}

/** Longer than the 2 h in-memory idle eviction, with margin for the eviction tick. See the header. */
export const LIVE_SESSION_QUIET_MS = 3 * 60 * 60 * 1000;

const DEFAULT_BATCH_SIZE = 1000;
const DEFAULT_MAX_BATCHES = 50;

export type TranscriptDeleteOutcome = 'deleted' | 'not_found' | 'failed';
export type TranscriptDeleter = (sdkSessionId: string) => Promise<TranscriptDeleteOutcome>;

export interface ScrubOptions {
  batchSize: number;
  maxBatches: number;
  now?: Date;
}

export interface OrgScrubResult {
  messages: BatchedPruneResult;
  executions: BatchedPruneResult;
  artifacts: BatchedPruneResult;
  /** Old `sdk_session_id`s cleared by this run, for transcript deletion. */
  clearedSdkSessionIds: string[];
}

const inFreshSystemContext = <T>(label: string, fn: () => Promise<T>): Promise<T> =>
  runOutsideDbContext(() => withSystemDbAccessContext(fn, label));

/**
 * `created_at` on both tool tables is `timestamp WITHOUT time zone` holding
 * UTC wall time. Compare against the cutoff converted to UTC wall time, so the
 * result does not depend on the connection's `TimeZone`.
 */
const utcWallTime = (iso: string) => sql`(${iso}::timestamptz AT TIME ZONE 'UTC')`;

type ToolTable = 'ai_messages' | 'ai_tool_executions';

/**
 * One batch: lock up to `batchSize` expired, not-yet-scrubbed rows of quiet
 * sessions in this org, tombstone them, and clear those sessions' SDK session
 * ids — one statement, one transaction.
 */
async function scrubToolRowsBatch(
  table: ToolTable,
  orgId: string,
  cutoffIso: string,
  quietSinceIso: string,
  markerJson: string,
  batchSize: number,
): Promise<{ scrubbed: number; cleared: string[] }> {
  // A table name cannot be a bound parameter; `table` is one of two literals.
  const t = sql.raw(table);
  const rows = await inFreshSystemContext(`aiToolOutputRetention.${table}`, () => db.execute(sql`
    WITH target AS (
      SELECT tr.id
      FROM ${t} tr
      JOIN ai_sessions s ON s.id = tr.session_id
      WHERE s.org_id = ${orgId}::uuid
        AND tr.created_at < ${utcWallTime(cutoffIso)}
        AND tr.tool_output IS NOT NULL
        AND tr.tool_output->>'_retention' IS DISTINCT FROM ${AI_TOOL_OUTPUT_SCRUBBED}
        AND NOT EXISTS (
          SELECT 1 FROM ai_messages live
          WHERE live.session_id = tr.session_id
            AND live.created_at >= ${utcWallTime(quietSinceIso)}
        )
      LIMIT ${batchSize}
      FOR UPDATE OF tr SKIP LOCKED
    ),
    scrubbed AS (
      UPDATE ${t} tr SET tool_output = ${markerJson}::jsonb
      FROM target WHERE tr.id = target.id
      RETURNING tr.session_id
    ),
    prior AS (
      SELECT s.id, s.sdk_session_id
      FROM ai_sessions s
      WHERE s.id IN (SELECT session_id FROM scrubbed) AND s.sdk_session_id IS NOT NULL
      FOR UPDATE OF s
    ),
    cleared AS (
      UPDATE ai_sessions s SET sdk_session_id = NULL
      FROM prior WHERE s.id = prior.id
      RETURNING prior.sdk_session_id AS old_sdk_session_id
    )
    SELECT
      (SELECT count(*) FROM scrubbed)::int AS scrubbed,
      COALESCE((SELECT array_agg(old_sdk_session_id) FROM cleared), '{}'::varchar[]) AS cleared
  `));
  const row = (rows as unknown as Array<{ scrubbed: number; cleared: string[] | null }>)[0];
  if (!row || typeof row.scrubbed !== 'number') {
    // Never read a missing result as "0 scrubbed": that ends the loop early
    // and silently retains expired outputs (same contract as extractRowCount).
    throw new Error(`${LOG} ${table} scrub returned no summary row`);
  }
  return { scrubbed: row.scrubbed, cleared: row.cleared ?? [] };
}

async function expireCapturesBatch(orgId: string, cutoffIso: string, batchSize: number): Promise<number> {
  const result = await inFreshSystemContext('aiToolOutputRetention.ai_run_artifacts', () => db.execute(sql`
    UPDATE ai_run_artifacts
    SET expires_at = LEAST(expires_at, now()), head_preview = '', tail_preview = ''
    WHERE id IN (
      SELECT id FROM ai_run_artifacts
      WHERE org_id = ${orgId}::uuid
        AND kind = 'input_capture'
        AND created_by_tool <> 'export_dataset'
        AND created_at < ${cutoffIso}::timestamptz
        AND expires_at > now()
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    )
  `));
  return extractRowCount(result);
}

async function batched(
  batchSize: number,
  maxBatches: number,
  run: () => Promise<number>,
): Promise<BatchedPruneResult> {
  let deleted = 0;
  let batches = 0;
  let last = 0;
  while (batches < maxBatches) {
    last = await run();
    deleted += last;
    batches += 1;
    if (last < batchSize) break;
  }
  return { deleted, batches, hasMore: batches >= maxBatches && last >= batchSize };
}

/**
 * Scrub one org. Must NOT be called inside a DB context: every batch opens its
 * own (see `retentionBatch.ts`). `onCleared` runs after each batch COMMITS,
 * so a transcript is only ever deleted for a session id that is gone from the DB.
 */
export async function scrubOrgToolOutputs(
  orgId: string,
  retentionDays: number,
  opts: ScrubOptions & { onCleared?: (sdkSessionIds: string[]) => Promise<void> },
): Promise<OrgScrubResult> {
  const now = opts.now ?? new Date();
  const cutoffIso = new Date(now.getTime() - retentionDays * DAY_MS).toISOString();
  const quietSinceIso = new Date(now.getTime() - LIVE_SESSION_QUIET_MS).toISOString();
  const markerJson = JSON.stringify(tombstone(now));
  const clearedSdkSessionIds: string[] = [];

  const scrubTable = (table: ToolTable) => batched(opts.batchSize, opts.maxBatches, async () => {
    const { scrubbed, cleared } = await scrubToolRowsBatch(table, orgId, cutoffIso, quietSinceIso, markerJson, opts.batchSize);
    if (cleared.length > 0) {
      clearedSdkSessionIds.push(...cleared);
      if (opts.onCleared) await opts.onCleared(cleared);
    }
    return scrubbed;
  });

  const messages = await scrubTable('ai_messages');
  const executions = await scrubTable('ai_tool_executions');
  const artifacts = await batched(opts.batchSize, opts.maxBatches, () => expireCapturesBatch(orgId, cutoffIso, opts.batchSize));
  return { messages, executions, artifacts, clearedSdkSessionIds };
}

/** Delete one SDK transcript (`<id>.jsonl` + its subagent dir) from this process's projects dir. */
export const deleteSdkTranscript: TranscriptDeleter = async (sdkSessionId) => {
  try {
    const { deleteSession } = await import('@anthropic-ai/claude-agent-sdk');
    await deleteSession(sdkSessionId);
    return 'deleted';
  } catch (err) {
    // The SDK throws "Session <id> not found in any project directory" when the
    // file is not on THIS filesystem: expected on a split worker (see header).
    if (err instanceof Error && /not found/i.test(err.message)) return 'not_found';
    console.warn(`${LOG} Failed to delete SDK transcript ${sdkSessionId}:`, err);
    return 'failed';
  }
};

/**
 * Effective retention days per org, from ONE system-context read. A `Map` of
 * orgId → days, `null` = keep forever.
 */
export async function loadEffectiveRetentionByOrg(): Promise<Map<string, number | null>> {
  const { orgRows, policyRows } = await inFreshSystemContext('aiToolOutputRetention.policies', async () => ({
    orgRows: await db.select({ id: organizations.id, partnerId: organizations.partnerId }).from(organizations),
    policyRows: await db.select().from(aiDataPolicies),
  }));
  const partnerRows = new Map<string, AiDataPolicyRow>();
  const orgPolicyRows = new Map<string, AiDataPolicyRow>();
  for (const row of policyRows) {
    if (row.orgId) orgPolicyRows.set(row.orgId, row);
    else if (row.partnerId) partnerRows.set(row.partnerId, row);
  }
  const out = new Map<string, number | null>();
  for (const org of orgRows) {
    const partner = org.partnerId ? partnerRows.get(org.partnerId) ?? null : null;
    out.set(org.id, mergeAiDataPolicies(partner, orgPolicyRows.get(org.id) ?? null).toolOutputRetentionDays);
  }
  return out;
}

export interface RetentionRunSummary {
  orgsScanned: number;
  orgsScrubbed: number;
  orgsKeptForever: number;
  orgsSkipped: number;
  orgsFailed: number;
  totals: { messages: number; executions: number; artifacts: number; sessions: number };
  transcripts: { deleted: number; notFound: number; failed: number };
  incomplete: boolean;
  durationMs: number;
}

export async function runAiToolOutputRetention(opts: ScrubOptions & { deleteTranscript?: TranscriptDeleter }): Promise<RetentionRunSummary> {
  const startedAt = Date.now();
  const deleteTranscript = opts.deleteTranscript ?? deleteSdkTranscript;
  const summary: RetentionRunSummary = {
    orgsScanned: 0, orgsScrubbed: 0, orgsKeptForever: 0, orgsSkipped: 0, orgsFailed: 0,
    totals: { messages: 0, executions: 0, artifacts: 0, sessions: 0 },
    transcripts: { deleted: 0, notFound: 0, failed: 0 },
    incomplete: false,
    durationMs: 0,
  };

  const onCleared = async (ids: string[]) => {
    summary.totals.sessions += ids.length;
    for (const id of ids) {
      const outcome = await deleteTranscript(id);
      if (outcome === 'deleted') summary.transcripts.deleted += 1;
      else if (outcome === 'not_found') summary.transcripts.notFound += 1;
      else summary.transcripts.failed += 1;
    }
  };

  const retentionByOrg = await loadEffectiveRetentionByOrg();
  for (const [orgId, days] of retentionByOrg) {
    summary.orgsScanned += 1;
    if (days === null) { summary.orgsKeptForever += 1; continue; }
    if (!Number.isSafeInteger(days) || days < 1) {
      console.error(`${LOG} Org ${orgId} has an unusable retention of ${String(days)} days; SKIPPING it (retain rather than guess)`);
      summary.orgsSkipped += 1;
      continue;
    }
    try {
      const r = await scrubOrgToolOutputs(orgId, days, { ...opts, onCleared });
      summary.orgsScrubbed += 1;
      summary.totals.messages += r.messages.deleted;
      summary.totals.executions += r.executions.deleted;
      summary.totals.artifacts += r.artifacts.deleted;
      for (const [target, result] of [
        ['ai_messages', r.messages], ['ai_tool_executions', r.executions], ['ai_run_artifacts', r.artifacts],
      ] as const) {
        if (result.hasMore) {
          summary.incomplete = true;
          warnOnRetentionBacklog(LOG, `ai_tool_output.${target}`, result, `org=${orgId}`);
        }
      }
    } catch (err) {
      console.error(`${LOG} Failed to scrub tool outputs for org ${orgId}:`, err);
      summary.orgsFailed += 1;
    }
  }

  // A failed or skipped org certainly still holds expired outputs.
  if (summary.orgsFailed > 0 || summary.orgsSkipped > 0 || summary.transcripts.failed > 0) summary.incomplete = true;
  summary.durationMs = Date.now() - startedAt;
  const { totals, transcripts } = summary;
  console.log(
    `${LOG} Scrubbed messages=${totals.messages} executions=${totals.executions} captures=${totals.artifacts} ` +
    `sessions=${totals.sessions} (transcripts deleted=${transcripts.deleted} notFound=${transcripts.notFound} failed=${transcripts.failed}) ` +
    `across ${summary.orgsScrubbed}/${summary.orgsScanned} orgs (keptForever=${summary.orgsKeptForever}, ` +
    `skipped=${summary.orgsSkipped}, failed=${summary.orgsFailed}) in ${summary.durationMs}ms`,
  );
  recordRetentionRun('ai_tool_output_retention', {
    rowsDeleted: totals.messages + totals.executions + totals.artifacts,
    incomplete: summary.incomplete,
  });
  return summary;
}

// --------------------------------------------------------------------------
// BullMQ wiring (same shape as mlOutputRetention / aiInvocationRetention)
// --------------------------------------------------------------------------

type RetentionJobData = { batchSize?: number; maxBatches?: number };

const BATCH_SIZE = parsePositiveIntEnv(LOG, 'AI_TOOL_OUTPUT_RETENTION_BATCH_SIZE', DEFAULT_BATCH_SIZE);
const MAX_BATCHES = parsePositiveIntEnv(LOG, 'AI_TOOL_OUTPUT_RETENTION_MAX_BATCHES', DEFAULT_MAX_BATCHES);

let queue: Queue<RetentionJobData> | null = null;
let worker: Worker<RetentionJobData> | null = null;

function getQueue(): Queue<RetentionJobData> {
  if (!queue) queue = new Queue<RetentionJobData>(QUEUE_NAME, { connection: getBullMQConnection() });
  return queue;
}

export function createAiToolOutputRetentionWorker(): Worker<RetentionJobData> {
  return new Worker<RetentionJobData>(
    QUEUE_NAME,
    // Deliberately NOT wrapped in a DB context: every read and batch opens its
    // own short system context (an outer one would hold one transaction across
    // the whole sweep — retentionBatch.ts).
    async (job: Job<RetentionJobData>) => runAiToolOutputRetention({
      batchSize: Math.max(1, job.data.batchSize ?? BATCH_SIZE),
      maxBatches: Math.max(1, job.data.maxBatches ?? MAX_BATCHES),
    }),
    { connection: getBullMQConnection(), concurrency: 1 },
  );
}

export async function initializeAiToolOutputRetention(): Promise<void> {
  worker = createAiToolOutputRetentionWorker();
  // attachWorkerObservability routes 'error'/'failed' to Sentry.
  attachWorkerObservability(worker, 'aiToolOutputRetention');
  const q = getQueue();
  for (const job of await q.getRepeatableJobs()) await q.removeRepeatableByKey(job.key);
  await q.add(JOB_NAME, { batchSize: BATCH_SIZE, maxBatches: MAX_BATCHES }, {
    jobId: REPEAT_JOB_ID,
    repeat: { pattern: cronFromEnv('AI_TOOL_OUTPUT_RETENTION_CRON', 'ai-tool-output-retention') },
    removeOnComplete: { count: 5 },
    removeOnFail: { count: 20 },
  });
  console.log(`${LOG} Retention worker initialized`);
}

export async function shutdownAiToolOutputRetention(): Promise<void> {
  if (worker) { await worker.close(); worker = null; }
  if (queue) { await queue.close(); queue = null; }
}

export const __testOnly = { QUEUE_NAME, JOB_NAME, REPEAT_JOB_ID, BATCH_SIZE, MAX_BATCHES };
