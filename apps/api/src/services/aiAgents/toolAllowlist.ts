// apps/api/src/services/aiAgents/toolAllowlist.ts
/**
 * The ONE implementation of the agent tool-allowlist matching rule, shared by
 * every run-derived call site that has to answer "may this agent call this
 * tool?" outside the guardrail's own dispatch path.
 *
 * The rule: an entry admits a call when it is either the BARE tool name
 * (`manage_services` — every action of that tool) or the specific
 * `tool:action` pair (`manage_services:restart` — that action only). It is
 * matched against the run's stored `policySnapshot.effective.toolAllowlist`,
 * never a live re-resolution, so a policy edit mid-run cannot retroactively
 * widen what the run was admitted to do.
 *
 * Extracted in P2-2 (Task A7, review round 1) because two files had grown
 * their own copy of the same two-way `includes` check —
 * `alertVerdicts.ts`'s suggestion gate (P2-1) and `sweepFindings.ts`'s
 * proposal gate (P2-2) — and a third copy was about to appear. Both gate
 * whether a model-proposed mutation may become a human-approvable intent at
 * all, and RELEASE time (`agentReleaseAuthority.ts`) re-runs
 * `checkAgentGuardrails` with this SAME effective allowlist: the two must
 * agree, or a human gets asked to approve something that can never release.
 *
 * DELIBERATELY NOT imported by `aiGuardrails.ts`, which keeps its own inline
 * copy. That file is a frozen contract surface (`redTeam.contract.test.ts`
 * and friends pin its behaviour directly); rewiring it to a shared helper
 * would put a second module in the dispatch path's blast radius for no
 * behavioural gain. This helper's job is to stop the NON-contract call sites
 * from drifting apart from it — the contract file is the thing they are
 * being kept in agreement with, not another copy to be refactored.
 */

/**
 * `action` is optional: a tool with no action discriminator (the sweep union's
 * `remediate_vulnerability`, for instance) can only ever be admitted by a bare
 * entry, and passing `undefined`/`null` expresses exactly that rather than
 * fabricating an action string to match on.
 */
export function isToolAllowlisted(
  toolAllowlist: readonly string[],
  tool: string,
  action?: string | null,
): boolean {
  if (toolAllowlist.includes(tool)) return true;
  return action != null && toolAllowlist.includes(`${tool}:${action}`);
}
