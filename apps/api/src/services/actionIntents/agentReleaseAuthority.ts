import { eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { aiAgentRuns, aiAgents } from '../../db/schema/aiAgents';
import { organizations } from '../../db/schema/orgs';
import { devices } from '../../db/schema/devices';
import type { ActionIntent } from '../../db/schema/actionIntents';
import { checkAgentGuardrails, type AgentGuardrailPolicy } from '../aiGuardrails';
import {
  AgentRunOwnershipError,
  buildAgentAuthContext,
} from '../aiAgents/agentAuthContext';
import { resolveEffectiveAgent } from '../aiAgents/effectivePolicy';

export type AgentReleaseAuthority =
  | { ok: true }
  | { ok: false; errorCode: string; details?: Record<string, unknown> };

/**
 * Release-time authority check for an AGENT-originated intent (wave 3b,
 * parent plan §1.3). The human decision has already been recorded; this is
 * the last gate before a real Tier-3 mutation executes, so it evaluates the
 * SAME structural gate twice:
 *
 *   1. against the run's immutable `policy_snapshot` — what authorized the
 *      proposal in the first place, and
 *   2. against the agent's CURRENT effective policy — what the operator
 *      believes now.
 *
 * Either verdict being 'deny' vetoes the release: a flipped kill switch
 * (`checkAgentGuardrails` reads BREEZE_AI_AGENTS_ENABLED itself), a disabled
 * agent, mode 'off', a narrowed allowlist or a newly protected resource all
 * stop an already-approved proposal. 'propose' PASSES here on purpose:
 * shadow mode means the agent may not execute unilaterally — a human
 * decision is exactly what release has.
 *
 * This path never consults user RBAC. `checkToolPermission` keeps denying
 * the ai_agent principal as its first statement; release BRANCHES AROUND it
 * into this structural check, it does not soften it.
 */
export async function checkAgentReleaseAuthority(
  intent: ActionIntent,
): Promise<AgentReleaseAuthority> {
  const runId = intent.requestingAgentRunId;
  if (!runId) {
    return {
      ok: false,
      errorCode: 'agent_run_invalid',
      details: { reason: 'intent is not agent-originated' },
    };
  }

  // runOutsideDbContext is load-bearing: a bare system wrapper inside an
  // ambient request/worker context is a passthrough (db/index.ts ~440), and
  // these reads must not depend on whatever org context the caller holds —
  // the release worker runs with NO ambient context, where contextless reads
  // are DENIED, not open.
  const loaded = await runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const [run] = await db
        .select({
          id: aiAgentRuns.id,
          agentId: aiAgentRuns.agentId,
          orgId: aiAgentRuns.orgId,
          deviceId: aiAgentRuns.deviceId,
          policySnapshot: aiAgentRuns.policySnapshot,
        })
        .from(aiAgentRuns)
        .where(eq(aiAgentRuns.id, runId))
        .limit(1);
      if (!run) return null;
      // The composite FK (requesting_agent_run_id, org_id) →
      // ai_agent_runs(id, org_id) guarantees the org match; assert both
      // anyway so a future schema change fails loud instead of executing
      // under the wrong lineage.
      if (run.orgId !== intent.orgId || run.agentId !== intent.originPrincipalId) return null;
      const [agent] = await db
        .select({
          id: aiAgents.id,
          orgId: aiAgents.orgId,
          partnerId: aiAgents.partnerId,
          name: aiAgents.name,
          kind: aiAgents.kind,
        })
        .from(aiAgents)
        .where(eq(aiAgents.id, run.agentId))
        .limit(1);
      if (!agent) return null;
      const [org] = await db
        .select({ partnerId: organizations.partnerId })
        .from(organizations)
        .where(eq(organizations.id, run.orgId))
        .limit(1);
      if (!org) return null;
      // Re-resolve the device's CURRENT site — never the site the snapshot
      // was taken under. A device moved out of its site since approval makes
      // site-scoped input veto below.
      let deviceSiteId: string | null = null;
      if (run.deviceId) {
        const [device] = await db
          .select({ siteId: devices.siteId })
          .from(devices)
          .where(eq(devices.id, run.deviceId))
          .limit(1);
        deviceSiteId = device?.siteId ?? null;
      }
      return { run, agent, org, deviceSiteId };
    }),
  );
  if (!loaded) {
    return {
      ok: false,
      errorCode: 'agent_run_invalid',
      details: {
        reason: 'run is missing, belongs to another agent, or targets another org',
        runId,
      },
    };
  }
  const { run, agent, org, deviceSiteId } = loaded;

  // Reconstruct the agent's own AuthContext — assertRunOwnership inside
  // re-proves the org/partner lineage. Its canAccessOrg covers exactly the
  // run org, which is what resolveEffectiveAgent authorizes against.
  let agentAuth;
  try {
    agentAuth = buildAgentAuthContext(
      {
        id: agent.id,
        orgId: agent.orgId,
        partnerId: agent.partnerId,
        name: agent.name,
        kind: agent.kind,
      },
      { id: run.id, orgId: run.orgId, deviceId: run.deviceId, deviceSiteId },
      { id: run.orgId, partnerId: org.partnerId },
    );
  } catch (error) {
    if (error instanceof AgentRunOwnershipError) {
      return {
        ok: false,
        errorCode: 'agent_run_invalid',
        details: { reason: error.message },
      };
    }
    throw error;
  }

  // Current effective policy for the run's org + the agent's kind. System
  // context for the same reason as above; the app-layer authorization is the
  // agentAuth's canAccessOrg, which resolveEffectiveAgent enforces itself.
  const resolved = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      resolveEffectiveAgent(agentAuth, intent.orgId, agent.kind),
    ),
  );
  if (!resolved) {
    return {
      ok: false,
      errorCode: 'agent_policy_denied',
      details: { reason: 'no effective agent' },
    };
  }
  if (resolved.agentId !== run.agentId) {
    // The baseline row for this org+kind is no longer the run's agent — the
    // approval no longer describes the identity that would execute.
    return {
      ok: false,
      errorCode: 'agent_identity_changed',
      details: { runAgentId: run.agentId, resolvedAgentId: resolved.agentId },
    };
  }

  const candidates = [
    { policy: 'snapshot' as const, effective: run.policySnapshot?.effective },
    { policy: 'current' as const, effective: resolved.effective },
  ];
  for (const { policy, effective } of candidates) {
    // deviceId/deviceSiteId come from the RUN row and the device's CURRENT
    // site — never from tool input. A malformed snapshot fails
    // isAgentGuardrailPolicy inside checkAgentGuardrails and denies, which is
    // the fail-closed shape we want, hence the cast instead of a hand-rolled
    // validator (same shape as intentService's creation-time check).
    const verdict = checkAgentGuardrails(
      intent.actionName,
      intent.arguments as Record<string, unknown>,
      {
        enabled: effective?.enabled,
        mode: effective?.mode,
        toolAllowlist: effective?.toolAllowlist,
        protectedResources: effective?.protectedResources,
        deviceId: run.deviceId ?? null,
        deviceSiteId,
      } as AgentGuardrailPolicy,
    );
    if (verdict.disposition === 'deny') {
      return {
        ok: false,
        errorCode: 'agent_policy_denied',
        details: { policy, reason: verdict.reason ?? 'denied' },
      };
    }
  }

  return { ok: true };
}
