import { createHash } from 'crypto';
import { and, eq, isNull } from 'drizzle-orm';

import type { AssuranceLevel, RiskTier } from '@breeze/shared';
import { db } from '../../db';
import { authenticatorDevices } from '../../db/schema';
import {
  mintStepUpGrant,
  readStepUpGrant,
  type StepUpGrantBinding,
} from '../mfaStepUpGrant';
import type { AssuranceDecision } from '../authenticatorAssurance';

/**
 * The `approval_decide` "recent ceremony" grant (#5601) — the approvals-domain
 * half of the credential whose transport lives in `services/mfaStepUpGrant.ts`.
 *
 * WHY: approving several Tier-3 AI chat tool calls in a row cost one full
 * passkey ceremony per approval row (three in 20 seconds, observed on US prod
 * 2026-09-11). #5600 removes the ceremony for SUPERVISED rows under a
 * NON-ENFORCING partner, at the cost of recording them L1/session_tap. This
 * covers the two cases that deliberately keeps: four_eyes sole-operator
 * self-approve (must stay >= L3) and supervised rows under an ENFORCING
 * partner policy (whose step-up floor must not be bypassed).
 *
 * The house position rejects a bare wall-clock grace window
 * (plans/security-auth/2026-09-02-mobile-platform-attestation-l4.md: "A dated
 * grace window is rejected outright"). This is not one: it is a credential,
 * minted only by a real ceremony, bound to identity/session/factor-epochs and
 * a resource digest, stored server-side, and recorded distinctly in audit.
 *
 * Full design + the Codex advisor review that reshaped it:
 * docs/superpowers/specs/security-auth/2026-09-11-approval-decide-step-up-grant.md
 */

/**
 * Absolute age bound, measured from the CEREMONY, not from the Redis write.
 *
 * Redis starts its own TTL when it receives the SETEX, which is after the
 * ceremony AND after the decide transaction — so leaning on TTL alone would
 * silently mean "300s since mint" rather than "300s since the human touched
 * the sensor". Mirrors the same belt-and-braces shape `escalateAchievedLevel`
 * already applies for APPROVAL_CHALLENGE_TTL_MS: Redis expiry stays the
 * backstop, this is the explicit bound. Deliberately equal to the grant
 * module's own TTL_SECONDS (300) rather than a second, drifting number.
 */
export const APPROVAL_DECIDE_GRANT_TTL_MS = 300_000;

/** The minimum a ceremony must have achieved for its grant to be worth
 *  minting. Below L3 the grant could not satisfy the four_eyes sole-operator
 *  gate — the whole reason the credential exists — so an L2-only proof mints
 *  nothing rather than a credential that can only ever be refused. */
const MIN_GRANTABLE_LEVEL = 3;

/**
 * What the ceremony achieved, carried across the reuse window inside the
 * grant record's server-written `context`.
 *
 * These are facts about a ceremony that REALLY HAPPENED, which is why a
 * redeemed row may honestly keep them. What must never be implied is that a
 * SECOND ceremony happened — that is what `decidedViaStepUpGrant` on the
 * decision, and the `decided_via_step_up_grant` column, exist to say.
 */
export interface ApprovalDecideGrantContext {
  decidedAssuranceLevel: Exclude<AssuranceLevel, 1>;
  decidedVia: 'webauthn_platform' | 'mobile_hw_key';
  authenticatorDeviceId: string;
  /** Epoch-ms the ceremony was verified. The clock for the age bound above. */
  ceremonyAt: number;
}

/** The conversation/tenancy/severity scope a grant is pinned to. */
export interface ApprovalDecideScope {
  /** `action_intents.requesting_agent_run_id` — set only for an `ai_agent`
   *  principal (intentService.ts). NULL for web AI chat. */
  agentRunId: string | null;
  /** `ai_tool_executions.session_id` for the execution stamped with this
   *  intent — the authoritative conversation id for a chat-originated intent,
   *  which is the flow that motivated #5601. NULL for a non-chat intent. */
  aiSessionId: string | null;
  orgId: string;
  riskTier: RiskTier;
}

