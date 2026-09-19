import type { ActionIntent } from '../../db/schema/actionIntents';
import type { AuthContext } from '../../middleware/auth';
import { getToolTier } from '../aiTools';
import { checkPermissionRequirements, checkToolPermission } from '../aiGuardrails';
import { loadTenantToolBindingState, loadTenantToolForExecution, type TenantToolDescriptor } from '../toolSources/resolver';
import { tenantToolPermissionRequirement } from '../toolSources/guardrails';
import { getActiveOrgTenant } from '../tenantStatus';
import { policyDecideEnabled } from '../../config/env';
import { validateAuthorizationKeys } from './policyDecidable';
import { buildAuthContextForIntent } from './actorContext';
import { checkAgentReleaseAuthority } from './agentReleaseAuthority';
import { isOrgWideGovernanceIntent } from './orgWideGovernanceTools';
import { canMutateOrgWideGovernance, SITE_CEILING_WRITE_DENIED_MESSAGE } from '../siteCeilingAccess';
import { IntentScopeLostError } from './intentTargetScope';
import { canonicalizeArguments, computeArgumentDigest } from './canonicalize';
import { revalidateScriptReviewerEvidence } from './scriptReviewerAutonomy';
import { checkSweepScheduleBrake } from '../aiAgents/sweepActMode';
import { captureException } from '../sentry';

/**
 * Shared release-time revalidation for an approved action intent (spec
 * docs/superpowers/specs/ai-mcp/2026-07-18-action-intents-approval-layer-design.md
 * §5 step 2). Extracted so the TWO release paths — the durable
 * `jobs/intentReleaseWorker.ts` and the inline chat path in
 * `services/aiAgentSdk.ts` — run the IDENTICAL fail-closed checks. Previously
 * only the worker revalidated; the inline path executed the still-live chat
 * session's tool under the ORIGINAL `session.auth` the moment it won the
 * `approved -> executing` CAS, so a requester demoted, deactivated, or stripped
 * of org access during the approval wait still had their action executed if the
 * live session won the race against the worker.
 *
 * Returns the freshly-rebuilt actor `auth` on success. Callers decide how to
 * EXECUTE: the worker executes under this rebuilt context; the inline chat path
 * executes under its live `session.toolAuth` (which alone carries the
 * session-aware M365/Google connection context — and, for device-bound
 * sessions since #3087, is narrowed to the session/device org, whereas
 * `session.auth` stays the raw login context) — but only AFTER this returns
 * ok, i.e. only once the requester's CURRENT authorization has been
 * re-proven. The rebuilt `auth` and `session.toolAuth` describe the same
 * user + org (accessibleOrgIds === [intent.orgId] === session.orgId), so
 * they are interchangeable for tenant scope; the difference is only that
 * this one reflects live DB state.
 *
 * Every failure carries the same `errorCode` the worker has always CASed
 * `executing -> failed` with, so audit/metrics semantics are unchanged.
 */
export type IntentReleaseRevalidation =
  | {
      ok: true;
      auth: AuthContext;
      /**
       * Tool catalog W01 PR B (#5216): set iff the intent carries an external
       * tool binding (`tool_source_tool_id`). The descriptor the releaser
       * must dispatch through (`executeTenantTool`) — reloaded HERE under
       * the rebuilt actor's owner predicate, so the release never trusts a
       * descriptor a chat session captured hours ago. Absent for every core
       * intent, whose release path is unchanged.
       */
      tenantTool?: TenantToolDescriptor;
    }
  | { ok: false; errorCode: string; details?: Record<string, unknown> };

/**
 * Tool catalog W01 PR B (#5216) — the external-tool half of check (b) below.
 * An approved intent bound to a `tool_source_tools` row + revision may run
 * only if the LIVE row still says what the approver saw:
 *   - row gone / disabled / removed          → `external_tool_disabled`
 *   - source no longer `active`              → `external_tool_source_unavailable`
 *   - revision differs (schema/desc changed) → `external_tool_drift`
 * Classified from an unfiltered by-id read so the audit `error_code` names
 * the cause; the actor-scoped owner/kill-switch reload happens later, in
 * `revalidateExternalToolForActor`, once the rebuilt auth exists.
 */
