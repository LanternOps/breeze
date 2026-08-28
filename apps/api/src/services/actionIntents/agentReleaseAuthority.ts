import { eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { aiAgentRuns, aiAgents } from '../../db/schema/aiAgents';
import { organizations } from '../../db/schema/orgs';
import { devices } from '../../db/schema/devices';
import type { ActionIntent } from '../../db/schema/actionIntents';
import { checkAgentGuardrails, type AgentGuardrailPolicy } from '../aiGuardrails';
import { readAiKillState } from '../aiKillState';
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

  // Wave-5A review fix (#3827): refresh THIS lane's own kill-state read,
  // mirroring actRevalidation.ts's Step 2 refresh, immediately before the
  // guardrail re-run below — rather than relying solely on whatever run
  // admission or an act-mode dispatch last cached into the shared
  // module-level snapshot `checkAgentGuardrails` reads (`aiKillState.ts`'s
  // `getCachedAiKillStateSnapshot`). `readAiKillState()` is a *shared*,
  // TTL-cached read (`aiKillState.ts:112-114` returns `cachedSnapshot`
  // unconditionally within the 5s TTL, regardless of which lane populated
  // it) — this call does NOT isolate release from another lane's fail-closed
  // poisoning within that window; a bad read 1s ago from run-admission or an
  // act-mode dispatch still flows through here unchanged. What this call
  // buys instead: it bounds this read's own staleness to the 5s TTL (rather
  // than relying entirely on an upstream caller to have refreshed it), and
  // it warms the snapshot when release is the only active lane in the
  // process. Per-lane isolation would need a force-refresh parameter on
  // `readAiKillState()` that bypasses the TTL — not implemented here.
  const killState = await readAiKillState();

  // Wave 5 Part B (#3827): for a policy-decided intent, "not denied" is not
  // the bar release must clear — no human ever reviewed this call, so the
  // ONLY thing standing in for a decision is the operator's own
  // `supervisedActionKeys` opt-in, re-checked here exactly like Task 2's
  // `attemptPolicyDecision` re-checked it at decision time (mode === 'act'
  // AND the stored key still listed). `checkAgentGuardrails` returns
  // 'propose' — not 'deny' — for a POLICY_DECIDABLE_TIER3 key that isn't
  // also matched by the (disjoint) act-mode manifest, and 'propose' for a
  // mutating call under `mode: 'shadow'` too; both mean "record a proposal
  // for a human", which is meaningless with no human in the loop. Treating
  // either as an ok verdict here would let a downgrade to shadow, or an
  // operator opting a key back out, execute unattended anyway as long as
  // guardrails merely declined to hard-deny it.
  const isPolicyDecided = intent.decidedVia === 'policy';

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
      // `killState.killed` (this lane's own fresh read, just above) is the
      // ONLY thing that can make `checkAgentGuardrails` deny at its kill-state
      // step — that step runs before the enabled/mode/allowlist checks below
      // it, so whenever it's true every candidate denies for that reason.
      // Distinct, NON-terminal error code: jobs/intentReleaseWorker.ts
      // branches this away from `failIntent`, CASing the intent back to
      // `approved` instead of `failed` — a transient DB outage on this read
      // or a real kill-switch flip must PAUSE an already-human-approved
      // intent, never permanently destroy it. Every other structural denial
      // here (narrowed allowlist, disabled agent, mode off, site drift, the
      // env-flag kill switch, …) stays 'agent_policy_denied' and IS terminal.
      if (killState.killed) {
        return {
          ok: false,
          errorCode: 'kill_switch_engaged',
          details: { policy, epoch: killState.epoch, reason: verdict.reason ?? 'denied' },
        };
      }
      return {
        ok: false,
        errorCode: 'agent_policy_denied',
        details: { policy, reason: verdict.reason ?? 'denied' },
      };
    }

    if (isPolicyDecided) {
      const authorizedKeys = effective?.actAssets?.supervisedActionKeys ?? [];
      const keyStillAuthorized = effective?.mode === 'act'
        && !!intent.policyAuthorizationKey
        && authorizedKeys.includes(intent.policyAuthorizationKey);
      if (!keyStillAuthorized) {
        // Terminal, like `agent_policy_denied` (never the kill-derived,
        // pausable code) — a revoked opt-in is a real, durable decision
        // change, not a transient blip. `revalidateApprovedIntentForRelease`
        // uses this SAME errorCode for its own registry/provenance/flag
        // checks (see revalidateRelease.ts) so every "the authorization
        // behind this decision no longer holds" failure reads as one thing.
        return {
          ok: false,
          errorCode: 'policy_authorization_revoked',
          details: { policy, key: intent.policyAuthorizationKey, mode: effective?.mode },
        };
      }
    }
  }

  // Review fix: kill-epoch sanity. `intent.policyKillEpoch` is the epoch
  // `runAuthorizeTransaction` stamped into the intent, atomically, at
  // authorization time (policyDecide.ts) — the plan's architecture line
  // calls this check out by name ("kill-epoch sanity") specifically because
  // `killState.killed` alone is NOT enough: an operator can hit the
  // emergency kill (epoch N -> N+1) and then CLEAR it (epoch N+1 -> N+2)
  // before this unattended release is delivered, and `killState.killed`
  // would read false throughout. Comparing the epoch instead of the flag
  // means ANY kill-and-clear cycle since authorization revokes it, exactly
  // as the durable epoch — rather than a boolean — is supposed to.
  // Deliberately placed AFTER the candidates loop above, not alongside the
  // `killState.killed` read: a genuinely LIVE kill must still surface as
  // `kill_switch_engaged` (pausable) via that loop, never get preempted by
  // this terminal epoch check — an epoch bump caused by the kill itself
  // would otherwise race this comparison and misreport a live pause as a
  // stale, non-recoverable revocation. This only fires once every candidate
  // has already cleared cleanly. Terminal, not kill-derived-pausable: the
  // agent re-proposes fresh on its next run rather than sitting `approved`
  // waiting for an epoch that will never come back down.
  if (isPolicyDecided && killState.epoch !== intent.policyKillEpoch) {
    return {
      ok: false,
      errorCode: 'policy_authorization_revoked',
      details: {
        reason: 'kill epoch advanced since authorization',
        authorizedEpoch: intent.policyKillEpoch,
        currentEpoch: killState.epoch,
      },
    };
  }

  return { ok: true };
}