/**
 * Is this row eligible to mint or redeem a grant at all?
 *
 * TWO independent refusals, and both matter:
 *
 *  1. `critical` is excluded outright. L4 means "the human proved themselves
 *     again, JUST NOW, for this one" — a platform-bound key plus a fresh
 *     account re-authentication at the decide surface. A reusable credential
 *     is incompatible with that claim, and asserting L4 from a 4-minute-old
 *     grant would be exactly the audit dishonesty this design forbids. (The
 *     tier is also in the digest, so a `high` grant cannot match a `critical`
 *     row either — belt and braces.)
 *
 *  2. A row with NEITHER conversation identifier is refused. Without this the
 *     digest would have a catch-all "neither" bucket that every intent in an
 *     org would share, and the conversation binding — the single most
 *     important component of the scope — would be decorative for exactly the
 *     flow it exists to bound. This is the Codex advisor review's blocking
 *     finding: web AI chat calls `createActionIntent(session.auth, ...)` with
 *     the HUMAN's auth (aiAgentSdk.ts), so `requesting_agent_run_id` is null
 *     there and `agentRunId` alone would have bounded nothing.
 */
export function isApprovalDecideGrantEligible(scope: ApprovalDecideScope): boolean {
  if (scope.riskTier === 'critical') return false;
  return scope.agentRunId !== null || scope.aiSessionId !== null;
}

/**
 * Canonical digest for an `approval_decide` grant.
 *
 * Canonicalization is part of the security contract, not a convenience: mint
 * and redeem must produce byte-identical input for the same scope, so this is
 * the ONE function both call. Keys are emitted in fixed alphabetical order
 * because JSON.stringify preserves insertion order, which would otherwise let
 * two equivalent scopes hash differently — same reasoning as
 * `maintenanceResourceDigest`.
 *
 * Each component removes a distinct escalation:
 *  - agentRunId + aiSessionId: the operator's attention is scoped to ONE
 *    conversation, so the credential must be too. Without it, a ceremony for
 *    a chat being actively watched would cover a Tier-3 request raised four
 *    minutes later by a different conversation — including a background run
 *    nobody looked at.
 *  - orgId: the tenancy boundary. A technician approving for Org A must never
 *    have that ceremony silently cover Org B's Tier-3 action.
 *  - riskTier: the severity boundary. `requiredAssurance` is a function of the
 *    tier, so pinning it makes achieved-vs-required an identity rather than an
 *    inequality that could drift.
 *
 * Deliberately NOT included: the approval id and the argument digest. Either
 * would make the grant single-row by construction and defeat the feature. The
 * per-row `boundArgumentDigest` check in the decide core keeps CONTENT binding
 * intact; this grant binds AUTHORITY TO DECIDE, not what was decided.
 */
export function approvalDecideResourceDigest(scope: ApprovalDecideScope): `sha256:${string}` {
  const canonical = JSON.stringify({
    agentRunId: scope.agentRunId,
    aiSessionId: scope.aiSessionId,
    orgId: scope.orgId,
    riskTier: scope.riskTier,
  });
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

/** Build the full grant binding for a scope. One helper so mint and redeem
 *  cannot drift in either the digest or the operation label. */
export function approvalDecideGrantBinding(input: {
  userId: string;
  authEpoch: number;
  mfaEpoch: number;
  sid: string;
  scope: ApprovalDecideScope;
}): StepUpGrantBinding {
  return {
    userId: input.userId,
    operation: 'approval_decide',
    authEpoch: input.authEpoch,
    mfaEpoch: input.mfaEpoch,
    sid: input.sid,
    resourceDigest: approvalDecideResourceDigest(input.scope),
  };
}

/**
 * Mint a grant from a decision that just committed on a GENUINE ceremony.
 *
 * Refuses (returns null, never throws) unless the decision really was a
 * ceremony worth reusing: an L1 session tap, an L2-only proof, a
 * `skipAssuranceLadder` supervised decide, and a decide that itself REDEEMED a
 * grant all mint nothing. That last refusal is load-bearing — it is what stops
 * the window ratcheting forward indefinitely as the operator keeps clicking,
 * and is what keeps this a bounded credential rather than a renewable session.
 *
 * Best effort by contract: `mintStepUpGrant` already fails closed to null on a
 * Redis fault, and a missing grant only costs the operator another ceremony.
 * A mint failure must NEVER fail an approval that has already committed.
 */
export async function mintApprovalDecideGrant(input: {
  userId: string;
  authEpoch: number;
  mfaEpoch: number;
  sid: string;
  scope: ApprovalDecideScope;
  assurance: AssuranceDecision;
}): Promise<string | null> {
  const { assurance, scope } = input;
  if (!isApprovalDecideGrantEligible(scope)) return null;
  // A redeemed decision is a ceremony that happened EARLIER, already
  // represented by the grant being redeemed. Re-minting from it would slide
  // the window.
  if (assurance.stepUpGrantReuse) return null;
  if (assurance.decidedVia === 'session_tap') return null;
  if (assurance.decidedAssuranceLevel < MIN_GRANTABLE_LEVEL) return null;
  if (assurance.authenticatorDeviceId === null) return null;

  const context: ApprovalDecideGrantContext = {
    decidedAssuranceLevel: assurance.decidedAssuranceLevel,
    decidedVia: assurance.decidedVia,
    authenticatorDeviceId: assurance.authenticatorDeviceId,
    ceremonyAt: Date.now(),
  };
  return mintStepUpGrant(
    approvalDecideGrantBinding({
      userId: input.userId,
      authEpoch: input.authEpoch,
      mfaEpoch: input.mfaEpoch,
      sid: input.sid,
      scope,
    }),
    context,
  );
}

/** Shape-guard the server-written context. A record we cannot describe is a
 *  record we cannot trust — same fail-closed stance as `toMobileKeyAlg`'s
 *  unrecognised-label branch. */
function parseGrantContext(raw: unknown): ApprovalDecideGrantContext | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const c = raw as Record<string, unknown>;
  const level = c.decidedAssuranceLevel;
  const via = c.decidedVia;
  const deviceId = c.authenticatorDeviceId;
  const ceremonyAt = c.ceremonyAt;
  if (level !== 2 && level !== 3 && level !== 4) return null;
  if (via !== 'webauthn_platform' && via !== 'mobile_hw_key') return null;
  if (typeof deviceId !== 'string' || deviceId.length === 0) return null;
  if (typeof ceremonyAt !== 'number' || !Number.isFinite(ceremonyAt)) return null;
  return {
    decidedAssuranceLevel: level,
    decidedVia: via,
    authenticatorDeviceId: deviceId,
    ceremonyAt,
  };
}

