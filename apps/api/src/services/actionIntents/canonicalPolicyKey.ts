import { resolveActionForTool } from '../aiGuardrails';

/**
 * The canonical POLICY_DECIDABLE_TIER3 key for a stored intent's action —
 * derived EXACTLY the way checkGuardrails/checkAgentGuardrails resolve the
 * sub-operation (aiGuardrails.ts's `resolveActionForTool`), never a second
 * ad hoc parse of `arguments`.
 *
 * Moved out of `policyDecide.ts` (P2-5, #4192, Deviation #2) into this leaf
 * module — which imports ONLY `resolveActionForTool` from `aiGuardrails.ts`
 * — so the release worker and the evidence writers (`opEvidence.ts`) can
 * share this ONE definition without dragging `policyDecide.ts`'s own graph
 * (the exposure ledger, the kill-state reader, `attemptPolicyDecision`)
 * along with it. `policyDecide.ts` imports this back in.
 */
export function canonicalPolicyKey(actionName: string, args: Record<string, unknown>): string {
  const action = resolveActionForTool(actionName, args);
  return action ? `${actionName}:${action}` : actionName;
}