async function revalidateExternalToolBinding(
  intent: ActionIntent,
): Promise<{ ok: true } | { ok: false; errorCode: string; details?: Record<string, unknown> }> {
  const toolId = intent.toolSourceToolId!;
  // The pairing CHECK makes a half-binding unreachable through the app;
  // treat one as drift rather than comparing against NULL.
  if (!intent.toolRevision) {
    return { ok: false, errorCode: 'external_tool_drift', details: { reason: 'intent carries no tool_revision' } };
  }
  // A THROW here (Postgres blip mid-release) must not escape: the intent is
  // already CAS'd `executing`, the release job carries no BullMQ retry, and an
  // escaping error strands it until the 20-minute stale-executing reaper
  // rewrites the cause as the generic `execution_lost`. Fail closed and
  // CATEGORIZED instead, exactly like the worker's own `digest_check_failed`
  // treatment of a throwing effect-digest recompute — and like
  // `executeTenantToolDetailed`'s own defensive wrapper around this same
  // loader (toolSources/execute.ts).
  let live: Awaited<ReturnType<typeof loadTenantToolBindingState>>;
  try {
    live = await loadTenantToolBindingState(toolId);
  } catch (err) {
    captureException(err instanceof Error ? err : new Error(String(err)));
    return {
      ok: false,
      errorCode: 'external_tool_check_failed',
      details: { toolSourceToolId: toolId, reason: err instanceof Error ? err.message : String(err) },
    };
  }
  if (!live || !live.tool.enabled || live.tool.removedAt) {
    return {
      ok: false,
      errorCode: 'external_tool_disabled',
      details: { toolSourceToolId: toolId, reason: !live ? 'tool row missing' : live.tool.removedAt ? 'tool removed' : 'tool disabled' },
    };
  }
  if (live.source.status !== 'active') {
    return {
      ok: false,
      errorCode: 'external_tool_source_unavailable',
      details: { toolSourceToolId: toolId, sourceId: live.source.id, sourceStatus: live.source.status },
    };
  }
  if (live.tool.revision !== intent.toolRevision) {
    return {
      ok: false,
      errorCode: 'external_tool_drift',
      details: { toolSourceToolId: toolId, approvedRevision: intent.toolRevision, currentRevision: live.tool.revision },
    };
  }
  return { ok: true };
}

/**
 * Wave 5 Part B (#3827) — the policy-evidence checks specific to a
 * `decidedVia: 'policy'` intent, run BEFORE the (DB-backed)
 * `checkAgentReleaseAuthority` call so a cheap, purely-local failure never
 * pays for the extra round trips. NEVER touches `approval_requests` — a
 * policy-decided intent has no approval row BY DESIGN (the whole point of
 * policy-decide is skipping human fanout), and nothing in this module or
 * `policyDecide.ts` ever inserts one; see the plan header's "NEVER synthesize
 * a human approval row" constraint.
 *
 * All three failure kinds share `policy_authorization_revoked` —
 * `checkAgentReleaseAuthority`'s own stricter predicate (agentReleaseAuthority.ts)
 * uses the SAME errorCode for its supervisedActionKeys/mode re-check, so
 * every "the authorization behind this decision no longer holds" failure
 * reads as one thing to an operator scanning `error_code`, not four
 * near-synonyms.
 */
