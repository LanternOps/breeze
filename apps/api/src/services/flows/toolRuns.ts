/**
 * W5 PR C (#5220), Task C2 — starting a flow AS A TOOL (plan Decisions 8–10).
 *
 * One entry point for every surface: chat (`ai_tool`, the session user — or,
 * for a Tier-3 call, the approver at release), Breeze's MCP server (`mcp`, the
 * API key: its scopes ∩ its creator, W04 deviation 2) and AI agents
 * (`ai_agent`, Tier-1 flows only, no human). The surface has already gated the
 * call at the descriptor's live tier; this module re-proves, against the LIVE
 * publication, everything the run depends on:
 *
 *  1. lane ↔ triggerer pairing (a mismatch is a caller bug, thrown);
 *  2. the live publication is the one the descriptor resolved, and its live
 *     invocation tier is not above the one the surface gated on
 *     (`flow_tool_changed` otherwise — the caller re-resolves);
 *  3. the inputs coerce against its declarations;
 *  4. the run org: an org flow's own org; a partner-wide flow's `orgId`
 *     argument, else the surface's default org (the session / MCP org), and it
 *     must sit under the flow's partner; an agent runs only in its own org;
 *  5. for a human: the caller reaches the org, holds `automations.read`
 *     (Tier 1) / `automations.write` (Tier ≥ 2) and passes rule 7 for every
 *     step (`authorizeRunTriggerer`, the startManualRun checks, extracted); a
 *     site or exact-device ceiling is `delegation_scope_restricted`;
 *  6. `createFlowRun({ triggerKind: 'tool', expectedPublicationSeq })` — the
 *     publication check is atomic with the insert, so a re-enable in between
 *     is `flow_tool_changed`, never a run on an unchecked publication. Tool
 *     runs never honour pre-approvals.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { flowDocumentV1Schema } from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { flowVersions } from '../../db/schema/flowRuns';
import { flows } from '../../db/schema/flows';
import { organizations } from '../../db/schema/orgs';
import { flowsEnabled } from '../../config/env';
import { isAutomationPrincipal, isInteractiveUserSession, type AuthContext } from '../../middleware/auth';
import { hasPermission } from '../permissions';
import { hasExactDeviceCeiling, hasSiteCeiling } from '../siteCeilingAccess';
import { flowInvocationTier, type FlowToolDescriptor } from './flowTools';
import type { FlowRunAdmissionRefusal } from './runAdmission';
import { authorizeRunTriggerer, createFlowRun, parsePins } from './runService';

export type ToolRunTriggerer =
  /** The chat session user, or the approver of a Tier-3 flow-tool intent at release. */
  | { kind: 'user'; auth: AuthContext }
  /** Breeze's MCP server: the API key (scopes ∩ creator). */
  | { kind: 'api_key'; auth: AuthContext }
  /** An unrestricted AI agent run calling an allowlisted Tier-1 flow (Decision 9). */
  | { kind: 'agent_tier1'; agentRunId: string; orgId: string };

export type ToolRunVia = 'ai_tool' | 'mcp' | 'ai_agent';

export type StartToolRunResult =
  | { ok: true; runId: string; duplicate: boolean; runPath: string }
  | {
      ok: false;
      error: 'flow_tool_changed' | 'not_enabled' | 'org_required' | 'org_forbidden' | 'delegation_scope_restricted'
        | 'interactive_user_required' | 'flow_not_allowed_for_agent' | FlowRunAdmissionRefusal;
    }
  | { ok: false; error: 'inputs_invalid'; issues: Array<{ name: string; message: string }> }
  | { ok: false; error: 'permission_missing'; missing: Array<{ stepId: string; permission: string }> };

export interface StartToolRunContext {
  aiSessionId?: string | null;
  /** Required exactly for `ai_agent`, and equal to the triggerer's agent run. */
  parentAgentRunId?: string | null;
  /** The surface's org (the chat session org, the MCP call's org) — the default run org of a partner-wide flow. */
  defaultOrgId?: string | null;
}

const VIA_FOR_TRIGGERER: Record<ToolRunTriggerer['kind'], ToolRunVia> = {
  user: 'ai_tool',
  api_key: 'mcp',
  agent_tier1: 'ai_agent',
};

function inSystemTx<T>(fn: () => Promise<T>, label: string): Promise<T> {
  return runOutsideDbContext(() => withSystemDbAccessContext(fn, label));
}

