/**
 * Tool catalog W04 (#5219), plan Task A5 — the release-time AuthContext of a
 * flow-origin action intent.
 *
 * Release executes an approved flow step AS THE FLOW (spec D4), never as the
 * approver or the delegator: the run's flow principal is rebuilt from the run
 * row (`buildFlowAuthContext`), and refused when the run executes in an org
 * the flow does not own (`assertFlowRunOwnership`). There is no user RBAC to
 * re-check — `checkToolPermission` denies every automation principal — so the
 * structural checks (this rebuild, plus the dispatch claim's publication /
 * delegator / drift checks immediately before it) ARE the release authority.
 *
 * `aiOrigin` ({ kind: 'flow', flowRunId }) is rebuilt here from
 * `requesting_flow_run_id`; it is deliberately not persisted to the
 * `ai_origin_*` columns (Decision 16, @breeze/shared aiOrigin.ts).
 */
import { runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import type { ActionIntent } from '../../db/schema/actionIntents';
import type { AuthContext } from '../../middleware/auth';
import { buildFlowAuthContext, FlowRunOwnershipError } from './flowAuthContext';
import { loadFlowRunOwnership } from './intentClaimStore';

export type FlowReleaseAuthority =
  | { ok: true; auth: AuthContext }
  | { ok: false; code: 'run_not_found' | 'ownership_mismatch' | 'flow_not_found' };

export async function checkFlowReleaseAuthority(
  intent: Pick<ActionIntent, 'id' | 'orgId' | 'requestingFlowRunId'>,
): Promise<FlowReleaseAuthority> {
  const runId = intent.requestingFlowRunId;
  if (!runId) return { ok: false, code: 'run_not_found' };

  // runOutsideDbContext: callers include paths with an ambient request
  // context, where a bare system wrapper would be a passthrough.
  const facts = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() => loadFlowRunOwnership(runId), 'flows.checkFlowReleaseAuthority'),
  );
  if (!facts) return { ok: false, code: 'run_not_found' };
  if (!facts.flow) return { ok: false, code: 'flow_not_found' };
  // The composite FK (requesting_flow_run_id, org_id) pins the run to the
  // intent's org; assert it anyway so a schema change fails loud.
  if (facts.run.orgId !== intent.orgId || !facts.orgPartnerId) return { ok: false, code: 'ownership_mismatch' };

  try {
    const auth = buildFlowAuthContext(
      { id: facts.flow.id, orgId: facts.flow.orgId, partnerId: facts.flow.partnerId, status: facts.flow.status, name: facts.flow.name },
      { id: facts.run.id, orgId: facts.run.orgId, flowId: facts.run.flowId },
      { id: facts.run.orgId, partnerId: facts.orgPartnerId },
    );
    return { ok: true, auth };
  } catch (err) {
    if (err instanceof FlowRunOwnershipError) {
      console.error(`[flows] release refused for intent ${intent.id}: ${err.message}`);
      return { ok: false, code: 'ownership_mismatch' };
    }
    throw err;
  }
}
