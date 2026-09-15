/**
 * Reports count intent id if present, else script execution id, else the row
 * id, else runId:actionIndex. Inline executionId may be '(inline)' and is not
 * unique. Execution frequency is not recurrence: recovery-bounded episodes
 * belong to fix watches/alerts, not this identity helper.
 */
export type RemediationRepresentation =
  | { source: 'action_intent'; intentId: string }
  | { source: 'script_execution'; executionId: string; intentId: string | null }
  | { source: 'automation_action_result'; resultId: string; scriptExecutionId: string | null }
  | { source: 'agent_executed_action'; runId: string; actionIndex: number };

export function canonicalRemediationId(r: RemediationRepresentation): string {
  switch (r.source) {
    case 'action_intent': return `action_intent:${r.intentId}`;
    case 'script_execution': return r.intentId ? `action_intent:${r.intentId}` : `script_execution:${r.executionId}`;
    case 'automation_action_result': return r.scriptExecutionId ? `script_execution:${r.scriptExecutionId}` : `automation_action_result:${r.resultId}`;
    case 'agent_executed_action': return `agent_executed_action:${r.runId}:${r.actionIndex}`;
  }
}

/** Resolve script→intent links across the entire batch before retaining its
 * first representation. A result alone cannot reveal its script's intent. */
export function dedupeRemediations<T extends { representation: RemediationRepresentation }>(rows: T[]): T[] {
  const scriptIntents = new Map<string, string>();
  for (const { representation: r } of rows) {
    if (r.source === 'script_execution' && r.intentId) {
      scriptIntents.set(`script_execution:${r.executionId}`, `action_intent:${r.intentId}`);
    }
  }
  const seen = new Set<string>();
  return rows.filter(({ representation }) => {
    const id = canonicalRemediationId(representation);
    const resolved = scriptIntents.get(id) ?? id;
    if (seen.has(resolved)) return false;
    seen.add(resolved);
    return true;
  });
}
