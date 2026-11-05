/**
 * Tool Catalog W04 (#5219), Open Decision 7 — the run-time principal of a
 * published flow.
 *
 * A flow step executes as the FLOW, not as the user who enabled it (spec D4):
 * no user RBAC at run time, no token, no role. What a step may do is decided
 * by the flow's own checks (per-step policy, approval-scope drift, the
 * delegator re-check at every slice — Tasks A5/A7), never by a user grant.
 * Modelled on `services/aiAgents/agentAuthContext.ts`.
 */
import { eq } from 'drizzle-orm';
import type { FlowStatus } from '@breeze/shared';
import type { DbAccessContext } from '../../db';
import type { AuthContext } from '../../middleware/auth';

/** The flow_runs row a slice executes. */
export interface FlowRunRef {
  id: string;
  orgId: string;
  flowId: string;
}

/**
 * The flows row behind a run. Ownership is org_id XOR partner_id (flows.ts,
 * "Partner-Wide First"), so exactly one of `orgId` / `partnerId` is set.
 */
export interface FlowIdentity {
  id: string;
  orgId: string | null;
  partnerId: string | null;
  status: FlowStatus;
  /** Display name for attribution only. */
  name?: string;
}

export interface FlowOrgRef {
  id: string;
  partnerId: string;
}

export class FlowRunOwnershipError extends Error {
  constructor(detail: string) {
    super(`flow_run_ownership_mismatch: ${detail}`);
    this.name = 'FlowRunOwnershipError';
  }
}

/**
 * The run belongs to the flow and executes in an org the flow owns: an org
 * flow ⇒ `run.orgId === flow.orgId`; a partner-wide flow ⇒ the run org's
 * partner is the flow's partner.
 */
export function assertFlowRunOwnership(flow: FlowIdentity, run: FlowRunRef, org: FlowOrgRef): void {
  if (run.flowId !== flow.id) {
    throw new FlowRunOwnershipError('run/flow mismatch');
  }
  if (run.orgId !== org.id) {
    throw new FlowRunOwnershipError('run/org mismatch');
  }
  if (flow.orgId !== null) {
    if (flow.orgId !== run.orgId) {
      throw new FlowRunOwnershipError('org flow targeting another org');
    }
    return;
  }
  if (flow.partnerId === null || org.partnerId !== flow.partnerId) {
    throw new FlowRunOwnershipError("partner flow targeting another partner's org");
  }
}

/** DB context for a flow run. userId is ALWAYS null (never a Shape-6 user). */
export function flowDbAccessContext(orgId: string, partnerId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
    currentPartnerId: partnerId,
  };
}

export function buildFlowAuthContext(flow: FlowIdentity, run: FlowRunRef, org: FlowOrgRef): AuthContext {
  assertFlowRunOwnership(flow, run, org);
  return {
    principal: { kind: 'flow', flowId: flow.id, runId: run.id },
    // Open Decision 16: the AI-surface mint site for flow runs, ONCE per run.
    // Every device-reaching handler calls `requireAiOrigin`
    // (services/aiDispatch.ts) and refuses unattributed work; a flow is its
    // own initiator kind, never `ai_agent`.
    aiOrigin: { kind: 'flow', flowRunId: run.id },
    // Attribution only — never a users row. Never used for RBAC
    // (checkToolPermission / checkPermissionRequirements deny automation
    // principals first) and never copied into breeze.user_id
    // (dbAccessContextFromAuth nulls it for automation principals).
    user: {
      id: flow.id,
      email: `flow+${flow.id}@breeze.internal`,
      name: flow.name ?? 'Flow',
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
    // No `allowedSiteIds` / `allowedDeviceIds`: the flow principal is
    // org-wide by design, and enable refuses a site-restricted delegator
    // (Open Decision 13, `delegation_scope_restricted`), so a site-limited
    // technician can never mint it.
  };
}
