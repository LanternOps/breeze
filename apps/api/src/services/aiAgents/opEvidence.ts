import { sql } from 'drizzle-orm';
import type {
  AiAgentEvidenceMetric,
  AiAgentEvidenceNamespace,
  AiAgentEvidenceSourceKind,
} from '@breeze/shared';
import { db } from '../../db';
import { aiAgentOpEvidence } from '../../db/schema/aiAgentOpEvidence';

// P2-5 (#4192) — exactly-once graduation-evidence writer.
//
// Every terminal outcome an agent produces (a released action intent, an
// act-mode manifest execution, a fix-watch verdict, a 👍/👎 on an alert
// verdict) writes exactly ONE immutable row here, keyed by
// `(source_kind, source_id, metric)` — an ON CONFLICT DO NOTHING insert
// means "already counted", so BullMQ redelivery can never double-count.
// `graduationService` (A2) reads this ledger over a trailing window.
//
// Callers MUST already be inside a system context (the callers here are all
// worker/release-path code that runs under `withSystemDbAccessContext`
// upstream) — this module opens no context of its own and JOINS whatever
// ambient transaction the caller is in, so an evidence row commits
// atomically with the CAS that produced the outcome it records.

export interface OpEvidenceInsert {
  orgId: string;
  /** The EFFECTIVE agent id (the partner baseline row) the run recorded. */
  agentId: string;
  namespace: AiAgentEvidenceNamespace;
  opKey: string;
  ruleId: string | null;
  sourceKind: AiAgentEvidenceSourceKind;
  sourceId: string;
  metric: AiAgentEvidenceMetric;
  runId: string | null;
  occurredAt: Date;
}

function toEvidenceValues(row: OpEvidenceInsert) {
  return {
    orgId: row.orgId,
    agentId: row.agentId,
    namespace: row.namespace,
    opKey: row.opKey,
    ruleId: row.ruleId,
    sourceKind: row.sourceKind,
    sourceId: row.sourceId,
    metric: row.metric,
    runId: row.runId,
    occurredAt: row.occurredAt,
  };
}

/**
 * The query builder itself, NOT awaited — exported separately so its
 * compiled SQL (the ON CONFLICT clause IS the exactly-once contract) can be
 * asserted directly against the real schema/dialect in tests without
 * mocking `../../db` (repo's vacuous-Drizzle-assertion trap). `database`
 * defaults to the real ambient `db`; tests inject a stub to control the
 * resolved rows without touching a real connection.
 */
export function insertOpEvidenceQuery(
  rows: OpEvidenceInsert[],
  database: Pick<typeof db, 'insert'> = db,
) {
  return database
    .insert(aiAgentOpEvidence)
    .values(rows.map(toEvidenceValues))
    .onConflictDoNothing({
      target: [aiAgentOpEvidence.sourceKind, aiAgentOpEvidence.sourceId, aiAgentOpEvidence.metric],
    })
    .returning({ id: aiAgentOpEvidence.id });
}

/**
 * Inserts with ON CONFLICT (source_kind, source_id, metric) DO NOTHING and
 * returns how many rows were actually new (0 means every row in this batch
 * was already counted — never a partial-batch error).
 */
export async function insertOpEvidence(
  rows: OpEvidenceInsert[],
  database: Pick<typeof db, 'insert'> = db,
): Promise<number> {
  if (rows.length === 0) return 0;
  const inserted = await insertOpEvidenceQuery(rows, database);
  return inserted.length;
}

/**
 * The query builder for the single `verdict_feedback` row per verdict,
 * unexecuted — see `insertOpEvidenceQuery`'s doc comment for why. The
 * `targetWhere` predicate mirrors the schema's own partial-unique-index
 * predicate (`aiAgentOpEvidence.ts`'s `feedbackUq`) verbatim so Postgres can
 * infer the same index as the arbiter.
 */
export function upsertVerdictFeedbackEvidenceQuery(
  row: OpEvidenceInsert,
  database: Pick<typeof db, 'insert'> = db,
) {
  return database
    .insert(aiAgentOpEvidence)
    .values(toEvidenceValues(row))
    .onConflictDoUpdate({
      target: aiAgentOpEvidence.sourceId,
      targetWhere: sql`${aiAgentOpEvidence.sourceKind} = 'verdict_feedback'`,
      set: {
        metric: row.metric,
        occurredAt: row.occurredAt,
      },
    });
}

/**
 * The single `verdict_feedback` row for a verdict, upserted so a re-vote
 * flips `metric` in place (up <-> down) — never a negative delta, since
 * there is never more than one row to negate.
 */
export async function upsertVerdictFeedbackEvidence(
  row: OpEvidenceInsert,
  database: Pick<typeof db, 'insert'> = db,
): Promise<void> {
  await upsertVerdictFeedbackEvidenceQuery(row, database);
}

/** Stable source ids. Each is deterministic so a redelivered job recomputes
 *  the same value and the unique index absorbs it as an already-counted
 *  duplicate rather than double-inserting. */

export function intentEvidenceSourceId(intentId: string): string {
  return intentId;
}

/** A watch carries N `op_keys` and emits one row per key with the SAME
 *  metric — a bare watch id would collide on `(source_kind, source_id,
 *  metric)` and silently drop all but the first key, so the op key is part
 *  of the source id. */
export function watchEvidenceSourceId(watchId: string, opKey: string): string {
  return `${watchId}:${opKey}`;
}

/** `OutcomeExecutedAction.executionId` falls back to the literal
 *  `'(inline)'` when the execution-ledger write fails, so it is not unique
 *  within a run — the action's index in `outcome.executedActions` is. */
export function actEvidenceSourceId(runId: string, actionIndex: number): string {
  return `${runId}:${actionIndex}`;
}

export function verdictEvidenceSourceId(verdictId: string): string {
  return verdictId;
}
