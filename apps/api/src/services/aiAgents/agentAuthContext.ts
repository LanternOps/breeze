import type { AiAgentKind } from '@breeze/shared';
import { eq } from 'drizzle-orm';
import type { DbAccessContext } from '../../db';
import { siteAccessCheck, type AuthContext } from '../../middleware/auth';

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
  /**
   * Site of the run's device, resolved server-side. Required whenever the run
   * has a device: spec §3.2 bounds an agent to its device's site, and an
   * undefined allowedSiteIds means UNRESTRICTED, so omitting it silently widens
   * the agent to the whole org.
   */
  deviceSiteId?: string | null;
  /**
   * The persisted `ai_sessions.id` this run is bound to, when it has one
   * (#5022 W01). Carried into `aiOrigin` so a run initiated from a chat
   * session keeps the conversation pointer alongside the run pointer.
   */
  sessionId?: string | null;
  /**
   * Execution plane W04 — the frozen device SET of a device-LESS analysis
   * run (`ai_agent_runs.staged_inputs.deviceIds`). A run with a `deviceId`
   * ignores this (that branch already pins the exact device). Without it a
   * device-less run has NO `allowedDeviceIds` at all, i.e. every device in
   * the org, which is precisely what `analysisMaxInputDevicesPerRun` exists
   * to prevent.
   */
  allowedDeviceIds?: readonly string[];
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
    // #5022 W01: the AI-surface mint site for autonomous agent runs. Minted
    // ONCE here, per run -- never per tool. `services/aiDispatch.ts` reads it.
    aiOrigin: {
      kind: 'ai_agent' as const,
      agentRunId: run.id,
      ...(run.sessionId ? { sessionId: run.sessionId } : {}),
    },
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
    // Without these the tool layer's `if (auth.canAccessSite && ...)` gate is
    // skipped entirely and a device-bound agent could target any device in the
    // org. A run with a device pins to that device's site; a run with no device
    // pins to the empty set rather than to "unrestricted".
    //
    // The site pin alone is not exact: it admits every SIBLING device in the
    // same site, not just the one device the run targets. `allowedDeviceIds`
    // is the tightening on top — `verifyDeviceAccess` (aiTools.ts) enforces
    // it as an exact-match allowlist alongside the site check.
    ...(run.deviceId
      ? {
          allowedSiteIds: run.deviceSiteId ? [run.deviceSiteId] : [],
          canAccessSite: siteAccessCheck(run.deviceSiteId ? [run.deviceSiteId] : []),
          allowedDeviceIds: [run.deviceId],
        }
      : {}),
    // W04: the device-LESS analysis run's frozen set. Only reachable when the
    // run has no `deviceId` — the branch above already pinned that case, and
    // an analysis run is device-less by construction.
    ...(!run.deviceId && run.allowedDeviceIds
      ? { allowedDeviceIds: [...run.allowedDeviceIds] }
      : {}),
  };
}