function checkPolicyDecisionEvidence(
  intent: ActionIntent,
): { ok: true } | { ok: false; errorCode: string; details?: Record<string, unknown> } {
  // Provenance present: the five columns `runAuthorizeTransaction` stamps
  // together, atomically, at decision time (policyDecide.ts). Missing any
  // one is a data-integrity anomaly this branch should never legitimately
  // reach — fail closed rather than trust a partial record.
  if (
    !intent.policyAuthorizationKey
    || !intent.policySnapshotDigest
    || intent.policyClassificationVersion === null
    || !intent.policyReservationId
    || intent.policyKillEpoch === null
    || intent.policyKillEpoch === undefined
  ) {
    return {
      ok: false,
      errorCode: 'policy_authorization_revoked',
      details: { reason: 'policy decision provenance is incomplete' },
    };
  }

  // The mechanism itself must still be live — an operator emergency-flipping
  // BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED off must stop an already-
  // authorized-but-not-yet-released intent from executing unattended, same
  // as it stops a new one from ever being attempted (policyDecide.ts).
  if (!policyDecideEnabled()) {
    return {
      ok: false,
      errorCode: 'policy_authorization_revoked',
      details: { reason: 'policy-decide is disabled' },
    };
  }

  // The registry entry that authorized this key must still exist AND still
  // be headlessCompatible/non-four_eyes/non-secret — `validateAuthorizationKeys`
  // is the SAME defense-in-depth re-classification `attemptPolicyDecision`
  // ran at decision time (policyDecidable.ts), re-run here against whatever
  // POLICY_DECIDABLE_TIER3 looks like NOW. A registry drop between decision
  // and release is exactly what this catches.
  const registryCheck = validateAuthorizationKeys([intent.policyAuthorizationKey]);
  if (registryCheck.ok.length === 0) {
    return {
      ok: false,
      errorCode: 'policy_authorization_revoked',
      details: {
        key: intent.policyAuthorizationKey,
        reason: registryCheck.rejected[0]?.reason ?? 'no longer registered in POLICY_DECIDABLE_TIER3',
      },
    };
  }

  return { ok: true };
}

/**
 * P2-4 Task A3 (#4191) — a `decidedVia: 'ticket_autonomy'` row (creation-
 * transaction ticket autonomy, `services/actionIntents/ticketAutonomy.ts`)
 * shares the policy-decided row's defining shape: no `approval_requests`
 * row by construction, no human ever reviewed it. Unlike a policy-decided
 * row, it carries NONE of the five `policyAuthorizationKey`/
 * `policySnapshotDigest`/`policyClassificationVersion`/`policyReservationId`/
 * `policyKillEpoch` provenance columns — those are written ONLY by
 * `runAuthorizeTransaction` (policyDecide.ts) — so `checkPolicyDecisionEvidence`
 * (policy-specific: it re-validates the POLICY_DECIDABLE_TIER3 registry
 * entry) must never run for one; release authority for it comes entirely
 * from `checkAgentReleaseAuthority`'s own structural re-check below, same as
 * every human-approved agent intent.
 */
function isSystemDecided(intent: ActionIntent): boolean {
  return intent.decidedVia === 'policy'
    || intent.decidedVia === 'ticket_autonomy'
    // W04 (#5612): the unattended script lane. Same defining shape — no
    // approval_requests row by construction, no human ever reviewed it —
    // decided at creation like ticket_autonomy, not by a post-commit attempt.
    || intent.decidedVia === 'script_reviewer';
}

