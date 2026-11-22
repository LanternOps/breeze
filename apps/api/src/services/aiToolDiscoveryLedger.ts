// Turn-end write of tool-discovery telemetry (#12421 W01).
//
// One call per chat turn, after settlement: one `turn` row plus one `search`
// row per ToolSearch into ai_tool_search_events, then a reconcile of
// ai_tool_executions.discovery by (session_id, tool_use_id) — the hooks stamp
// it provisionally at insert, and only the turn end sees the whole turn
// (plan Decision 7).
//
// Failure isolation (docs/agents/tenancy-rls.md, #11203): the statements run
// in their own `withDbTransaction` inside an org context, with the catch
// OUTSIDE both, so a failed statement rolls back to the savepoint instead of
// poisoning whatever context the caller holds. The caller awaits this alone,
// never beside siblings in a Promise.all. A failure is returned, never thrown:
// telemetry never fails the turn.

import { and, eq, sql } from 'drizzle-orm';
import { db, withDbAccessContext, withDbTransaction } from '../db';
import { aiToolExecutions, aiToolSearchEvents } from '../db/schema';
import { safeErrorMessage } from './aiModels/safeDbError';
import { redactAiToolOutputText } from './aiToolOutput';
import { noteToolSearch } from './aiToolDiscoveryMetrics';
import {
  boundQuery,
  type DiscoverySearchEvent,
  type DiscoveryTurnSummary,
  type ToolDiscovery,
} from './aiToolDiscoveryObserver';

export interface TurnDiscoveryWrite {
  sessionId: string;
  orgId: string;
  turnMessageId: string | null;
  surface: string;
  surfaceFingerprint: string;
  events: DiscoverySearchEvent[];
  turn: DiscoveryTurnSummary;
  reconcile: ReadonlyMap<string, ToolDiscovery>;
}

export type TurnDiscoveryOutcome =
  | { ok: true; rows: number; reconciled: number }
  | { ok: false; error: string };

type SearchEventInsert = typeof aiToolSearchEvents.$inferInsert;

function buildRows(write: TurnDiscoveryWrite): SearchEventInsert[] {
  const common = {
    sessionId: write.sessionId,
    turnMessageId: write.turnMessageId,
    surface: write.surface,
    surfaceFingerprint: write.surfaceFingerprint,
  };
  const searches: SearchEventInsert[] = write.events.map((e) => ({
    ...common,
    kind: 'search',
    toolUseId: e.toolUseId.slice(0, 100),
    roundTripId: e.roundTripId?.slice(0, 100) ?? null,
    // Redact FIRST, then bound: a redaction can lengthen the text past the
    // 1,024-byte CHECK, and a cut can split a token the redactor would catch.
    query: boundQuery(redactAiToolOutputText(e.query)),
    maxResults: e.maxResults,
    selectMode: e.selectMode,
    resultToolNames: e.resultToolNames,
    calledToolNames: e.calledToolNames,
    totalDeferred: e.totalDeferred,
    empty: e.empty,
  }));
  const turn: SearchEventInsert = {
    ...common,
    kind: 'turn',
    searches: write.turn.searches,
    searchOnlyRoundTrips: write.turn.searchOnlyRoundTrips,
    workRoundTrips: write.turn.workRoundTrips,
    firstCallAfterSearches: write.turn.firstCallAfterSearches,
    aborted: write.turn.aborted,
  };
  return [...searches, turn];
}

export async function persistTurnDiscovery(write: TurnDiscoveryWrite): Promise<TurnDiscoveryOutcome> {
  // The counter reflects what the model saw, whether or not the rows land.
  for (const e of write.events) noteToolSearch(e.empty ? 'empty' : 'hit');

  const { sessionId, orgId } = write;
  let reconciled = 0;
  try {
    const rows = buildRows(write);
    await withDbAccessContext({ scope: 'organization', orgId, accessibleOrgIds: [orgId] }, () =>
      withDbTransaction(async () => {
        await db.insert(aiToolSearchEvents).values(rows);
        // Sequential on purpose: one connection, at most one statement per
        // call of the turn, never a Promise.all inside a savepoint.
        for (const [toolUseId, discovery] of write.reconcile) {
          const changed = await db
            .update(aiToolExecutions)
            .set({ discovery })
            .where(and(
              eq(aiToolExecutions.sessionId, sessionId),
              eq(aiToolExecutions.toolUseId, toolUseId),
              sql`${aiToolExecutions.discovery} IS DISTINCT FROM ${discovery}`,
            ))
            .returning({ id: aiToolExecutions.id });
          reconciled += changed.length;
        }
      }),
    );
    return { ok: true, rows: write.events.length + 1, reconciled };
  } catch (err) {
    // OUTSIDE both wrappers. safeErrorMessage: Drizzle's message carries the
    // statement's parameters, i.e. the query text.
    return { ok: false, error: safeErrorMessage(err) };
  }
}