/**
 * Redeem a grant in place of running the assertion ladder.
 *
 * Returns the assurance the ORIGINAL ceremony achieved, flagged
 * `stepUpGrantReuse`, or `null` on ANY failure — expired, wrong binding,
 * wrong digest, ineligible scope, revoked approver device, malformed context,
 * Redis down. The caller must treat null as `403 step_up_required` and NEVER
 * fall through to an L1 session tap: letting an expired credential become a
 * session tap is precisely the silent assurance downgrade this design exists
 * to prevent.
 *
 * NON-CONSUMING by design (`readStepUpGrant` → GET, not GETDEL). This is the
 * only multi-use step-up operation in the codebase; see the `approval_decide`
 * note in services/mfaStepUpGrant.ts for why that is safe here.
 *
 * `requiredLevel` is NOT recovered from the grant — the caller recomputes it
 * from the CURRENT partner policy, so a partner who raises their floor
 * mid-window invalidates outstanding grants in effect without anyone reaching
 * into Redis.
 */
export async function redeemApprovalDecideGrant(input: {
  grantId: string;
  userId: string;
  authEpoch: number;
  mfaEpoch: number;
  sid: string;
  scope: ApprovalDecideScope;
  now?: number;
}): Promise<{ context: ApprovalDecideGrantContext } | null> {
  if (!isApprovalDecideGrantEligible(input.scope)) return null;

  const record = await readStepUpGrant(
    input.grantId,
    approvalDecideGrantBinding({
      userId: input.userId,
      authEpoch: input.authEpoch,
      mfaEpoch: input.mfaEpoch,
      sid: input.sid,
      scope: input.scope,
    }),
  );
  if (!record) return null;

  const context = parseGrantContext(record.context);
  if (!context) return null;
  if (context.decidedAssuranceLevel < MIN_GRANTABLE_LEVEL) return null;

  // Absolute age from the ceremony (see APPROVAL_DECIDE_GRANT_TTL_MS). A
  // negative age (clock skew, a forged-forward ceremonyAt) is refused too
  // rather than read as "very fresh".
  const ageMs = (input.now ?? Date.now()) - context.ceremonyAt;
  if (ageMs < 0 || ageMs > APPROVAL_DECIDE_GRANT_TTL_MS) return null;

  // The approver device must STILL be live. Disabling a device sets
  // `disabled_at` WITHOUT bumping authEpoch/mfaEpoch (routes/authenticator.ts),
  // so the epoch binds alone do not catch this — while a FRESH assertion would
  // be refused outright (authenticatorAssurance.ts filters on
  // isNull(disabledAt)). Without this check, revoking a lost laptop's passkey
  // would leave up to 300s of continued L3 approvals on the revoked factor.
  const [device] = await db
    .select({ id: authenticatorDevices.id })
    .from(authenticatorDevices)
    .where(
      and(
        eq(authenticatorDevices.id, context.authenticatorDeviceId),
        eq(authenticatorDevices.userId, input.userId),
        isNull(authenticatorDevices.disabledAt),
      ),
    )
    .limit(1);
  if (!device) return null;

  return { context };
}