function assertPairing(via: ToolRunVia, triggerer: ToolRunTriggerer, ctx: StartToolRunContext): void {
  if (VIA_FOR_TRIGGERER[triggerer.kind] !== via) {
    throw new Error(`startToolRun: lane '${via}' does not match a '${triggerer.kind}' triggerer`);
  }
  if (triggerer.kind === 'agent_tier1' ? ctx.parentAgentRunId !== triggerer.agentRunId : ctx.parentAgentRunId) {
    throw new Error('startToolRun: parentAgentRunId must be the triggering agent run, and only for ai_agent');
  }
}

/** A credential that may start a flow on this lane (checked before any read). */
function laneCredentialOk(triggerer: ToolRunTriggerer): boolean {
  if (triggerer.kind === 'agent_tier1') return true;
  const { auth } = triggerer;
  if (isAutomationPrincipal(auth) || !auth.user?.id) return false;
  return triggerer.kind === 'user' ? isInteractiveUserSession(auth) : auth.principal.kind === 'api_key';
}

export async function startToolRun(
  d: FlowToolDescriptor,
  rawInput: unknown,
  via: ToolRunVia,
  triggerer: ToolRunTriggerer,
  ctx: StartToolRunContext = {},
): Promise<StartToolRunResult> {
  assertPairing(via, triggerer, ctx);
  if (!flowsEnabled()) return { ok: false, error: 'not_enabled' };
  if (!laneCredentialOk(triggerer)) return { ok: false, error: 'interactive_user_required' };
  // Decision 9: an agent starts Tier-1 flows only (no proposal path in W05).
  if (triggerer.kind === 'agent_tier1' && d.tier !== 1) return { ok: false, error: 'flow_not_allowed_for_agent' };
  if (triggerer.kind !== 'agent_tier1' && (hasSiteCeiling(triggerer.auth) || hasExactDeviceCeiling(triggerer.auth))) {
    return { ok: false, error: 'delegation_scope_restricted' };
  }

  // 2. The live flow and publication (system read: the caller's visibility was
  // the descriptor's owner predicate; the run org is re-checked below).
  const live = await inSystemTx(async () => {
    const [flow] = await db
      .select({ id: flows.id, orgId: flows.orgId, partnerId: flows.partnerId, status: flows.status, enabledPublicationSeq: flows.enabledPublicationSeq })
      .from(flows)
      .where(eq(flows.id, d.flowId))
      .limit(1);
    if (!flow || flow.status !== 'enabled' || flow.enabledPublicationSeq === null) return { flow: null, publication: null };
    const seq = flow.enabledPublicationSeq;
    const [publication] = await db
      .select({ id: flowVersions.id, definition: flowVersions.definition, stepPins: flowVersions.stepPins, effectiveTier: flowVersions.effectiveTier })
      .from(flowVersions)
      .where(and(eq(flowVersions.flowId, flow.id), eq(flowVersions.publicationSeq, seq)))
      .limit(1);
    return { flow: { ...flow, enabledPublicationSeq: seq }, publication: publication ?? null };
  }, 'flows.toolRuns.livePublication');
  if (!live.flow || !live.publication) return { ok: false, error: 'not_enabled' };
  const { flow, publication } = live;
  if (publication.id !== d.publicationId || flow.enabledPublicationSeq !== d.publicationSeq) return { ok: false, error: 'flow_tool_changed' };
  const parsedDoc = flowDocumentV1Schema.safeParse(publication.definition);
  const pins = parsePins(publication.stepPins);
  if (!parsedDoc.success || !pins || parsedDoc.data.trigger.type !== 'manual') return { ok: false, error: 'not_enabled' };
  const doc = parsedDoc.data;
  // 2b. The tier the surface gated on must still hold: the live part of the
  // invocation tier (a tenant tool's tier, a core tool's classification) can
  // rise WITHOUT a new publication, e.g. during a Tier-2 confirmation wait.
  // Higher now ⇒ the caller re-resolves and gates again.
  const liveTier = await flowInvocationTier({ effectiveTier: publication.effectiveTier, definition: doc }, d.owner);
  if (liveTier > d.tier) return { ok: false, error: 'flow_tool_changed' };

  // 3. Inputs.
  const validated = d.validate(rawInput);
  if (!validated.ok) return { ok: false, error: 'inputs_invalid', issues: validated.issues };
  const call = validated.value;

  // 4. Run org.
  let orgId: string;
  if (triggerer.kind === 'agent_tier1') {
    if (flow.orgId ? flow.orgId !== triggerer.orgId : (call.orgId !== null && call.orgId !== triggerer.orgId)) {
      return { ok: false, error: 'org_forbidden' };
    }
    orgId = triggerer.orgId;
  } else if (flow.orgId) {
    if (call.orgId && call.orgId !== flow.orgId) return { ok: false, error: 'org_forbidden' };
    orgId = flow.orgId;
  } else {
    const target = call.orgId ?? ctx.defaultOrgId ?? null;
    if (!target) return { ok: false, error: 'org_required' };
    orgId = target;
  }
  if (triggerer.kind !== 'agent_tier1' && !triggerer.auth.canAccessOrg(orgId)) return { ok: false, error: 'org_forbidden' };
  const [org] = await inSystemTx(
    async () => db.select({ partnerId: organizations.partnerId }).from(organizations).where(eq(organizations.id, orgId)).limit(1),
    'flows.toolRuns.runOrgPartner',
  );
  const orgPartnerId = org?.partnerId ?? null;
  if (!orgPartnerId || (!flow.orgId && orgPartnerId !== flow.partnerId)) return { ok: false, error: 'org_forbidden' };

  // 5. The human behind the call: tool-level RBAC, then rule 7 per step.
  if (triggerer.kind !== 'agent_tier1') {
    const authorized = await authorizeRunTriggerer(triggerer.auth, orgId, orgPartnerId, doc, pins);
    if (!authorized.ok) return authorized;
    const action = d.tier === 1 ? 'read' : 'write';
    if (!hasPermission(authorized.usable, 'automations', action)) {
      return { ok: false, error: 'permission_missing', missing: [{ stepId: '*', permission: `automations.${action}` }] };
    }
  }

  // 6. The run.
  const principalKey = triggerer.kind === 'agent_tier1'
    ? triggerer.agentRunId
    : triggerer.kind === 'api_key'
      ? (triggerer.auth.principal.kind === 'api_key' ? triggerer.auth.principal.apiKeyId : null) ?? triggerer.auth.user.id
      : triggerer.auth.user.id;
  const apiKeyId = triggerer.kind === 'api_key' && triggerer.auth.principal.kind === 'api_key'
    ? triggerer.auth.principal.apiKeyId ?? null
    : null;
  const created = await createFlowRun({
    triggerKind: 'tool',
    triggeredVia: via,
    triggeredByUserId: triggerer.kind === 'agent_tier1' ? null : triggerer.auth.user.id,
    triggeredByApiKeyId: apiKeyId,
    parentAgentRunId: triggerer.kind === 'agent_tier1' ? triggerer.agentRunId : null,
    aiSessionId: via === 'ai_tool' ? ctx.aiSessionId ?? null : null,
    expectedPublicationSeq: d.publicationSeq,
    flowId: flow.id,
    orgId,
    scope: { firedAt: new Date().toISOString() },
    inputs: call.inputs,
    // Scoped to the lane and the principal: one caller's key never returns another caller's run.
    dedupeKey: `tool:${via}:${principalKey}:${call.idempotencyKey ?? randomUUID()}`,
  });
  if (created.created) return { ok: true, runId: created.runId, duplicate: false, runPath: `/flows/runs/${created.runId}` };
  if (created.reason === 'duplicate') return { ok: true, runId: created.runId, duplicate: true, runPath: `/flows/runs/${created.runId}` };
  if (created.reason === 'not_enabled') return { ok: false, error: await insertRefusalReason(d) };
  return { ok: false, error: created.reason };
}

/**
 * The insert refused a publication that was live a moment ago. Only a
 * RE-ENABLE (the flow live on another publication) is `flow_tool_changed` —
 * the caller re-resolves and gates the new one. A disable, or a refusal on the
 * same publication (it no longer parses, the run org lost its partner), is
 * `not_enabled`: re-resolving would only meet the same refusal.
 */
async function insertRefusalReason(d: FlowToolDescriptor): Promise<'flow_tool_changed' | 'not_enabled'> {
  const [row] = await inSystemTx(
    async () => db.select({ status: flows.status, enabledPublicationSeq: flows.enabledPublicationSeq }).from(flows).where(eq(flows.id, d.flowId)).limit(1),
    'flows.toolRuns.refusalReason',
  );
  return row?.status === 'enabled' && row.enabledPublicationSeq !== null && row.enabledPublicationSeq !== d.publicationSeq
    ? 'flow_tool_changed'
    : 'not_enabled';
}
