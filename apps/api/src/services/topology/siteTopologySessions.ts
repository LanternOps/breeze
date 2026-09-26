import { and, eq, inArray } from 'drizzle-orm';

import type { db } from '../../db';
import { aiActionPlans, aiMessages, aiScreenshots, aiSessions, aiToolExecutions } from '../../db/schema';

type Executor = Pick<typeof db, 'select' | 'delete'>;

export type SiteTopologyAiSessionCleanup = {
  /** Topology investigation sessions (named so audit redaction of `session*` keys keeps the count). */
  investigations: number;
  messages: number;
  toolExecutions: number;
  actionPlans: number;
  screenshots: number;
};

/**
 * Topology M4-D2 (#6000): a topology investigation session is pinned to ONE
 * site by `ai_sessions.topology_site_id` — a same-scope FK with NO ON DELETE
 * action, so the pin can never be silently cleared or re-scoped. Deleting the
 * site therefore deletes that site's topology investigations with it (their
 * transcripts only ever described that site), inside the caller's site-delete
 * transaction, children first:
 *
 *   ai_tool_executions (→ ai_messages, ai_sessions) → ai_messages →
 *   ai_action_plans → ai_screenshots → ai_sessions
 *
 * Every other reference to an ai_sessions row (script executions, agent runs,
 * budget reservations, script proposals, run artifacts, approval requests'
 * execution id) is ON DELETE SET NULL and keeps its own history. General
 * (unpinned) sessions are never touched. Returns the per-table counts for the
 * caller's audit row.
 */
export async function deleteSiteTopologyAiSessions(
  executor: Executor,
  scope: { orgId: string; siteId: string },
): Promise<SiteTopologyAiSessionCleanup> {
  const rows = await executor
    .select({ id: aiSessions.id })
    .from(aiSessions)
    .where(and(eq(aiSessions.orgId, scope.orgId), eq(aiSessions.topologySiteId, scope.siteId)));
  const ids = rows.map((row) => row.id);
  if (ids.length === 0) return { investigations: 0, messages: 0, toolExecutions: 0, actionPlans: 0, screenshots: 0 };

  const toolExecutions = await executor.delete(aiToolExecutions)
    .where(inArray(aiToolExecutions.sessionId, ids)).returning({ id: aiToolExecutions.id });
  const messages = await executor.delete(aiMessages)
    .where(inArray(aiMessages.sessionId, ids)).returning({ id: aiMessages.id });
  const actionPlans = await executor.delete(aiActionPlans)
    .where(inArray(aiActionPlans.sessionId, ids)).returning({ id: aiActionPlans.id });
  const screenshots = await executor.delete(aiScreenshots)
    .where(inArray(aiScreenshots.sessionId, ids)).returning({ id: aiScreenshots.id });
  const sessions = await executor.delete(aiSessions)
    .where(and(eq(aiSessions.orgId, scope.orgId), eq(aiSessions.topologySiteId, scope.siteId), inArray(aiSessions.id, ids)))
    .returning({ id: aiSessions.id });

  return {
    investigations: sessions.length,
    messages: messages.length,
    toolExecutions: toolExecutions.length,
    actionPlans: actionPlans.length,
    screenshots: screenshots.length,
  };
}
