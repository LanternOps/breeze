/**
 * `IMPACT_FIX_TOOLS` — the frozen set of MCP tool names whose agent-originated
 * intents / proposals count as a "fix" in the impact rollup (P2-6).
 *
 * Positive by construction: a negative exclusion list would silently classify
 * every future unrelated tool as a fix the day it is added. Pinned by
 * `impactFixTools.contract.test.ts` to `ACT_ELIGIBLE_TOOL_NAMES` (`actManifest.ts`)
 * union every `POLICY_DECIDABLE_TIER3` entry's `toolName` (`policyDecidable.ts`)
 * — grow this literal only when that union grows, and grow it deliberately: a
 * new remediation tool becoming fix-eligible is a conscious decision about what
 * counts as customer value, not a side effect of another registry changing.
 *
 * `remediation_suggestion` is deliberately absent. It is `ACT_MANIFEST`'s
 * virtual sentinel entry — never a real registered MCP tool — and
 * `ACT_ELIGIBLE_TOOL_NAMES` already filters it out (`actManifest.ts:269-281`).
 * Because it can never be dispatched, it can never appear as an
 * `action_intents.action_name` or an `outcome.proposedActions[].tool`, so
 * including it here would count a value that no row can ever actually carry.
 */
export const IMPACT_FIX_TOOLS: readonly string[] = Object.freeze([
  'disk_cleanup',
  'execute_playbook',
  'manage_scheduled_tasks',
  'manage_services',
  'manage_startup_items',
  'run_script',
  'security_scan',
]);

/** The same value as a Postgres text[] literal parameter for the rollup SQL. */
export function impactFixToolsArray(): string[] {
  return [...IMPACT_FIX_TOOLS];
}
