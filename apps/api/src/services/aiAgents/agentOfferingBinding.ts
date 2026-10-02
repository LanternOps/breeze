/**
 * Agent policy model, by OFFERING (AI model registry W05, #7603; spec §5.6,
 * quorum #11). Checked at WRITE against the `ai_agents` permitted set and
 * every eligibility rule — including `required_permission`, judged for the
 * WRITER: a run skips it (spec §9 step 2, "the admin chose the model"), so the
 * write is where a premium model is gated. STRICT: the chosen offering itself
 * must pass; there is no bounded fallback to the default (Codex review finding
 * 18 — a fallback would turn a 403 into a silent success). The run re-checks
 * the permitted set and the other rules (W03 Task 12).
 *
 * Call it OUTSIDE any `ai_agents` row lock: it reads the registry in its own
 * short system transactions and may run the partner's one-time cutover, which
 * rebinds `ai_agents` rows (Codex review finding 6).
 */
import { runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { getEffectiveAssignment, isPermitted } from '../aiModels/assignments';
import { loadOfferingCandidate, readOrgPartnerId } from '../aiModels/candidateLoader';
import { checkEligibility } from '../aiModels/eligibility';
import { ensurePartnerCutover } from '../aiModels/registryCutover';
import { eligibilityContextFor, unavailableMessage } from '../aiModels/resolveModel';
import { defaultTransport } from '../aiModels/transport';
import type { AgentModelBinding, AgentModelOwner } from './agentModelBinding';
import { AgentModelNotAllowedError } from './agentModelErrors';

/** The human making the policy write; their permissions gate a premium offering. */
export interface AgentPolicyWriter {
  userId: string;
}

// One message for "missing", "another partner's" and "ownership mismatch":
// the answer never reveals whether an offering id exists elsewhere.
const UNAVAILABLE = 'This AI model is not available for AI agents. Choose another model.';

/**
 * `offeringId: null` clears the binding (the agent follows the `ai_agents`
 * assignment default). Otherwise the offering must be the owner partner's,
 * the assignment default or in the owner's effective permitted set (a
 * partner-wide agent: the partner assignment; an org agent: the merged one),
 * and pass every eligibility rule for `writer`. Throws
 * AgentModelNotAllowedError; nothing is written by this function.
 */
export async function bindAgentOffering(
  owner: AgentModelOwner,
  offeringId: string | null,
  writer: AgentPolicyWriter,
): Promise<AgentModelBinding> {
  if (offeringId === null) return { offeringId: null, offeringPartnerId: null };
  const partnerId = owner.partnerId ?? (owner.orgId ? await readOrgPartnerId(owner.orgId) : null);
  if (!partnerId) throw new AgentModelNotAllowedError(UNAVAILABLE, 'not_permitted');
  if (!(await ensurePartnerCutover(partnerId))) {
    throw new AgentModelNotAllowedError(unavailableMessage('registry_unavailable'), 'registry_unavailable');
  }
  // System context: an org-scoped request cannot see the partner-level rows
  // the merge starts from (same as resolveModel).
  const assignment = await runOutsideDbContext(() => withSystemDbAccessContext(() => getEffectiveAssignment({
    partnerId, orgId: owner.orgId, surface: 'ai_agents', role: 'default',
  })));
  // The default is always reachable (resolveModel skips the permitted check for it).
  if (offeringId !== assignment.defaultOfferingId && !isPermitted(assignment.permitted, offeringId)) {
    throw new AgentModelNotAllowedError('This AI model is not permitted for AI agents here. Choose another model.', 'not_permitted');
  }
  // null for a missing offering AND for another partner's (or its connection).
  const candidate = await loadOfferingCandidate(offeringId, partnerId);
  if (!candidate) throw new AgentModelNotAllowedError(UNAVAILABLE, 'not_permitted');
  const base = await eligibilityContextFor({
    partnerId,
    orgId: owner.orgId,
    userId: writer.userId || null,
    surface: 'ai_agents',
    transport: defaultTransport('ai_agents'),
  });
  // `required_permission` is ALWAYS judged at the write, for the writer — even
  // though the run skips it. A write with no human writer holds no permission
  // (eligibilityContextFor's predicate is then always false): fail closed.
  const reason = checkEligibility(candidate.facts, { ...base, userInitiated: true });
  if (reason === 'permission_required') {
    throw new AgentModelNotAllowedError(unavailableMessage(reason), 'permission_required');
  }
  if (reason === 'not_permitted') throw new AgentModelNotAllowedError(UNAVAILABLE, 'not_permitted');
  if (reason !== null) throw new AgentModelNotAllowedError(unavailableMessage(reason), 'model_unavailable');
  return { offeringId, offeringPartnerId: partnerId };
}
