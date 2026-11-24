/**
 * Tool-discovery ops counters (#12421 W01, spec §3.5).
 *
 * A LEAF module by construction — it imports `metricsRegistry` and nothing
 * else — so the worker role can serve /metrics without pulling the
 * route/db/service graph in (workerEntrypointClosure.contract.test.ts).
 *
 * Names are the spec's, verbatim, with the product `breeze_` prefix. No tool
 * label on either series: ~360 tools × statuses would blow the default
 * registry's cardinality (spec §3.5 option C). Per-tool numbers live in the
 * ai_tool_search_events / ai_tool_executions ledger and the report.
 */
import { Counter } from 'prom-client';

import { metricsRegistry } from './metricsRegistry';

const toolSearchTotal = new Counter({
  name: 'breeze_ai_tool_search_total',
  help: 'ToolSearch calls the chat model made, by whether the search returned any tool (hit) or none (empty)',
  labelNames: ['outcome'] as const,
  registers: [metricsRegistry],
});

const toolCallTotal = new Counter({
  name: 'breeze_ai_tool_call_total',
  help: 'Agent SDK tool calls whose ai_tool_executions row reached a terminal status, by that status',
  labelNames: ['status'] as const,
  registers: [metricsRegistry],
});

export function noteToolSearch(outcome: 'hit' | 'empty'): void {
  toolSearchTotal.inc({ outcome });
}

/** `status` is the terminal ledger value just written: completed | failed | rejected | refused. */
export function noteToolCall(status: string): void {
  toolCallTotal.inc({ status });
}

/**
 * Rows a Drizzle write on postgres.js touched: the driver's `RowList.count`
 * for a statement without RETURNING, the array length for one with it.
 * Anything else (a test double, an unexpected shape) is 0, so a counter fed
 * from this never counts a write it cannot see.
 */
export function affectedRowCount(result: unknown): number {
  if (result !== null && typeof result === 'object') {
    const count = (result as { count?: unknown }).count;
    if (typeof count === 'number' && Number.isFinite(count)) return count;
    if (Array.isArray(result)) return result.length;
  }
  return 0;
}
