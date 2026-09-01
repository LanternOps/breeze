import type { ActionIntent } from '../../db/schema/actionIntents';
import type { AuthContext } from '../../middleware/auth';
import { getToolTier } from '../aiTools';
import { checkToolPermission } from '../aiGuardrails';
import { getActiveOrgTenant } from '../tenantStatus';
import { policyDecideEnabled } from '../../config/env';
import { validateAuthorizationKeys } from './policyDecidable';
import { buildAuthContextForIntent } from './actorContext';
import { checkAgentReleaseAuthority } from './agentReleaseAuthority';
import { IntentScopeLostError } from './intentTargetScope';
import { canonicalizeArguments, computeArgumentDigest } from './canonicalize';

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
  | { ok: true; auth: AuthContext }
  | { ok: false; errorCode: string; details?: Record<string, unknown> };

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
  return intent.decidedVia === 'policy' || intent.decidedVia === 'ticket_autonomy';
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
  const noApprovalRowRequired = !winningApproval
    && !!intent.requestingAgentRunId
    && isSystemDecided(intent)
    && (intent.decidedVia !== 'policy' || intent.policyDecisionState === 'authorized');

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
  const currentTier = getToolTier(intent.actionName);
  if (currentTier === undefined || currentTier > intent.riskTier) {
    return {
      ok: false,
      errorCode: 'tier_escalated',
      details: { currentTier: currentTier ?? null, intentRiskTier: intent.riskTier },
    };
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

  // The actor must STILL hold the specific RBAC permission the tool
  // requires, checked against the rebuilt `auth` from (c) — not the caller's
  // original, now possibly stale, permission check.
  const permissionDenial = await checkToolPermission(intent.actionName, intent.arguments, auth);
  if (permissionDenial) {
    return { ok: false, errorCode: 'rbac_denied', details: { reason: permissionDenial } };
  }

  return { ok: true, auth };
}
