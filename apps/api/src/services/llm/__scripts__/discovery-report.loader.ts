/**
 * Database loader for discovery-report.ts (#12421 W01). Kept apart so the CLI
 * module imports no database. A script holds no DB context, so reads run under
 * `withSystemDbAccessContext` (no `runOutsideDbContext` needed). Only the
 * columns `DiscoveryReportInput` needs are selected.
 */
import { and, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../../db';
import { aiMessages, aiSessions, aiToolExecutions, aiToolSearchEvents } from '../../../db/schema/ai';
import { isMcpInputValidationErrorText } from '../../aiSessionAutoFlag';
import type { LoadedDiscoveryInput } from './discovery-report';

const SESSION_CHUNK = 500;

export async function loadDiscoveryInput(opts: { orgId?: string; since: Date; until: Date }): Promise<LoadedDiscoveryInput> {
  return withSystemDbAccessContext(async () => {
    const orgSessions = opts.orgId
      ? db.select({ id: aiSessions.id }).from(aiSessions).where(eq(aiSessions.orgId, opts.orgId))
      : null;

    const searchEvents = await db
      .select()
      .from(aiToolSearchEvents)
      .where(and(
        gte(aiToolSearchEvents.createdAt, opts.since),
        lte(aiToolSearchEvents.createdAt, opts.until),
        orgSessions ? inArray(aiToolSearchEvents.sessionId, orgSessions) : undefined,
      ));

    const executions = await db
      .select({
        id: aiToolExecutions.id,
        sessionId: aiToolExecutions.sessionId,
        toolName: aiToolExecutions.toolName,
        status: aiToolExecutions.status,
        errorMessage: aiToolExecutions.errorMessage,
        discovery: aiToolExecutions.discovery,
        toolUseId: aiToolExecutions.toolUseId,
        toolInput: aiToolExecutions.toolInput,
        createdAt: aiToolExecutions.createdAt,
      })
      .from(aiToolExecutions)
      .where(and(
        gte(aiToolExecutions.createdAt, opts.since),
        lte(aiToolExecutions.createdAt, opts.until),
        orgSessions ? inArray(aiToolExecutions.sessionId, orgSessions) : undefined,
      ));

    const userTurns = await db
      .select({ sessionId: aiMessages.sessionId, messageId: aiMessages.id, createdAt: aiMessages.createdAt })
      .from(aiMessages)
      .where(and(
        eq(aiMessages.role, 'user'),
        gte(aiMessages.createdAt, opts.since),
        lte(aiMessages.createdAt, opts.until),
        orgSessions ? inArray(aiMessages.sessionId, orgSessions) : undefined,
      ));

    const dropRows = await db
      .select({
        sessionId: aiMessages.sessionId,
        toolName: aiMessages.toolName,
        toolUseId: aiMessages.toolUseId,
        createdAt: aiMessages.createdAt,
        discovery: sql<string | null>`${aiMessages.toolOutput}->>'discovery'`,
        error: sql<string | null>`${aiMessages.toolOutput}->>'error'`,
      })
      .from(aiMessages)
      .where(and(
        eq(aiMessages.role, 'tool_result'),
        sql`${aiMessages.toolOutput}->>'droppedBeforeExecution' = 'true'`,
        sql`${aiMessages.toolOutput}->'unknownTool' IS NULL`,
        gte(aiMessages.createdAt, opts.since),
        lte(aiMessages.createdAt, opts.until),
        orgSessions ? inArray(aiMessages.sessionId, orgSessions) : undefined,
      ));
    const droppedResults = dropRows.map((r) => ({
      sessionId: r.sessionId,
      toolName: r.toolName ?? 'unknown',
      toolUseId: r.toolUseId,
      discovery: r.discovery,
      createdAt: r.createdAt,
      inputValidation: isMcpInputValidationErrorText(r.error ?? ''),
    }));

    const sessionIds = [...new Set([
      ...searchEvents.map((e) => e.sessionId),
      ...executions.map((e) => e.sessionId),
      ...userTurns.map((u) => u.sessionId),
      ...droppedResults.map((d) => d.sessionId),
    ])];
    const sessions: Array<{ id: string; orgId: string }> = [];
    for (let i = 0; i < sessionIds.length; i += SESSION_CHUNK) {
      sessions.push(...await db
        .select({ id: aiSessions.id, orgId: aiSessions.orgId })
        .from(aiSessions)
        .where(inArray(aiSessions.id, sessionIds.slice(i, i + SESSION_CHUNK))));
    }

    return {
      searchEvents,
      executions,
      droppedResults,
      turnRows: searchEvents.filter((e) => e.kind === 'turn'),
      userTurns,
      sessions,
    };
  }, 'discovery-report');
}
