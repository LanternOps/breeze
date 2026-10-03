/**
 * Request-path writers for fix_outcomes (AI Suggested Fixes W1). Run under the
 * caller's request RLS context (fix_outcomes is shape 1, the org's own rows).
 * Recording an attempt sits in its own SAVEPOINT (withDbTransaction) and never
 * throws: it must never undo or block a dispatched script.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { FIX_OUTCOME_WINDOWS, type FixOutcomeState, type FixVote, type ResearchBuiltinAction } from '@breeze/shared';
import { db, withDbTransaction } from '../../db';
import { fixOutcomes, organizations, remediationSuggestions, scriptExecutions, scripts } from '../../db/schema';
import { captureException } from '../sentry';
import { fixIdentityFor, fixKindForScript } from './aggregate';

type SourceType = 'alert' | 'anomaly' | 'correlation' | 'rca';
const HOUR_MS = 3_600_000;

export interface OutcomeSummary { state: FixOutcomeState; stateReason: string | null; humanVote: FixVote | null }

const summaryColumns = { state: fixOutcomes.state, stateReason: fixOutcomes.stateReason, humanVote: fixOutcomes.humanVote };

function toSummary(row: { state: FixOutcomeState; stateReason: string | null; humanVote: FixVote | null } | undefined): OutcomeSummary | null {
  return row ? { state: row.state, stateReason: row.stateReason ?? null, humanVote: row.humanVote ?? null } : null;
}

export async function recordExecutionOutcome(input: {
  suggestion: Pick<typeof remediationSuggestions.$inferSelect, 'id' | 'orgId' | 'sourceType' | 'sourceId' | 'alertId' | 'scriptId'>;
  deviceId: string;
  scriptExecutionId: string;
}): Promise<OutcomeSummary | null> {
  const { suggestion } = input;
  if (!suggestion.scriptId) return null;
  try {
    return await withDbTransaction(async () => {
      const [org] = await db.select({ partnerId: organizations.partnerId }).from(organizations)
        .where(eq(organizations.id, suggestion.orgId)).limit(1);
      const [script] = await db.select({ isSystem: scripts.isSystem, orgId: scripts.orgId, partnerId: scripts.partnerId })
        .from(scripts).where(eq(scripts.id, suggestion.scriptId!)).limit(1);
      if (!org || !script) {
        // ids only — never suggestion title/rationale/output, which may hold
        // customer text. A missing org/script means the outcome row is a
        // silent no-op; this is the only signal an operator gets of that.
        console.warn(
          `[fixMemory] cannot record attempt for suggestion ${suggestion.id}: `
          + `${!org ? `org ${suggestion.orgId} not found` : `script ${suggestion.scriptId} not found`}`,
        );
        return null;
      }
      const [execution] = await db.select({ scriptVersionId: scriptExecutions.scriptVersionId }).from(scriptExecutions)
        .where(eq(scriptExecutions.id, input.scriptExecutionId)).limit(1);
      const scriptVersionId = execution?.scriptVersionId ?? null;
      const fixKind = fixKindForScript(script);
      const now = new Date();
      const [row] = await db.insert(fixOutcomes).values({
        orgId: suggestion.orgId,
        partnerId: org.partnerId,
        deviceId: input.deviceId,
        suggestionId: suggestion.id,
        sourceType: suggestion.sourceType as SourceType,
        sourceId: suggestion.sourceId,
        alertId: suggestion.alertId,
        fixKind,
        fixIdentity: fixIdentityFor({ fixKind, scriptVersionId }),
        scriptId: suggestion.scriptId,
        scriptVersionId,
        scriptExecutionId: input.scriptExecutionId,
        state: 'pending',
        deadlineAt: new Date(now.getTime() + FIX_OUTCOME_WINDOWS.pendingTimeoutHours * HOUR_MS),
      }).onConflictDoNothing({ target: fixOutcomes.suggestionId, where: sql`suggestion_id IS NOT NULL` })
        .returning(summaryColumns);
      return toSummary(row);
    });
  } catch (err) {
    console.error(`[fixMemory] could not record the attempt for suggestion ${suggestion.id}:`, err);
    captureException(err, undefined, { component: 'fixMemory.outcomeRecorder' });
    return null;
  }
}

/**
 * A built-in action attempt (W2). It follows the queued command, or the
 * OS-native cleanup run for disk_cleanup; the watcher reads those, not a script
 * execution. Aggregates by action (fix_identity 'builtin:<action>'). Called only
 * after a successful dispatch: a refused dispatch never gets an outcome row.
 * Same SAVEPOINT + never-throws contract as recordExecutionOutcome.
 */
