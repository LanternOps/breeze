/**
 * Task 13 (#5051 review) — the ONE outcome rule, shared between
 * `apps/api/src/services/aiAgents/agentPreview.ts` (`resolveOutcome`) and
 * `apps/web/src/components/settings/aiAgents/capabilityModel.ts`
 * (`outcomeFor`), which used to carry byte-identical copies. Both computed
 * the same three-way split of what happens when a policy-decidable operation
 * actually runs — this is the single place that decides it now, so the
 * server's preview and the web picker's summary can never drift.
 *
 * `mode === 'act' && op.actEligible` -> `unattended` (the run loop actually
 * dispatches it without a human, per `ACT_MANIFEST`); otherwise the
 * guardrail tier decides whether a human approves it up front (tier 3,
 * `approval_request`) or it is logged as an already-applied proposal (tier
 * 1/2, `logged_proposal`).
 */

export type AgentOutcome = 'approval_request' | 'logged_proposal' | 'unattended';

export function outcomeFor(
  op: { tier: 1 | 2 | 3; actEligible: boolean },
  mode: 'off' | 'shadow' | 'act',
): AgentOutcome {
  if (mode === 'act' && op.actEligible) return 'unattended';
  return op.tier === 3 ? 'approval_request' : 'logged_proposal';
}
