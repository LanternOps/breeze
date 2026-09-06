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
 *
 * Script gate (#5048 QA follow-up): `run_script` is in `ACT_MANIFEST`, but the
 * run loop only dispatches it unattended for a script listed in the agent's
 * `actAssets.scriptIds` (`remediationActResolver.ts`, and
 * `agentService.ts`'s `hasActEligibleSurface`). An operation whose catalog
 * entry sets `actRequiresAuthorizedScripts` is therefore `unattended` only
 * when `context.authorizedScriptCount > 0`; with none authorized it is a
 * plain approval request, and `unattendedBlockedBy` names why so the picker
 * and review card can say so instead of promising an outcome that cannot
 * happen. The default context (no authorized scripts) is what the guided
 * create flow sees — it never sets `scriptIds`.
 */

export type AgentOutcome = 'approval_request' | 'logged_proposal' | 'unattended';

/** The one prerequisite an act-eligible operation can still be missing. */
export type UnattendedBlocker = 'authorized_scripts';

export interface AgentOutcomeOperation {
  tier: 1 | 2 | 3;
  actEligible: boolean;
  /** Absent on an older catalog build = `false`. */
  actRequiresAuthorizedScripts?: boolean;
}

export interface AgentOutcomeContext {
  /** `actAssets.scriptIds.length` for the row/draft being evaluated. */
  authorizedScriptCount: number;
}

const NO_ASSETS: AgentOutcomeContext = { authorizedScriptCount: 0 };

export function unattendedBlockedBy(
  op: AgentOutcomeOperation,
  mode: 'off' | 'shadow' | 'act',
  context: AgentOutcomeContext = NO_ASSETS,
): UnattendedBlocker | null {
  if (mode !== 'act' || !op.actEligible) return null;
  if (op.actRequiresAuthorizedScripts && context.authorizedScriptCount === 0) return 'authorized_scripts';
  return null;
}

export function outcomeFor(
  op: AgentOutcomeOperation,
  mode: 'off' | 'shadow' | 'act',
  context: AgentOutcomeContext = NO_ASSETS,
): AgentOutcome {
  if (mode === 'act' && op.actEligible && unattendedBlockedBy(op, mode, context) === null) return 'unattended';
  return op.tier === 3 ? 'approval_request' : 'logged_proposal';
}
