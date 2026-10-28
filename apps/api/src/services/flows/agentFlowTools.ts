/**
 * W5 PR C (#5220), Task C5 — AI agents calling flows (plan Decision 9).
 *
 * An agent may start a flow only when ALL of these hold, checked on every
 * call:
 *  - the run carries no device, site or delegation ceiling — the flow
 *    principal is deliberately org-wide (`flowAuthContext.ts`), so any flow a
 *    device-bound, site-bound or grant-bound run started would widen the
 *    run's reach (quorum Q4; approval would not fix it either);
 *  - the flow's tool name is in the run's tool allowlist, at EVERY tier (the
 *    agent guardrail's own allowlist check covers only mutations);
 *  - the flow's LIVE invocation tier is 1 — a Tier ≥ 2 flow is refused
 *    `flow_not_allowed_for_agent`: there is no agent proposal path and no
 *    agent-minted invoked-flow intent in W05;
 *  - `checkAgentGuardrails` with that resolved tier allows it (env flag,
 *    kill switch, policy, enabled agent, mode not off).
 * `run_flow` stays in `AGENT_HUMAN_ONLY_TOOLS`: an agent names each flow it
 * may start. The run is a `tool` run, `triggered_via 'ai_agent'`, with the
 * agent run as its parent and no human triggerer.
 */