export async function revalidateApprovedIntentForRelease(
  intent: ActionIntent,
  winningApproval: { boundArgumentDigest: string | null } | null,
): Promise<IntentReleaseRevalidation> {
  // Wave 5 Part B (#3827): a policy-decided intent has NO approval_requests
  // row by construction — `runAuthorizeTransaction` (policyDecide.ts) CASes
  // straight to `approved` and NEVER inserts one, so `winningApproval` being
  // null here is the EXPECTED shape for one of these, not a release-time
  // integrity failure. Detected off the intent's own columns, immutable
  // once Part B's decision path writes them (never re-derived, never a
  // synthetic stand-in for a human decision).
  //
  // Review fix: `requestingAgentRunId` MUST be part of this predicate.
  // Policy-decide only ever authorizes agent-originated proposals
  // (attemptPolicyDecision requires a run), so a row with these three
  // columns set but no run is exactly the tamper shape defense-in-depth (a2)
  // above exists to catch (superuser write, disabled immutability trigger,
  // restore) — without this clause such a row would have BOTH the
  // approval-row gate below (a) AND the entire evidence/authority branch at
  // (e) skipped, since both of those only run inside
  // `if (intent.requestingAgentRunId)`, and fall through to plain user RBAC
  // with no approval row and no policy evidence at all.
  //
  // P2-4 Task A3 (#4191): widened to `isSystemDecided` (`decidedVia ===
  // 'policy' || 'ticket_autonomy'`) — a ticket_autonomy row is the SAME
  // "no human ever reviewed this, do not require an approval row" shape,
  // just decided at creation time rather than by a post-commit attempt.
  // `policyDecisionState === 'authorized'` is deliberately NOT required for
  // the ticket_autonomy half: that column's three-value CHECK
  // ('unattempted'|'authorized'|'human_required') is policy-decide's own
  // lifecycle — a ticket_autonomy row stamps `policyDecisionState:
  // 'human_required'` at creation (the `resolvePolicyDecisionState` stub
  // forces it whenever a scope is present) and is never touched by
  // `attemptPolicyDecision`, so requiring 'authorized' here would make this
  // branch permanently unreachable for it.
  const isPolicyDecided = !winningApproval
    && !!intent.requestingAgentRunId
    && intent.decidedVia === 'policy'
    && intent.policyDecisionState === 'authorized';
  // Widened via `isSystemDecided`: a ticket_autonomy row needs no
  // `policyDecisionState` check at all (see the comment above) — the extra
  // `intent.decidedVia !== 'policy'` clause keeps this OR from re-admitting
  // an `authorized: false` policy row through the back door.
  //
  // W04 (#5612): `requestingAgentRunId` is required for the POLICY and
  // TICKET branches (policy-decide only ever authorizes agent proposals, and
  // a row carrying those columns without a run is the tamper shape the
  // clause exists to catch). The SCRIPT LANE covers chat sessions too
  // (spec D1/§4.6 "Release"), so a chat-origin lane intent has no run id by
  // design — and would fail `digest_mismatch` here against an approval row
  // that never existed.
  //
  // The run-id clause is therefore scoped to the two branches that need it,
  // and the lane substitutes a STRONGER proof: a typed evidence blob that
  // revalidates against current policy, proposal, review, circuit, authority
  // and device state (`revalidateScriptReviewerEvidence`). A forged row with
  // `decided_via = 'script_reviewer'` and no valid evidence fails there and
  // never reaches the exception. Only consulted when no approval row exists:
  // a lane row that somehow has one takes the ordinary human path
  // (defense-in-depth: never both).
  const laneEvidence = !winningApproval && intent.decidedVia === 'script_reviewer'
    ? await revalidateScriptReviewerEvidence(intent)
    : null;
  if (laneEvidence && !laneEvidence.ok) {
    return { ok: false, errorCode: 'lane_revoked', details: { reason: laneEvidence.reason } };
  }

  // #4442 W04 §3.6 — the ORDINARY brake. The release checks above cover the
  // policy flag, the registry entry and the key authorization but know nothing
  // of SCHEDULES, so flipping `act_mode` off could not revoke an intent that
  // is already `approved`. Narrowly scoped, on purpose:
  //   - `trigger_kind === 'sweep_finding'` — no other lane has a schedule;
  //   - `decidedVia === 'policy'` — a sweep card a HUMAN approved is a human
  //     decision, not policy autonomy, and must not be revoked by this.
  // The brake also re-checks the sub-flag itself, for the same reason
  // `checkPolicyDecisionEvidence` re-checks `policyDecideEnabled()` above.
  const sweepBrake = intent.triggerKind === 'sweep_finding' && intent.decidedVia === 'policy'
    ? await checkSweepScheduleBrake(intent)
    : null;
  if (sweepBrake && !sweepBrake.ok) {
    return { ok: false, errorCode: 'agent_policy_denied', details: { reason: sweepBrake.reason } };
  }

  const noApprovalRowRequired = !winningApproval
    && isSystemDecided(intent)
    && (intent.decidedVia === 'script_reviewer'
      ? laneEvidence?.ok === true
      : !!intent.requestingAgentRunId
        && (intent.decidedVia !== 'policy' || intent.policyDecisionState === 'authorized'));

  if (!noApprovalRowRequired) {
    // (a) UNCHANGED — the human-approval-row path, byte-identical to every
    // release before this wave. The winning approval row must still exist
    // and must have approved the SAME content the intent currently carries
    // (action_intents content is DB-immutable; this is defense-in-depth).
    if (!winningApproval || winningApproval.boundArgumentDigest !== intent.argumentDigest) {
      return { ok: false, errorCode: 'digest_mismatch' };
    }
  }
  // (a2) Recompute the digest FROM the stored arguments. The comparison above
  // is two stored strings; it cannot detect a write that changed `arguments`
  // while leaving `argument_digest` alone. The immutability trigger makes that
  // unreachable through the app, so this is defense-in-depth against a path
  // that bypassed it (superuser, disabled trigger, restore). Deliberately
  // compares against the STORED digest — the value the approval bound — never
  // a fresh computation used as its own authority (§5.2).
  const recomputed = computeArgumentDigest(
    canonicalizeArguments(intent.arguments as Record<string, unknown>),
  );
  if (recomputed !== intent.argumentDigest) {
    return { ok: false, errorCode: 'digest_mismatch' };
  }

  // (b) The tool must still exist and must not have been reclassified to a
  // HIGHER tier since the intent was created (lower/equal only tightens what
  // the approval covered).
  //
  // Tool catalog W01 PR B (#5216): an EXTERNAL tool has no entry in the core
  // registry (`getToolTier` would answer `undefined` for a `<slug>__<name>`
  // and fail every such release as `tier_escalated`). Its "still exists and
  // unchanged" check is the live `tool_source_tools` row instead; the tier
  // is fixed at 3 by construction (createActionIntent only accepts Tier-3
  // external bindings).
  const isExternalTool = !!intent.toolSourceToolId;
  if (isExternalTool) {
    const binding = await revalidateExternalToolBinding(intent);
    if (!binding.ok) return binding;
  } else {
    const currentTier = getToolTier(intent.actionName);
    if (currentTier === undefined || currentTier > intent.riskTier) {
      return {
        ok: false,
        errorCode: 'tier_escalated',
        details: { currentTier: currentTier ?? null, intentRiskTier: intent.riskTier },
      };
    }
  }

  // (c) The actor must still be valid: rebuild the AuthContext from scratch,
  // re-checking the user is active and still has access to intent.orgId.
  //
  // P2-2 (#4189): the rebuild runs BEFORE the agent-authority check in (e),
  // so it — not `checkAgentReleaseAuthority` — is what actually observes a
  // lost device scope first. `IntentScopeLostError` is the one typed
  // exception it raises (everything else still collapses to `null` ⇒
  // `actor_invalid`); mapping it here keeps the terminal errorCode
  // `agent_scope_lost` rather than letting it escape as an unhandled throw
  // that BullMQ would redeliver forever for a device that is never coming
  // back. `checkAgentReleaseAuthority` returns the SAME code for the case
  // where it gets there first (a policy-decided intent, or a future caller
  // that skips this step).
  let auth: AuthContext | null;
  try {
    auth = await buildAuthContextForIntent(intent);
  } catch (error) {
    if (error instanceof IntentScopeLostError) {
      return { ok: false, errorCode: error.code, details: { reason: error.message } };
    }
    throw error;
  }
  if (!auth) {
    return { ok: false, errorCode: 'actor_invalid' };
  }

  // (d) The org (and its owning partner) must still be active.
  const activeOrg = await getActiveOrgTenant(intent.orgId);
  if (!activeOrg) {
    return { ok: false, errorCode: 'org_inactive' };
  }

  // (e) Authority re-check. For an AGENT-originated intent there is no user
  // RBAC to consult — checkToolPermission denies the ai_agent principal as
  // its first statement, and that deny is deliberately untouched. Release
  // branches into the STRUCTURAL authority check instead: the stricter
  // combination of the run's immutable policy_snapshot and the agent's
  // CURRENT effective policy (agentReleaseAuthority.ts).
  if (intent.requestingAgentRunId) {
    // Wave 5 Part B (#3827): policy-decision evidence FIRST — purely local
    // (env read + a frozen-array lookup, no I/O), so a stale/revoked
    // registry entry or a flag flip fails fast without paying for
    // `checkAgentReleaseAuthority`'s several round trips. A HUMAN-approved
    // agent intent (decidedVia !== 'policy') skips this entirely and reaches
    // `checkAgentReleaseAuthority` exactly as it always has.
    if (isPolicyDecided) {
      const evidence = checkPolicyDecisionEvidence(intent);
      if (!evidence.ok) {
        return evidence;
      }
    }
    const authority = await checkAgentReleaseAuthority(intent);
    if (!authority.ok) {
      return authority;
    }
    return { ok: true, auth };
  }

  // (f) Site / exact-device ceiling on ORG-WIDE GOVERNANCE intents — the
  // release-time twin of the raise gate in `createActionIntent`.
  //
  // `createActionIntent` refuses a ceilinged RAISER, but the ceiling is
  // mutable state: a technician who was unrestricted when they raised an
  // identity-tenant mutation can be confined to a site during the approval
  // wait. The rebuilt `auth` from (c) carries the LIVE `allowedSiteIds`
  // (actorContext.ts re-derives it from the DB), so checking it here is what
  // makes the ceiling hold across the durable boundary — and it is the only
  // check that can, because the m365/google release path dispatches through
  // the HEADLESS `*Action` functions, which take no AuthContext at all and so
  // never reach the in-handler gate.
  //
  // RBAC alone does not cover this: `organizations:write` is exactly what a
  // site-restricted org technician legitimately holds for their own sites.
  //
  // Agent-originated intents returned above: they have no user RBAC to
  // consult and are governed by `checkAgentReleaseAuthority` instead. No
  // agent can reach these tools anyway — every m365/google tool is
  // session-only, so `listAgentReachableTools` excludes the whole surface.
  if (isOrgWideGovernanceIntent(intent.actionName, intent.arguments) && !canMutateOrgWideGovernance(auth)) {
    return {
      ok: false,
      errorCode: 'site_ceiling',
      details: { reason: SITE_CEILING_WRITE_DENIED_MESSAGE },
    };
  }

  // The actor must STILL hold the specific RBAC permission the tool
  // requires, checked against the rebuilt `auth` from (c) — not the caller's
  // original, now possibly stale, permission check.
  if (isExternalTool) {
    // Tool catalog W01 PR B (#5216): `checkToolPermission` keys on the core
    // registry and would deny a qualified name outright. External tools
    // carry the generic `external_tools:write` grant (Tier 3), the same
    // requirement the chat PreToolUse gate applied at creation.
    const permissionDenial = await checkPermissionRequirements(auth, [tenantToolPermissionRequirement(3)]);
    if (permissionDenial) {
      return { ok: false, errorCode: 'rbac_denied', details: { reason: permissionDenial } };
    }
    return revalidateExternalToolForActor(intent, auth);
  }
  const permissionDenial = await checkToolPermission(intent.actionName, intent.arguments, auth);
  if (permissionDenial) {
    return { ok: false, errorCode: 'rbac_denied', details: { reason: permissionDenial } };
  }

  return { ok: true, auth };
}

