import type { AiAgentKind } from '@breeze/shared';
import { eq } from 'drizzle-orm';
import type { DbAccessContext } from '../../db';
import type { AuthContext } from '../../middleware/auth';

export interface AgentIdentity {
  id: string;
  orgId: string | null;
  partnerId: string | null;
  name: string;
  kind: AiAgentKind;
}

export interface AgentRunRef {
  id: string;
  orgId: string;
  deviceId: string | null;
}

export interface OrgRef {
  id: string;
  partnerId: string;
}

export class AgentRunOwnershipError extends Error {
  constructor(detail: string) {
    super(`agent_run_ownership_mismatch: ${detail}`);
    this.name = 'AgentRunOwnershipError';
  }
}

/** Spec §3.1: org agent ⇒ run.orgId === agent.orgId; partner agent ⇒ org.partnerId === agent.partnerId. */
export function assertRunOwnership(
  agent: AgentIdentity,
  run: AgentRunRef,
  org: OrgRef
): void {
  if (run.orgId !== org.id) {
    throw new AgentRunOwnershipError('run/org mismatch');
  }
  if (agent.orgId !== null) {
    if (agent.orgId !== run.orgId) {
      throw new AgentRunOwnershipError('org agent targeting another org');
    }
    return;
  }
  if (agent.partnerId === null || org.partnerId !== agent.partnerId) {
    throw new AgentRunOwnershipError("partner agent targeting another partner's org");
  }
}

/** DB context for an agent run. userId is ALWAYS null (never a Shape-6 user). */
export function agentDbAccessContext(orgId: string, partnerId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
    currentPartnerId: partnerId,
  };
}

export function buildAgentAuthContext(
  agent: AgentIdentity,
  run: AgentRunRef,
  org: OrgRef
): AuthContext {
  assertRunOwnership(agent, run, org);
  return {
    principal: { kind: 'ai_agent', agentId: agent.id, runId: run.id },
    // Attribution only. Never used for RBAC (checkPermissionRequirements denies
    // ai_agent first) and never copied into breeze.user_id (agentDbAccessContext).
    user: {
      id: agent.id,
      email: `agent+${agent.id}@breeze.internal`,
      name: agent.name,
      isPlatformAdmin: false,
    },
    token: null,
    partnerId: org.partnerId,
    orgId: run.orgId,
    scope: 'organization',
    accessibleOrgIds: [run.orgId],
    partnerOrgAccess: null,
    orgCondition: (column) => eq(column, run.orgId),
    canAccessOrg: (id) => id === run.orgId,
  };
}
