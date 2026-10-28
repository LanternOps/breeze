/**
 * Tool Catalog W05 (#5220), plan Decision 12/14 — the per-run caps of the
 * capped built-ins (`notify` ≤ 20, `http_request` ≤ 100 per run).
 *
 * Counted from the run's own ledger, so the cap survives slices, resumes and
 * the release worker: every attempt of a capped step inserts its
 * `flow_run_steps` row (status `running`, or `awaiting_approval` for a parked
 * one) BEFORE it executes, so the count includes the call being made. Skipped
 * rows (`when` false) never sent anything and are not counted. Parallel items
 * and a crashed attempt's row can only make the count higher — the cap errs
 * towards refusing, never towards an extra call.
 */
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../../db';
import { flowRunSteps } from '../../../db/schema';

export interface BuiltinCallCounts {
  notify: number;
  http: number;
}

export async function countRunBuiltinCalls(runId: string): Promise<BuiltinCallCounts> {
  const rows = await runOutsideDbContext(() => withSystemDbAccessContext(
    async () => db
      .select({ tool: flowRunSteps.tool, n: sql<number>`count(*)::int` })
      .from(flowRunSteps)
      .where(and(
        eq(flowRunSteps.runId, runId),
        eq(flowRunSteps.toolSource, 'builtin'),
        inArray(flowRunSteps.tool, ['notify', 'http_request']),
        ne(flowRunSteps.status, 'skipped'),
      ))
      .groupBy(flowRunSteps.tool),
    'flows.builtins.countRunBuiltinCalls',
  ));
  const of = (tool: string) => Number(rows.find((r) => r.tool === tool)?.n ?? 0);
  return { notify: of('notify'), http: of('http_request') };
}
