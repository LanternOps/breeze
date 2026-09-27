/**
 * Request-path writers for fix_outcomes (AI Suggested Fixes W1). Run under the
 * caller's request RLS context (fix_outcomes is shape 1, the org's own rows).
 * Recording an attempt sits in its own SAVEPOINT (withDbTransaction) and never
 * throws: it must never undo or block a dispatched script.
 */
import { eq, sql } from 'drizzle-orm';
import { FIX_OUTCOME_WINDOWS, type FixOutcomeState, type FixVote } from '@breeze/shared';
import { db, withDbTransaction } from '../../db';
import { fixOutcomes, organizations, remediationSuggestions, scriptExecutions, scripts } from '../../db/schema';
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
      if (!org || !script) return null;
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
    return null;
  }
}