/**
 * Tool catalog W01 PR B (#5216) — the last external-tool stop: the
 * dispatch-time reload under the REBUILT actor's owner predicate, which is
 * also where the `TOOL_SOURCES_ENABLED` kill switch is enforced
 * (`loadTenantToolForExecution`). A `null` here after the binding
 * classification above passed means the tool is no longer visible to THIS
 * actor (owner mismatch after an org move, flag flipped off, or a descriptor
 * that no longer compiles) — none of which the approver's org-pinned row can
 * be released against. Reported as `external_tool_disabled`: to the operator
 * the tool is gone, whichever gate removed it.
 */
async function revalidateExternalToolForActor(
  intent: ActionIntent,
  auth: AuthContext,
): Promise<IntentReleaseRevalidation> {
  let loaded: Awaited<ReturnType<typeof loadTenantToolForExecution>>;
  try {
    loaded = await loadTenantToolForExecution(intent.toolSourceToolId!, auth);
  } catch (err) {
    // Same reasoning as `revalidateExternalToolBinding`'s wrapper: a thrown
    // reload is an infrastructure fault, not a revocation, and must not be
    // reported as one — nor allowed to strand the claimed intent.
    captureException(err instanceof Error ? err : new Error(String(err)));
    return {
      ok: false,
      errorCode: 'external_tool_check_failed',
      details: { toolSourceToolId: intent.toolSourceToolId, reason: err instanceof Error ? err.message : String(err) },
    };
  }
  if (!loaded) {
    return {
      ok: false,
      errorCode: 'external_tool_disabled',
      details: { toolSourceToolId: intent.toolSourceToolId, reason: 'tool not resolvable for the releasing actor' },
    };
  }
  return { ok: true, auth, tenantTool: loaded.descriptor };
}
