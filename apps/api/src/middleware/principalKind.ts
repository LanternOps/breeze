/**
 * Principal-kind predicates (tool catalog W04, #5219). A LEAF module — type
 * imports only — so services that are reachable from worker entrypoints can
 * use them without pulling `middleware/auth.ts`'s runtime closure (see
 * services/workerEntrypointClosure.contract.test.ts). Re-exported from
 * `middleware/auth.ts`, which is where callers normally import them from.
 */
import type { AuthContext } from './auth';

export function isAiAgentPrincipal(auth: Pick<AuthContext, 'principal'>): boolean {
  return auth.principal?.kind === 'ai_agent';
}

/** A published flow's run (tool catalog W04, #5219). */
export function isFlowPrincipal(auth: Pick<AuthContext, 'principal'>): boolean {
  return auth.principal?.kind === 'flow';
}

/**
 * A machine principal acting as ITSELF with no human present: an AI agent run
 * or a flow run. Neither has a role, an RBAC token, a session MFA claim, an
 * interactive approval surface or a `users` row behind `auth.user.id` (that
 * id is a synthetic attribution identity). Use this — not the raw
 * `kind === 'ai_agent'` comparison — for every rule that means exactly that;
 * a rule that needs the agent's identity or run state stays agent-only and
 * refuses a flow explicitly. Every site is classified in
 * automationPrincipal.contract.test.ts.
 */
export function isAutomationPrincipal(auth: Pick<AuthContext, 'principal'>): boolean {
  return isAiAgentPrincipal(auth) || isFlowPrincipal(auth);
}
