/**
 * The execution as status readers see it. `results.definition` is the group
 * definition the execution worker runs (drExecutionService.ts); it stays in
 * storage and out of API, AI-tool and dashboard responses, which already carry
 * per-group results.
 */
export function drExecutionView<T extends { results?: unknown }>(execution: T): T {
  const results = execution.results;
  if (!results || typeof results !== 'object' || Array.isArray(results)) return execution;
  const { definition: _definition, ...visible } = results as Record<string, unknown>;
  return { ...execution, results: visible };
}