import { and, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { flowsEnabled } from '../../config/env';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { flowVersions } from '../../db/schema/flowRuns';
import { flows } from '../../db/schema/flows';
import { organizations } from '../../db/schema/orgs';
import type { AuthContext } from '../../middleware/auth';
import { checkAgentGuardrails, type AgentGuardrailPolicy } from '../aiGuardrails';
import { captureException } from '../sentry';
import { hasExactDeviceCeiling } from '../siteCeilingAccess';
import type { FlowToolCallInput, FlowToolDescriptor } from './flowTools';
import type { FlowToolRunStarter } from './sdkFlowTools';
import { FLOW_TOOL_PREFIX, isFlowToolName } from './toolNames';

const NOT_ALLOWED = 'flow_not_allowed_for_agent';
const MAX_AGENT_FLOW_TOOLS = 20;

export interface AgentFlowRunRef {
  id: string;
  orgId: string;
  grantId?: string | null;
}

/** No device, site or delegation ceiling on the run. */
export function agentRunMayCallFlows(
  run: Pick<AgentFlowRunRef, 'grantId'>,
  agentAuth: AuthContext,
  policy: Pick<AgentGuardrailPolicy, 'deviceId'>,
): boolean {
  if (run.grantId) return false;
  if (policy.deviceId) return false;
  if (hasExactDeviceCeiling(agentAuth)) return false;
  return agentAuth.allowedSiteIds === undefined;
}

/**
 * The flow tools a run EXPOSES: its allowlisted `flow__*` names that resolve
 * live at Tier 1 for an unrestricted run. Exposure only — every call is
 * gated again by `gateAgentFlowToolCall`. A name that fails to resolve is
 * skipped (logged), never fatal to the run.
 */
export async function resolveAgentFlowTools(
  run: AgentFlowRunRef,
  agentAuth: AuthContext,
  policy: Pick<AgentGuardrailPolicy, 'deviceId' | 'toolAllowlist'>,
): Promise<FlowToolDescriptor[]> {
  if (!flowsEnabled() || !agentRunMayCallFlows(run, agentAuth, policy)) return [];
  const names = [...new Set(policy.toolAllowlist.filter(isFlowToolName))].slice(0, MAX_AGENT_FLOW_TOOLS);
  if (names.length === 0) return [];
  const { resolveFlowToolForCall } = await import('./flowTools');
  const out: FlowToolDescriptor[] = [];
  for (const name of names) {
    try {
      const d = await resolveFlowToolForCall(agentAuth, name, run.orgId);
      if (d && d.tier === 1) out.push(d);
    } catch (err) {
      console.warn(`[flows] agent run ${run.id}: flow tool '${name}' could not be resolved; not exposed`, err);
      captureException(err instanceof Error ? err : new Error(String(err)), undefined,
        { flow_site: 'agent.flow_tool_exposure', org_id: run.orgId }, { fingerprint: ['flow', 'agent.flow_tool_exposure'] });
    }
  }
  return out;
}

export type AgentFlowGateResult =
  | { ok: true; descriptor: FlowToolDescriptor; call: FlowToolCallInput }
  | { ok: false; reason: string };

export async function gateAgentFlowToolCall(args: {
  run: AgentFlowRunRef;
  agentAuth: AuthContext;
  toolName: string;
  input: Record<string, unknown>;
  guardrailPolicy: AgentGuardrailPolicy;
}): Promise<AgentFlowGateResult> {
  const { run, agentAuth, toolName, input, guardrailPolicy } = args;
  if (!agentRunMayCallFlows(run, agentAuth, guardrailPolicy)) {
    return { ok: false, reason: `${NOT_ALLOWED}: an agent run with a device, site or delegation ceiling cannot start a flow` };
  }
  if (!guardrailPolicy.toolAllowlist.includes(toolName)) {
    return { ok: false, reason: `Flow tool "${toolName}" is not in the agent's allowlist` };
  }
  let descriptor: FlowToolDescriptor | null;
  try {
    const { resolveFlowToolForCall } = await import('./flowTools');
    descriptor = await resolveFlowToolForCall(agentAuth, toolName, run.orgId);
  } catch (err) {
    console.error(`[flows] agent run ${run.id}: flow tool '${toolName}' could not be resolved; denying`, err);
    captureException(err instanceof Error ? err : new Error(String(err)), undefined,
      { flow_site: 'agent.flow_tool_gate', org_id: run.orgId }, { fingerprint: ['flow', 'agent.flow_tool_gate'] });
    return { ok: false, reason: 'The flow could not be verified. Stop and do not retry.' };
  }
  if (!descriptor) return { ok: false, reason: `Flow tool "${toolName}" is not available (flow_tool_unavailable)` };
  if (descriptor.tier !== 1) {
    return { ok: false, reason: `${NOT_ALLOWED}: agents may start Tier-1 flows only; "${toolName}" is Tier ${descriptor.tier}` };
  }
  const check = checkAgentGuardrails(toolName, input, guardrailPolicy, undefined, { resolvedTier: 1 });
  if (check.disposition !== 'allow') {
    return { ok: false, reason: check.reason ?? 'Denied by agent guardrails' };
  }
  const validated = descriptor.validate(input);
  if (!validated.ok) return { ok: false, reason: `Invalid input for ${toolName}: ${validated.message}` };
  return { ok: true, descriptor, call: validated.value };
}

/** The agent lane: an `ai_agent` tool run, parented to the agent run, in the run's org, with no human triggerer. */
export function agentFlowToolRunStarter(run: Pick<AgentFlowRunRef, 'id' | 'orgId'>): FlowToolRunStarter {
  return async (gated, args) => {
    const { startToolRun } = await import('./toolRuns');
    return startToolRun(gated, args, 'ai_agent', { kind: 'agent_tier1', agentRunId: run.id, orgId: run.orgId }, { parentAgentRunId: run.id });
  };
}

// ── save-time warning ─────────────────────────────────────────────────────────

/**
 * Builds (without executing) the read behind `unknownFlowToolNames`: the
 * slugs among `slugs` that name an ENABLED flow whose live publication has a
 * manual trigger, visible to an agent OWNER — an org agent: its org's flows
 * and its LIVE partner's partner-wide flows; a partner agent: its
 * partner-wide flows. `null` without an owner.
 */
export function buildKnownFlowSlugsQuery(owner: { orgId: string | null; partnerId: string | null }, slugs: string[]) {
  let predicate: SQL | undefined;
  if (owner.orgId) {
    const orgsPartnerId = sql<string>`(select ${organizations.partnerId} from ${organizations} where ${organizations.id} = ${owner.orgId})`;
    predicate = or(eq(flows.orgId, owner.orgId), and(isNull(flows.orgId), eq(flows.partnerId, orgsPartnerId)));
  } else if (owner.partnerId) {
    predicate = and(isNull(flows.orgId), eq(flows.partnerId, owner.partnerId));
  }
  if (!predicate) return null;
  return db
    .select({ slug: flows.slug })
    .from(flows)
    .innerJoin(flowVersions, and(eq(flowVersions.flowId, flows.id), sql`${flowVersions.publicationSeq} = ${flows.enabledPublicationSeq}`))
    .where(and(
      eq(flows.status, 'enabled'),
      sql`${flowVersions.definition}->'trigger'->>'type' = ${'manual'}`,
      inArray(flows.slug, slugs),
      predicate,
    ));
}

/**
 * The allowlisted `flow__<slug>` names with no enabled manual flow for the
 * agent's owner (Decision 9: the save WARNS, never errors — the flow may be
 * enabled later; every call is gated live anyway). Flags off ⇒ every flow
 * name is unknown.
 */
export async function unknownFlowToolNames(
  owner: { orgId: string | null; partnerId: string | null },
  toolAllowlist: readonly string[],
): Promise<string[]> {
  const names = [...new Set(toolAllowlist.filter(isFlowToolName))].slice(0, 100);
  if (names.length === 0) return [];
  if (!flowsEnabled()) return names;
  const slugs = names.map((n) => n.slice(FLOW_TOOL_PREFIX.length));
  if (!owner.orgId && !owner.partnerId) return names;
  // Built INSIDE the system context (the `db` proxy binds at build time).
  const rows = await runOutsideDbContext(() => withSystemDbAccessContext(
    async () => (await buildKnownFlowSlugsQuery(owner, slugs)) ?? [],
    'flows.agentFlowTools.knownSlugs',
  ));
  const known = new Set(rows.map((r) => r.slug));
  return names.filter((n) => !known.has(n.slice(FLOW_TOOL_PREFIX.length)));
}
