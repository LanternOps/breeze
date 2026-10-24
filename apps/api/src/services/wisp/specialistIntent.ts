/**
 * Wisp W07 — the `wisp_specialist_request` approval card (plan Task 4; Wisp
 * design §3 "asks first", §7.5).
 *
 * When an assessment requests a kind the policy does not auto-admit, the
 * coordinator raises ONE supervised Tier-3 intent: the card. It is minted
 * under the assessment run's own AGENT principal (`source: 'ai_agent'`), so
 * the grantor — who is not the requester — can approve it in one tap
 * (`resolveAgentIntentApprovers`: org/partner members holding the carrier's
 * RBAC mapping, `ai_sessions:use`, w00 A1). Releasing it runs the same
 * coordinator again under the APPROVER's rebuilt authority
 * (`aiToolsWisp.wispSpecialistRequestHandler`), which re-runs every gate.
 *
 * The carrier is human-only (HUMAN_ONLY_TOOLS): never declared to chat, Helper
 * or agents, so no model can raise it — only this function can. It is listed
 * in AGENT_COORDINATOR_CARRIER_TOOLS so the agent guardrails accept it from a
 * device-less assessment run without it sitting in the agent's allowlist.
 *
 * Idempotent on the request id: the intent's idempotency key is derived from
 * it, so a retried finalizer converges on the same live intent.
 */
import { and, eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { aiAgentRuns, aiAgents } from '../../db/schema/aiAgents';
import { organizations } from '../../db/schema/orgs';
import { createActionIntent } from '../actionIntents/intentService';
import { buildAgentAuthContext } from '../aiAgents/agentAuthContext';
import { SPECIALIST_KIND_LABELS, WISP_SPECIALIST_REQUEST_TOOL, type SpecialistKind } from './specialistPolicy';
import { bulkReplyDigest } from './specialists/bulkTicketReply';

export { WISP_SPECIALIST_REQUEST_TOOL };
export { loadReleasableCarrierIntent } from './specialistCarrier';

export interface WispSpecialistRequestArguments {
  requestId: string;
  kind: SpecialistKind;
  orgId: string;
  grantId: string;
  grantRevisionId: string;
  params: Record<string, unknown>;
  reason: string;
}

/** The carrier's stored arguments: the request, plus the bulk digest pinned at mint. */
export type WispSpecialistCarrierArguments = WispSpecialistRequestArguments & { pinnedDigest?: string };


export function specialistIntentIdempotencyKey(requestId: string): string {
  return `wisp-specialist:${requestId}`;
}

export class SpecialistIntentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpecialistIntentError';
  }
}

export async function raiseSpecialistIntent(
  input: { requestedByRunId: string } & WispSpecialistRequestArguments,
): Promise<{ intentId: string }> {
  // System-scoped lineage reads, exactly as checkAgentReleaseAuthority loads
  // them for the release: the run, its agent, and the org's partner.
  const loaded = await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const [run] = await db
      .select({ id: aiAgentRuns.id, agentId: aiAgentRuns.agentId, orgId: aiAgentRuns.orgId, sessionId: aiAgentRuns.sessionId })
      .from(aiAgentRuns)
      .where(and(eq(aiAgentRuns.id, input.requestedByRunId), eq(aiAgentRuns.orgId, input.orgId)))
      .limit(1);
    if (!run) return null;
    const [agent] = await db
      .select({ id: aiAgents.id, orgId: aiAgents.orgId, partnerId: aiAgents.partnerId, name: aiAgents.name, kind: aiAgents.kind })
      .from(aiAgents)
      .where(eq(aiAgents.id, run.agentId))
      .limit(1);
    const [org] = await db
      .select({ partnerId: organizations.partnerId })
      .from(organizations)
      .where(eq(organizations.id, run.orgId))
      .limit(1);
    if (!agent || !org) return null;
    return { run, agent, org };
  }));
  if (!loaded) {
    throw new SpecialistIntentError('raiseSpecialistIntent: the requesting run, its agent or its org no longer resolves');
  }
  const { run, agent, org } = loaded;
  // A device-less assessment run: no device, no site. The carrier's effect is
  // bounded by the coordinator's gates, re-run at release.
  const agentAuth = buildAgentAuthContext(
    agent,
    { id: run.id, orgId: run.orgId, deviceId: null, deviceSiteId: null, sessionId: run.sessionId ?? null },
    { id: run.orgId, partnerId: org.partnerId },
  );

  const args: WispSpecialistCarrierArguments = {
    requestId: input.requestId,
    kind: input.kind,
    orgId: input.orgId,
    grantId: input.grantId,
    grantRevisionId: input.grantRevisionId,
    params: input.params,
    reason: input.reason.slice(0, 500),
  };
  if (input.kind === 'bulk_ticket_reply') {
    // The approval pins the exact ticket set and message (w00 A30); release
    // refuses if the stored params no longer hash to it.
    args.pinnedDigest = bulkReplyDigest(input.params as { ticketIds: string[]; message: string });
  }

  const intent = await createActionIntent(agentAuth, {
    toolName: WISP_SPECIALIST_REQUEST_TOOL,
    input: args as unknown as Record<string, unknown>,
    source: 'ai_agent',
    orgId: input.orgId,
    reason: input.reason ? input.reason.slice(0, 500) : `Wisp asks to run ${SPECIALIST_KIND_LABELS[input.kind]}`,
    actionLabel: `Wisp: ${SPECIALIST_KIND_LABELS[input.kind]}`,
    idempotencyKey: specialistIntentIdempotencyKey(input.requestId),
    coordinatorCarrier: true,
  });
  return { intentId: intent.id };
}
