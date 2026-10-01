/**
 * Agent policy model → registry offering, at WRITE time (AI model registry
 * W03, W02 handoff #5, spec §5.6, quorum #11). W02's projection mapped
 * `ai_agents.model` to `ai_agents.offering_id` once per partner at cutover
 * (Task 6A) and never again, so after cutover the policy write path owns
 * `offering_id`: an edited `model` that were not bound here would be silently
 * ignored at run time.
 *
 * The run-time resolver still re-checks the bound offering against the
 * `ai_agents` permitted set at admission and dispatch, because that set can
 * narrow after the write.
 */
import { runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { getEffectiveAssignment, isPermitted } from '../aiModels/assignments';
import { findOfferingIdByModel, readOrgPartnerId } from '../aiModels/candidateLoader';
import { ensurePartnerCutover } from '../aiModels/registryCutover';
import { AgentModelNotAllowedError } from './agentModelErrors';

export { AgentModelNotAllowedError } from './agentModelErrors';

/** The owner of an agent row (`ai_agents` is org XOR partner owned). */
export interface AgentModelOwner {
  orgId: string | null;
  partnerId: string | null;
}

export interface AgentModelBinding {
  model: string | null;
  offeringId: string | null;
  offeringPartnerId: string | null;
}

/**
 * `model: null` clears both columns, so the agent follows the `ai_agents`
 * assignment. Otherwise the string must name an enabled offering on the
 * `ai_agents` DEFAULT connection (never another connection: that would move
 * destination and funding) that the owner's effective permitted set admits —
 * a partner-wide agent is checked against the partner assignment, an org
 * agent against the merged one. Throws AgentModelNotAllowedError (nothing
 * written). Reads only registry tables, on its own pooled connection; never
 * call it under an `ai_agents` row lock (the cutover it may run rebinds
 * `ai_agents` rows).
 */
export async function bindAgentModel(owner: AgentModelOwner, model: string | null): Promise<AgentModelBinding> {
  if (model === null) return { model: null, offeringId: null, offeringPartnerId: null };
  const notAvailable = () => new AgentModelNotAllowedError(`Model "${model}" is not available for AI agents.`, 'invalid_model');
  const partnerId = owner.partnerId ?? (owner.orgId ? await readOrgPartnerId(owner.orgId) : null);
  if (!partnerId) throw notAvailable();
  if (!(await ensurePartnerCutover(partnerId))) {
    throw new AgentModelNotAllowedError('AI configuration is being upgraded. Try again in a moment.', 'registry_unavailable');
  }
  const offeringId = await findOfferingIdByModel({ partnerId, orgId: owner.orgId, surface: 'ai_agents', modelId: model });
  if (!offeringId) throw notAvailable();
  // System context: an org-scoped request cannot see the partner-level rows
  // the merge starts from (same as resolveModel).
  const assignment = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
    getEffectiveAssignment({ partnerId, orgId: owner.orgId, surface: 'ai_agents' })));
  if (!isPermitted(assignment.permitted, offeringId)) {
    throw new AgentModelNotAllowedError('This AI model is not permitted for AI agents here. Choose another model.', 'not_permitted');
  }
  return { model, offeringId, offeringPartnerId: partnerId };
}
