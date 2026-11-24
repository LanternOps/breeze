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
 *   - No partner row       → the code default, 30 days (an org row N still tightens it).
 *   - Partner row NULL     → no ceiling ("keep forever"): an org with no row,
 *                            or a NULL row, is skipped; an org row N applies N.
 *   - Partner row P        → P, unless the org row is a smaller N.
 *   - Org row NULL         → inherit the partner value.
 *   - Org row N above P    → ignored (an org may only tighten; min(N, P)).
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
 * raw transcript is still in the model's context. Its rows are skipped while
 * they are less than `LIVE_SESSION_MAX_DEFER_MS` past the window, so a later
 * run picks them up; a session that never goes quiet is scrubbed anyway once
 * that allowance is used, and its live query (if any) keeps the old context
 * only until in-memory eviction (24 h at most). The quiet window is longer than
 * the in-memory idle eviction (`SESSION_IDLE_TIMEOUT_MS`, 2 h,
 * streamingSessionManager.ts). The init handler there only stores an SDK
 * session id over the value its query started from, so a query that resumed an
 * id just before this job cleared it cannot write the id back.
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
 * the container is replaced, or until that container's `aiTranscriptSweeper`
 * run deletes it (#9050).
 *
 * ORPHANED TRANSCRIPTS on other containers are swept by `aiTranscriptSweeper`
 * (#9050), which each API process runs against its own projects dir.
 *
 * `action_intents.result` of terminal intents past the same window is nulled
 * in the same run (#9050; `nullIntentResultsBatch`).
 *
 * TOOL-DISCOVERY TELEMETRY (#12421 W01) rides the same run, per org, with
 * two deliberate differences: rows are DELETED (`ai_tool_search_events`, no
 * tombstone), and the age is the org's window capped at
 * SEARCH_EVENT_MAX_AGE_DAYS — so a keep-forever org still loses them at 180
 * days — with no live-session deferral (nothing in memory reads them). The
 * same pass blanks the ToolSearch `tool_use` input (the model's query) inside
 * aged assistant rows' `ai_messages.content_blocks`, the one other copy.
 * REPORT-FIRST (#4342, owner decision 2026-11-24): these two passes only COUNT
 * what they would delete or blank until `AI_TOOL_DISCOVERY_RETENTION_ENFORCE`
 * is `true`/`1` (default false). The tool-output scrub above is not behind it.
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
import { REVEAL_WINDOW_DAYS } from '../services/actionIntents/resultSecrets';
import { mergeAiDataPolicies } from '../services/aiDataPolicy';
import { safeErrorMessage } from '../services/aiModels/safeDbError';
import { LIVE_SESSION_MAX_DEFER_MS, LIVE_SESSION_QUIET_MS } from '../services/aiTranscriptRetentionPredicates';
import { getBullMQConnection } from '../services/redis';
import { recordRetentionRun } from '../services/retentionMetrics';
import { captureMessage } from '../services/sentry';
import { attachWorkerObservability } from './workerObservability';
import { cronFromEnv } from './scheduleRegistry';
import {
  countEligibleRows,
  parsePositiveIntEnv,
  retentionEnforceFromEnv,
  utcWallTime,
  warnOnRetentionBacklog,
  type BatchedPruneResult,
} from './retentionBatch';

const LOG = '[AiToolOutputRetention]';
const QUEUE_NAME = 'ai-tool-output-retention';
const JOB_NAME = 'ai-tool-output-retention';
const REPEAT_JOB_ID = 'ai-tool-output-retention';
const DAY_MS = 24 * 60 * 60 * 1000;
const DISCOVERY_ENFORCE_VAR = 'AI_TOOL_DISCOVERY_RETENTION_ENFORCE';

/**
 * #12421 W01, report-first (#4342; owner decision 2026-11-24): the two
 * tool-discovery passes (delete `ai_tool_search_events`, blank ToolSearch
 * inputs) only count until this is `true`/`1`. Read once; code default FALSE.
 */
export const AI_TOOL_DISCOVERY_RETENTION_ENFORCE = retentionEnforceFromEnv(LOG, DISCOVERY_ENFORCE_VAR, false);

export function tombstone(at: Date): AiToolOutputTombstone {
  return { _retention: AI_TOOL_OUTPUT_SCRUBBED, at: at.toISOString() };
}

// The live-session rule is shared with transcript retention (#4342 W4); see the header.
export { LIVE_SESSION_MAX_DEFER_MS, LIVE_SESSION_QUIET_MS };

const DEFAULT_BATCH_SIZE = 1000;

/**
 * #12421 W01: tool-discovery rows never outlive this, whatever the org's
 * tool-output window (including "keep forever"). Spec §3.5.
 */
export const SEARCH_EVENT_MAX_AGE_DAYS = 180;

/** The age at which an org's discovery telemetry is removed: its window, capped. */
export function searchEventAgeDays(retentionDays: number | null): number {
  return retentionDays === null ? SEARCH_EVENT_MAX_AGE_DAYS : Math.min(retentionDays, SEARCH_EVENT_MAX_AGE_DAYS);
}
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
  /** `action_intents.result` payloads nulled (#9050). */
  intents: BatchedPruneResult;
  /** Old `sdk_session_id`s cleared by this run, for transcript deletion. */
  clearedSdkSessionIds: string[];
}

const inFreshSystemContext = <T>(label: string, fn: () => Promise<T>): Promise<T> =>
  runOutsideDbContext(() => withSystemDbAccessContext(fn, label));

// `created_at` on both tool tables (`ai_messages`, `ai_tool_executions`) is
// `timestamp WITHOUT time zone` holding UTC wall time, so their cutoffs go
// through `utcWallTime` (`retentionBatch.ts`) and do not depend on the
// connection's `TimeZone`.

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
  deferUntilIso: string,
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
        AND (
          tr.created_at < ${utcWallTime(deferUntilIso)}
          OR NOT EXISTS (
            SELECT 1 FROM ai_messages live
            WHERE live.session_id = tr.session_id
              AND live.created_at >= ${utcWallTime(quietSinceIso)}
          )
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
      FOR NO KEY UPDATE OF s
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

/**
 * #9050: `action_intents.result` holds the executed tool's output (and, for a
 * refused intent, its denial breadcrumb) outside the tables above. Same
 * window, same org: a TERMINAL intent created before the cutoff has its
 * `result` nulled. `result` is lifecycle data, not covered by the
 * `action_intents_block_content_update` trigger, so the intent row, status,
 * arguments and audit columns all stay. Idempotent through
 * `result IS NOT NULL`; live (pending/approved/executing) intents are never
 * touched.
 */
async function nullIntentResultsBatch(orgId: string, cutoffIso: string, batchSize: number): Promise<number> {
  const result = await inFreshSystemContext('aiToolOutputRetention.action_intents', () => db.execute(sql`
    UPDATE action_intents
    SET result = NULL
    WHERE id IN (
      SELECT id FROM action_intents
      WHERE org_id = ${orgId}::uuid
        AND result IS NOT NULL
        AND status IN ('completed', 'failed', 'rejected', 'expired', 'cancelled')
        AND created_at < ${cutoffIso}::timestamptz
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
  // Rows older than this are scrubbed even in a live session (see the header).
  const deferUntilIso = new Date(now.getTime() - retentionDays * DAY_MS - LIVE_SESSION_MAX_DEFER_MS).toISOString();
  // An intent's `result` may carry a sealed one-time secret (temporary password)
  // that the tech can reveal for REVEAL_WINDOW_DAYS; never null it sooner, even
  // for an org whose retention is shorter than that window.
  const revealFloorIso = new Date(now.getTime() - REVEAL_WINDOW_DAYS * DAY_MS).toISOString();
  const intentCutoffIso = revealFloorIso < cutoffIso ? revealFloorIso : cutoffIso;
  const markerJson = JSON.stringify(tombstone(now));
  const clearedSdkSessionIds: string[] = [];

  const scrubTable = (table: ToolTable) => batched(opts.batchSize, opts.maxBatches, async () => {
    const { scrubbed, cleared } = await scrubToolRowsBatch(table, orgId, cutoffIso, deferUntilIso, quietSinceIso, markerJson, opts.batchSize);
    if (cleared.length > 0) {
      clearedSdkSessionIds.push(...cleared);
      if (opts.onCleared) await opts.onCleared(cleared);
    }
    return scrubbed;
  });

  const messages = await scrubTable('ai_messages');
  const executions = await scrubTable('ai_tool_executions');
  const artifacts = await batched(opts.batchSize, opts.maxBatches, () => expireCapturesBatch(orgId, cutoffIso, opts.batchSize));
  const intents = await batched(opts.batchSize, opts.maxBatches, () => nullIntentResultsBatch(orgId, intentCutoffIso, opts.batchSize));
  return { messages, executions, artifacts, intents, clearedSdkSessionIds };
}

/** Delete one SDK transcript (`<id>.jsonl` + its subagent dir) from this process's projects dir. */
export const deleteSdkTranscript: TranscriptDeleter = async (sdkSessionId) => {
  let deleteSession: (id: string) => Promise<void>;
  try {
    ({ deleteSession } = await import('@anthropic-ai/claude-agent-sdk'));
  } catch (err) {
    // Not "not found": the transcript may well be on this disk.
    console.warn(`${LOG} Could not load the agent SDK to delete transcript ${sdkSessionId}:`, err);
    return 'failed';
  }
  try {
    await deleteSession(sdkSessionId);
    return 'deleted';
  } catch (err) {
    // The SDK's own messages all start "Session <id> not found" (no projects
    // dir / not in any project dir) when the file is not on THIS filesystem:
    // expected on a split worker (see header). Anything else is a failure.
    if (err instanceof Error && err.message.startsWith(`Session ${sdkSessionId} not found`)) return 'not_found';
    console.warn(`${LOG} Failed to delete SDK transcript ${sdkSessionId}:`, err);
    return 'failed';
  }
};

/**
 * #12421 W01: delete one org's `ai_tool_search_events` rows older than its
 * discovery age, batch by batch, each batch its own fresh system transaction.
 * The table has no org_id: rows are scoped through their session. Its
 * `created_at` is `timestamptz`, so the cutoff is compared as one (not through
 * `utcWallTime`, which is for the `timestamp` columns). No live-session
 * deferral: nothing in memory reads these rows.
 */
export async function deleteAgedSearchEvents(
  orgId: string,
  retentionDays: number | null,
  opts: ScrubOptions,
): Promise<BatchedPruneResult> {
  const now = opts.now ?? new Date();
  const cutoffIso = new Date(now.getTime() - searchEventAgeDays(retentionDays) * DAY_MS).toISOString();
  return batched(opts.batchSize, opts.maxBatches, async () => {
    const result = await inFreshSystemContext('aiToolOutputRetention.ai_tool_search_events', () => db.execute(sql`
      WITH target AS (
        SELECT e.id
          FROM ai_tool_search_events e
          JOIN ai_sessions s ON s.id = e.session_id
         WHERE s.org_id = ${orgId}
           AND e.created_at < ${cutoffIso}::timestamptz
         LIMIT ${opts.batchSize}
         FOR UPDATE OF e SKIP LOCKED
      )
      DELETE FROM ai_tool_search_events
       WHERE id IN (SELECT id FROM target)
    `));
    return extractRowCount(result);
  });
}

/**
 * #12421 W01 report mode: how many `ai_tool_search_events` rows
 * `deleteAgedSearchEvents` would remove for this org, capped at
 * `batchSize * maxBatches` (what one enforce run can remove). Same predicate,
 * written against the bare table because `countEligibleRows` selects from one.
 */
export async function countAgedSearchEvents(
  orgId: string,
  retentionDays: number | null,
  opts: ScrubOptions,
): Promise<{ eligible: number; capped: boolean }> {
  const now = opts.now ?? new Date();
  const cutoffIso = new Date(now.getTime() - searchEventAgeDays(retentionDays) * DAY_MS).toISOString();
  return countEligibleRows({
    table: 'ai_tool_search_events',
    where: sql`ai_tool_search_events.created_at < ${cutoffIso}::timestamptz
      AND EXISTS (SELECT 1 FROM ai_sessions s WHERE s.id = ai_tool_search_events.session_id AND s.org_id = ${orgId})`,
    cap: opts.batchSize * opts.maxBatches,
    label: 'aiToolOutputRetention.count_ai_tool_search_events',
  });
}

/** #12421 W01 report mode: the `blankAgedToolSearchInputs` predicate, counted. */
export async function countAgedToolSearchInputs(
  orgId: string,
  ageDays: number,
  opts: ScrubOptions,
): Promise<{ eligible: number; capped: boolean }> {
  const now = opts.now ?? new Date();
  const cutoffIso = new Date(now.getTime() - ageDays * DAY_MS).toISOString();
  return countEligibleRows({
    table: 'ai_messages',
    where: sql`ai_messages.role = 'assistant'
      AND ai_messages.created_at < ${utcWallTime(cutoffIso)}
      AND jsonb_typeof(ai_messages.content_blocks) = 'array'
      AND EXISTS (SELECT 1 FROM ai_sessions s WHERE s.id = ai_messages.session_id AND s.org_id = ${orgId})
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(ai_messages.content_blocks) = 'array' THEN ai_messages.content_blocks ELSE '[]'::jsonb END) b
         WHERE b->>'type' = 'tool_use' AND b->>'name' = 'ToolSearch' AND b->'input' <> '{}'::jsonb
      )`,
    cap: opts.batchSize * opts.maxBatches,
    label: 'aiToolOutputRetention.count_tool_search_inputs',
  });
}

/**
 * #12421 W01: blank the ToolSearch `tool_use` input (the model's search
 * query) inside one org's assistant `ai_messages.content_blocks` older than
 * `ageDays`. Every other block keeps its position and bytes
 * (`WITH ORDINALITY … ORDER BY ord`). "Already blanked" is the
 * `b->'input' <> '{}'` EXISTS, not a `@>` containment test: jsonb containment
 * treats `{}` as contained in every object, so that form would match nothing.
 */
export async function blankAgedToolSearchInputs(
  orgId: string,
  ageDays: number,
  opts: ScrubOptions,
): Promise<BatchedPruneResult> {
  const now = opts.now ?? new Date();
  const cutoffIso = new Date(now.getTime() - ageDays * DAY_MS).toISOString();
  return batched(opts.batchSize, opts.maxBatches, async () => {
    const result = await inFreshSystemContext('aiToolOutputRetention.tool_search_inputs', () => db.execute(sql`
      WITH target AS (
        SELECT m.id
          FROM ai_messages m
          JOIN ai_sessions s ON s.id = m.session_id
         WHERE s.org_id = ${orgId}
           AND m.role = 'assistant'
           AND m.created_at < ${utcWallTime(cutoffIso)}
           AND jsonb_typeof(m.content_blocks) = 'array'
           -- AND order is not guaranteed: never hand jsonb_array_elements a non-array.
           AND EXISTS (
             SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(m.content_blocks) = 'array' THEN m.content_blocks ELSE '[]'::jsonb END) b
              WHERE b->>'type' = 'tool_use' AND b->>'name' = 'ToolSearch' AND b->'input' <> '{}'::jsonb
           )
         LIMIT ${opts.batchSize}
         FOR UPDATE OF m SKIP LOCKED
      )
      UPDATE ai_messages m
         SET content_blocks = (
           SELECT jsonb_agg(
                    CASE WHEN t.b->>'type' = 'tool_use' AND t.b->>'name' = 'ToolSearch'
                         THEN t.b || '{"input":{}}'::jsonb
                         ELSE t.b END
                    ORDER BY t.ord)
             FROM jsonb_array_elements(m.content_blocks) WITH ORDINALITY AS t(b, ord)
         )
        FROM target
       WHERE m.id = target.id
    `));
    return extractRowCount(result);
  });
}

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
  totals: { messages: number; executions: number; artifacts: number; intents: number; sessions: number };
  transcripts: { deleted: number; notFound: number; failed: number };
  incomplete: boolean;
  durationMs: number;
  /** #12421 W01: ai_tool_search_events rows deleted. */
  searchEventsDeleted: number;
  /** #12421 W01: assistant rows whose ToolSearch input was blanked. */
  toolSearchInputsBlanked: number;
  /** #12421 W01 report mode: rows the discovery passes WOULD remove (0 when enforcing). */
  searchEventsEligible: number;
  toolSearchInputsEligible: number;
  /** Either report-mode count hit its cap, so the true figure is higher. */
  discoveryEligibleCapped: boolean;
}

export async function runAiToolOutputRetention(opts: ScrubOptions & {
  deleteTranscript?: TranscriptDeleter;
  /** Tests only; production reads AI_TOOL_DISCOVERY_RETENTION_ENFORCE. */
  enforceDiscovery?: boolean;
}): Promise<RetentionRunSummary> {
  const startedAt = Date.now();
  const deleteTranscript = opts.deleteTranscript ?? deleteSdkTranscript;
  const summary: RetentionRunSummary = {
    orgsScanned: 0, orgsScrubbed: 0, orgsKeptForever: 0, orgsSkipped: 0, orgsFailed: 0,
    totals: { messages: 0, executions: 0, artifacts: 0, intents: 0, sessions: 0 },
    transcripts: { deleted: 0, notFound: 0, failed: 0 },
    incomplete: false,
    durationMs: 0,
    searchEventsDeleted: 0,
    toolSearchInputsBlanked: 0,
    searchEventsEligible: 0,
    toolSearchInputsEligible: 0,
    discoveryEligibleCapped: false,
  };
  const enforceDiscovery = opts.enforceDiscovery ?? AI_TOOL_DISCOVERY_RETENTION_ENFORCE;

  const onCleared = async (ids: string[]) => {
    summary.totals.sessions += ids.length;
    for (const id of ids) {
      // The id is already gone from the DB: a throwing deleter must not turn
      // into a failed org (it would hide the rows this run DID scrub).
      const outcome = await deleteTranscript(id).catch((err: unknown) => {
        console.warn(`${LOG} Transcript deleter threw for ${id}:`, err);
        return 'failed' as const;
      });
      if (outcome === 'deleted') summary.transcripts.deleted += 1;
      else if (outcome === 'not_found') summary.transcripts.notFound += 1;
      else summary.transcripts.failed += 1;
    }
  };

  const retentionByOrg = await loadEffectiveRetentionByOrg();
  for (const [orgId, days] of retentionByOrg) {
    summary.orgsScanned += 1;
    if (days !== null && (!Number.isSafeInteger(days) || days < 1)) {
      console.error(`${LOG} Org ${orgId} has an unusable retention of ${String(days)} days; SKIPPING it (retain rather than guess)`);
      summary.orgsSkipped += 1;
      continue;
    }
    // #12421 W01: discovery telemetry first, for keep-forever orgs too (the
    // 180-day ceiling). A failure here counts the org failed but does not
    // keep its tool outputs from being scrubbed below.
    let discoveryFailed = false;
    // Each pass is accounted as soon as it returns, so a later failure never
    // hides rows an earlier one already removed.
    // Report mode: a count pass has the same shape as a delete pass but never
    // reports `hasMore`, so it cannot mark the run incomplete.
    const countPass = (count: () => Promise<{ eligible: number; capped: boolean }>, add: (n: number) => void) =>
      async (): Promise<BatchedPruneResult> => {
        const r = await count();
        add(r.eligible);
        if (r.capped) summary.discoveryEligibleCapped = true;
        return { deleted: 0, batches: 0, hasMore: false };
      };
    const passes = enforceDiscovery
      ? [
        ['ai_tool_search_events', () => deleteAgedSearchEvents(orgId, days, opts),
          (n: number) => { summary.searchEventsDeleted += n; }],
        ['ai_messages.tool_search_input', () => blankAgedToolSearchInputs(orgId, searchEventAgeDays(days), opts),
          (n: number) => { summary.toolSearchInputsBlanked += n; }],
      ] as const
      : [
        ['ai_tool_search_events',
          countPass(() => countAgedSearchEvents(orgId, days, opts), (n) => { summary.searchEventsEligible += n; }),
          (_n: number) => {}],
        ['ai_messages.tool_search_input',
          countPass(() => countAgedToolSearchInputs(orgId, searchEventAgeDays(days), opts), (n) => { summary.toolSearchInputsEligible += n; }),
          (_n: number) => {}],
      ] as const;
    for (const [target, pass, add] of passes) {
      if (discoveryFailed) break;
      try {
        const result = await pass();
        add(result.deleted);
        if (result.hasMore) {
          summary.incomplete = true;
          warnOnRetentionBacklog(LOG, `ai_tool_output.${target}`, result, `org=${orgId}`);
        }
      } catch (err) {
        console.error(`${LOG} Failed to remove tool-discovery telemetry (${target}) for org ${orgId}:`, safeErrorMessage(err));
        discoveryFailed = true;
        summary.orgsFailed += 1;
      }
    }
    if (days === null) { summary.orgsKeptForever += 1; continue; }
    try {
      const r = await scrubOrgToolOutputs(orgId, days, { ...opts, onCleared });
      summary.orgsScrubbed += 1;
      summary.totals.messages += r.messages.deleted;
      summary.totals.executions += r.executions.deleted;
      summary.totals.artifacts += r.artifacts.deleted;
      summary.totals.intents += r.intents.deleted;
      for (const [target, result] of [
        ['ai_messages', r.messages], ['ai_tool_executions', r.executions], ['ai_run_artifacts', r.artifacts],
        ['action_intents', r.intents],
      ] as const) {
        if (result.hasMore) {
          summary.incomplete = true;
          warnOnRetentionBacklog(LOG, `ai_tool_output.${target}`, result, `org=${orgId}`);
        }
      }
    } catch (err) {
      console.error(`${LOG} Failed to scrub tool outputs for org ${orgId}:`, err);
      if (!discoveryFailed) summary.orgsFailed += 1;
    }
  }

  // A failed or skipped org certainly still holds expired outputs.
  if (summary.orgsFailed > 0 || summary.orgsSkipped > 0 || summary.transcripts.failed > 0) {
    summary.incomplete = true;
    // Per-org failures do not fail the BullMQ job (the other orgs were
    // scrubbed), so attachWorkerObservability never sees them. One bounded
    // event per run, counts only (no org ids in tags).
    try {
      captureMessage(
        `${LOG} Run left expired AI tool outputs in place: orgsFailed=${summary.orgsFailed} ` +
        `orgsSkipped=${summary.orgsSkipped} transcriptDeletesFailed=${summary.transcripts.failed}`,
        { eventCode: 'ai_tool_output_retention_incomplete' },
      );
    } catch (err) {
      console.warn(`${LOG} Failed to report the incomplete run to Sentry:`, err);
    }
  }
  summary.durationMs = Date.now() - startedAt;
  const { totals, transcripts } = summary;
  console.log(
    `${LOG} Scrubbed messages=${totals.messages} executions=${totals.executions} captures=${totals.artifacts} intents=${totals.intents} ` +
    `sessions=${totals.sessions} (transcripts deleted=${transcripts.deleted} notFound=${transcripts.notFound} failed=${transcripts.failed}) ` +
    `across ${summary.orgsScrubbed}/${summary.orgsScanned} orgs (keptForever=${summary.orgsKeptForever}, ` +
    `skipped=${summary.orgsSkipped}, failed=${summary.orgsFailed}) in ${summary.durationMs}ms; ` +
    `searchEventsDeleted=${summary.searchEventsDeleted} toolSearchInputsBlanked=${summary.toolSearchInputsBlanked}`,
  );
  if (!enforceDiscovery) {
    const plus = summary.discoveryEligibleCapped ? '+' : '';
    console.log(
      `${LOG} REPORT-ONLY: ${summary.searchEventsEligible}${plus} ai_tool_search_events rows to delete and ` +
      `${summary.toolSearchInputsEligible}${plus} ToolSearch inputs to blank are eligible; ` +
      `set ${DISCOVERY_ENFORCE_VAR}=true to act`,
    );
  }
  recordRetentionRun('ai_tool_output_retention', {
    rowsDeleted: totals.messages + totals.executions + totals.artifacts + totals.intents + summary.searchEventsDeleted,
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
