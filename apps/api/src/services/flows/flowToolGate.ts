/**
 * W5 PR C (#5220), Task C3 — the CHAT GATE for flow tools (plan Decisions 7,
 * 8, 10), called from `createSessionPreToolUse` (aiAgentSdk.ts) BEFORE the
 * tenant branch:
 *
 *  - `gateFlowToolCall` re-resolves the flow LIVE (`resolveFlowToolForCall`),
 *    so a publication re-enabled since the session listed it is gated at its
 *    current invocation tier, and validates the input against its
 *    declarations — before any approval card or intent exists;
 *  - the gate tier is the live tier: Tier 1 runs (`automations.read`),
 *    Tier 2 takes the chat confirmation path tenant Tier-2 tools take,
 *    Tier 3 becomes an action intent carrying the immutable invoked-flow
 *    binding (`flowToolIntentBinding`) that only the durable worker releases;
 *  - Wisp-grant, helper and topology-investigation sessions never start a
 *    flow (the flow principal is org-wide; those sessions are ceiling-bound).
 *
 * A light module on purpose (types + a lazily loaded resolver): aiAgentSdk.ts
 * imports it, and that module's import graph must not widen
 * (actionIntents/durableRelease.ts explains why). The SDK tools themselves
 * are built in sdkFlowTools.ts.
 */
import type { AuthContext } from '../../middleware/auth';
import type { GuardrailCheck } from '../aiGuardrails';
import { captureException } from '../sentry';
import { hasExactDeviceCeiling, hasSiteCeiling } from '../siteCeilingAccess';
import type { FlowToolCallInput, FlowToolDescriptor, FlowToolTier } from './flowTools';

/** The slice of a chat `ActiveSession` the flow gate and handlers read. */
export interface FlowToolSessionView {
  breezeSessionId: string;
  orgId: string;
  auth: AuthContext;
  toolAuth: AuthContext;
  wispGrant?: unknown;
  topologyInvestigation?: unknown;
  flowTools?: ReadonlyMap<string, FlowToolDescriptor>;
}

export type FlowToolGateResult =
  | { ok: true; descriptor: FlowToolDescriptor; call: FlowToolCallInput }
  | { ok: false; error: string };

const UNAVAILABLE = (name: string) =>
  `Flow tool '${name}' is not available (flow_tool_unavailable): the flow is no longer enabled or visible. Use list_flows to see the current flows.`;

/** Sessions that may never start a flow: their reach is narrower than the org-wide flow principal. */
export function sessionMayStartFlows(s: Pick<FlowToolSessionView, 'auth' | 'wispGrant' | 'topologyInvestigation'>): boolean {
  return !s.wispGrant && !s.topologyInvestigation && !s.auth.helperDeviceId;
}

export async function gateFlowToolCall(
  session: FlowToolSessionView,
  toolName: string,
  input: Record<string, unknown>,
): Promise<FlowToolGateResult> {
  if (!sessionMayStartFlows(session)) {
    return { ok: false, error: 'Flows cannot be started from this conversation.' };
  }
  // The run start refuses a site- or device-limited triggerer (the flow
  // principal is org-wide); refuse here too, before an approval card or an
  // intent for a call that could never run exists.
  if ([session.auth, session.toolAuth].some((a) => hasSiteCeiling(a) || hasExactDeviceCeiling(a))) {
    return { ok: false, error: 'A user limited to specific sites or devices cannot start a flow (delegation_scope_restricted).' };
  }
  if (!session.flowTools?.has(toolName)) return { ok: false, error: UNAVAILABLE(toolName) };
  let descriptor: FlowToolDescriptor | null;
  try {
    const { resolveFlowToolForCall } = await import('./flowTools');
    descriptor = await resolveFlowToolForCall(session.toolAuth, toolName, session.orgId);
  } catch (err) {
    console.error(`[flows] flow tool '${toolName}' could not be resolved; denying the call`, err);
    // A persistent resolver failure denies every flow call: make it visible.
    captureException(err instanceof Error ? err : new Error(String(err)), undefined,
      { flow_site: 'chat.flow_tool_gate', org_id: session.orgId }, { fingerprint: ['flow', 'chat.flow_tool_gate'] });
    return { ok: false, error: 'Unable to verify this flow right now. Please try again.' };
  }
  if (!descriptor) return { ok: false, error: UNAVAILABLE(toolName) };
  const validated = descriptor.validate(input);
  if (!validated.ok) return { ok: false, error: `Invalid input for ${toolName}: ${validated.message}` };
  return { ok: true, descriptor, call: validated.value };
}

export function flowToolPermissionRequirement(tier: FlowToolTier): { resource: 'automations'; action: 'read' | 'write' } {
  return { resource: 'automations', action: tier === 1 ? 'read' : 'write' };
}

/** The guardrail verdict the chat gate applies: the live invocation tier, never the static registry. */
export function guardrailCheckForFlowTool(d: FlowToolDescriptor): GuardrailCheck {
  const description = `Run flow "${d.flowName}"`;
  if (d.tier === 3) {
    return { tier: 3, allowed: true, requiresApproval: true, readOnly: false, description, approvalScope: 'supervised' };
  }
  return { tier: d.tier, allowed: true, requiresApproval: d.tier >= 2, readOnly: d.tier === 1, description };
}

/**
 * A Tier-3 call's intent: the run org (an org flow's own org; a partner-wide
 * flow's named org, else the session org), the COERCED call as the intent's
 * immutable arguments, and the invoked-flow binding.
 */
export function flowToolIntentBinding(d: FlowToolDescriptor, call: FlowToolCallInput, sessionOrgId: string): {
  orgId: string;
  input: Record<string, unknown>;
  invokedFlow: { flowId: string; publicationId: string; publicationSeq: number; flowName: string };
} {
  const orgId = d.owner.orgId ?? call.orgId ?? sessionOrgId;
  return {
    orgId,
    input: { inputs: call.inputs, orgId, idempotencyKey: call.idempotencyKey },
    invokedFlow: { flowId: d.flowId, publicationId: d.publicationId, publicationSeq: d.publicationSeq, flowName: d.flowName },
  };
}