export async function recordBuiltinOutcome(input: {
  suggestion: Pick<typeof remediationSuggestions.$inferSelect, 'id' | 'orgId' | 'sourceType' | 'sourceId' | 'alertId' | 'builtinAction'>;
  deviceId: string;
  commandId: string;
  cleanupRunId: string | null;
}): Promise<OutcomeSummary | null> {
  const { suggestion } = input;
  const action = suggestion.builtinAction as ResearchBuiltinAction | null;
  if (!action) return null;
  try {
    return await withDbTransaction(async () => {
      const [org] = await db.select({ partnerId: organizations.partnerId }).from(organizations)
        .where(eq(organizations.id, suggestion.orgId)).limit(1);
      if (!org) {
        console.warn(`[fixMemory] cannot record built-in attempt for suggestion ${suggestion.id}: org ${suggestion.orgId} not found`);
        return null;
      }
      const now = new Date();
      const [row] = await db.insert(fixOutcomes).values({
        orgId: suggestion.orgId,
        partnerId: org.partnerId,
        deviceId: input.deviceId,
        suggestionId: suggestion.id,
        sourceType: suggestion.sourceType as SourceType,
        sourceId: suggestion.sourceId,
        alertId: suggestion.alertId,
        fixKind: 'builtin_action',
        fixIdentity: fixIdentityFor({ fixKind: 'builtin_action', builtinAction: action }),
        builtinAction: action,
        actionCommandId: input.commandId,
        actionCleanupRunId: input.cleanupRunId,
        state: 'pending',
        deadlineAt: new Date(now.getTime() + FIX_OUTCOME_WINDOWS.pendingTimeoutHours * HOUR_MS),
      }).onConflictDoNothing({ target: fixOutcomes.suggestionId, where: sql`suggestion_id IS NOT NULL` })
        .returning(summaryColumns);
      return toSummary(row);
    });
  } catch (err) {
    console.error(`[fixMemory] could not record the built-in attempt for suggestion ${suggestion.id}:`, err);
    captureException(err, undefined, { component: 'fixMemory.outcomeRecorder' });
    return null;
  }
}

/**
 * A re-vote replaces the earlier one (spec). recount_requested_at asks the
 * sweeper to recompute; if a recount of this row is in flight, this UPDATE
 * waits on its row lock (store.recomputeForOutcome) and re-requests after it.
 */
export async function recordOutcomeVote(input: { suggestionId: string; orgId: string; vote: FixVote; userId: string }): Promise<OutcomeSummary | null> {
  const now = new Date();
  const [row] = await db.update(fixOutcomes).set({
    humanVote: input.vote, votedBy: input.userId, votedAt: now, recountRequestedAt: now, updatedAt: now,
  }).where(and(eq(fixOutcomes.suggestionId, input.suggestionId), eq(fixOutcomes.orgId, input.orgId)))
    .returning(summaryColumns);
  return toSummary(row);
}

/**
 * Done on manual steps: the attempt starts at awaiting_recovery (spec).
 * Reviewed steps (W2: `instructionsId` names an active fix_instructions row)
 * get a shareable identity and aggregate partner-wide; AI-written steps never
 * do (fix_identity NULL): they are watched and votable but not shared memory.
 */
export async function createManualStepsOutcome(input: {
  suggestion: Pick<typeof remediationSuggestions.$inferSelect, 'id' | 'orgId' | 'sourceType' | 'sourceId' | 'alertId'>;
  deviceId: string;
  instructionsId?: string | null;
}): Promise<OutcomeSummary | null> {
  const [org] = await db.select({ partnerId: organizations.partnerId }).from(organizations)
    .where(eq(organizations.id, input.suggestion.orgId)).limit(1);
  if (!org) return null;
  const now = new Date();
  const instructionsRef = input.instructionsId ?? null;
  const [row] = await db.insert(fixOutcomes).values({
    orgId: input.suggestion.orgId,
    partnerId: org.partnerId,
    deviceId: input.deviceId,
    suggestionId: input.suggestion.id,
    sourceType: input.suggestion.sourceType as SourceType,
    sourceId: input.suggestion.sourceId,
    alertId: input.suggestion.alertId,
    fixKind: 'manual_steps',
    instructionsRef,
    fixIdentity: fixIdentityFor({ fixKind: 'manual_steps', instructionsRef }),
    state: 'awaiting_recovery',
    stateReason: 'manual_steps_done',
    deadlineAt: new Date(now.getTime() + FIX_OUTCOME_WINDOWS.recoveryTimeoutHours * HOUR_MS),
  }).onConflictDoNothing({ target: fixOutcomes.suggestionId, where: sql`suggestion_id IS NOT NULL` })
    .returning(summaryColumns);
  return toSummary(row);
}

export async function loadOutcomeSummaries(suggestionIds: readonly string[]): Promise<Map<string, OutcomeSummary>> {
  const map = new Map<string, OutcomeSummary>();
  if (suggestionIds.length === 0) return map;
  const rows = await db.select({ suggestionId: fixOutcomes.suggestionId, ...summaryColumns }).from(fixOutcomes)
    .where(inArray(fixOutcomes.suggestionId, [...suggestionIds]));
  for (const r of rows) {
    const summary = toSummary(r);
    if (r.suggestionId && summary) map.set(r.suggestionId, summary);
  }
  return map;
}
