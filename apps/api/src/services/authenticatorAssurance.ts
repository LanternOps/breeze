import { and, eq, isNull } from 'drizzle-orm';
import {
  requiredAssurance,
  elevationRiskTierToName,
  type RiskTier,
  type AssuranceLevel,
  type ApprovalProof,
} from '@breeze/shared';
import { db } from '../db';
import { authenticatorDevices } from '../db/schema';
import type { PlatformBoundBasis } from '../db/schema/authenticatorDevices';
import { authenticatorAttestationEnforced } from '../config/env';
import { recordAuthenticatorL4Basis } from './anomalyMetrics';
import { verifyApprovalAssertion } from './approverWebAuthn';
import { verifyMobileSignature, consumeMobileAssertionNonce, toMobileKeyAlg } from './mobileHwKey';
import { loadPartnerPolicy, isEnforcing } from './authenticatorPolicy';

/**
 * Recency window for the L3/L4 ladder: an approval-assertion challenge must be
 * CONSUMED within this window of being issued for the signature to count as
 * "fresh" (spec §5). Matches the 120s Redis challenge TTL — the L2 signature is
 * already per-request and short-lived; this is the explicit server-side bound.
 */
export const APPROVAL_CHALLENGE_TTL_MS = 120_000;

/**
 * The ONLY `platform_bound_basis` values that may reach L4 (critical tier) —
 * #1374. Reading `is_platform_bound` alone is NOT sufficient and never will be
 * again: pre-#1374 mobile registration forced that boolean true with no
 * attestation of any kind, so a software RSA key presented as an L4-capable
 * hardware factor.
 *
 * Deliberately EXCLUDED:
 *  - `unattested` / `legacy_unattested` — no attestation was ever verified.
 *  - `ios_keychain_rsa_app_attest` — App Attest proves a genuine app instance
 *    vouched for the SPKI; it does NOT prove the RSA private key lives in
 *    hardware. The Apple Secure Enclave holds only P-256 keys, so an RSA
 *    Keychain key is biometric-gated but software-resident.
 *
 * `webauthn_backup_flags` IS included, as a documented weaker exception:
 * browser registration requests `attestationType: 'none'` and derives
 * platform-bound from `singleDevice && !backedUp` (services/approverWebAuthn.ts)
 * — backup-eligibility flags, not a hardware attestation. Tightening that is a
 * separate decision with its own blast radius (#1374 open question Q3). Do not
 * quietly remove it here without closing that question.
 */
export const L4_TRUSTED_PLATFORM_BOUND_BASES: ReadonlySet<PlatformBoundBasis> = new Set<PlatformBoundBasis>([
  'webauthn_backup_flags',
  'ios_se_p256_app_attest',
  'android_tee_key_attestation',
  'android_strongbox_key_attestation',
]);

/**
 * Bases whose platform-binding is derived at registration rather than from a
 * verified attestation, so there is no attestation timestamp to require. Kept
 * as an explicit set (not an inline `=== 'webauthn_backup_flags'`) so adding
 * another derived basis can never silently skip the timestamp requirement for
 * a basis that DOES carry an attestation.
 */
const BASES_WITHOUT_ATTESTATION_TIMESTAMP: ReadonlySet<PlatformBoundBasis> =
  new Set<PlatformBoundBasis>(['webauthn_backup_flags']);

/** Thrown when an L3+ approval's challenge was issued outside the recency window
 * (a stale signature replayed late). The decide paths map this to a 401 — a
 * stale-but-valid signature is rejected, never silently downgraded to L2. */
export class RecencyExpiredError extends Error {
  constructor(public readonly ageMs: number) {
    super(`approval challenge expired (recency): ${ageMs}ms > ${APPROVAL_CHALLENGE_TTL_MS}ms`);
    this.name = 'RecencyExpiredError';
  }
}

/** Thrown when a critical (L4) approval lacks the required fresh account
 * re-authentication. The decide paths map this to a 401/step-up — a critical
 * approve without re-auth is never silently downgraded to L3. */
export class ReauthRequiredError extends Error {
  constructor() {
    super('fresh account re-authentication required for this approval');
    this.name = 'ReauthRequiredError';
  }
}

/** Thrown (Phase 4) when an ENFORCING partner policy requires a higher assurance
 * level than the approve achieved. The decide paths map this to 403. Only ever
 * thrown for an approve — a deny is never blocked (spec §12). */
export class StepUpRequiredError extends Error {
  constructor(
    public readonly requiredLevel: AssuranceLevel,
    public readonly achievedLevel: AssuranceLevel,
  ) {
    super(`step-up required: need level ${requiredLevel}, got ${achievedLevel}`);
    this.name = 'StepUpRequiredError';
  }
}

/**
 * The recorded authentication factor and the level/device-id it implies. These
 * three fields are NOT independent — the real invariants are:
 *   - `session_tap` ⟺ L1 ⟺ no device id (the no-proof base case);
 *   - any verified L2+ factor (`webauthn_platform` / `mobile_hw_key`) always
 *     carries a device id and a level of 2, 3 or 4 (never 1).
 * Modelling them as a discriminated union on `decidedVia` makes the compiler
 * reject the illegal combinations (e.g. `session_tap` at L3, or an L2 factor
 * with a null device id) that a flat record would silently permit — these
 * records are persisted verbatim to the audit columns, so an illegal shape is a
 * corrupt forensic row. See #1373.
 */
export type DecidedFactor =
  | {
      decidedVia: 'session_tap';
      decidedAssuranceLevel: 1;
      authenticatorDeviceId: null;
    }
  | {
      decidedVia: 'webauthn_platform' | 'mobile_hw_key';
      decidedAssuranceLevel: Exclude<AssuranceLevel, 1>;
      authenticatorDeviceId: string;
    };

/** Fields shared by every decision, independent of the recorded factor and
 * (unlike the factor fields) mutated after the base decision is built — the
 * partner-policy floor raises `requiredLevel` and the grace path sets
 * `graceDowngrade`. Kept out of the discriminated union so those post-build
 * writes stay legal regardless of which factor arm was chosen. */
export interface AssuranceDecisionShared {
  /**
   * Level the policy would require for this approval (telemetry / future gate).
   *
   * ONLY MEANINGFUL ON AN APPROVE. On a deny/report this is the Breeze default
   * floor with the partner's raise-only overrides NOT applied, because the
   * partner policy is deliberately not loaded on that path (#2822 review — a DB
   * fault must never stop a technician REFUSING; see the note at the assignment
   * site). No caller reads this field today. If you start recording it on a deny
   * audit row or returning it from a deny response, load the policy for that
   * path first, or you will under-report the partner floor with nothing to catch
   * it.
   */
  requiredLevel: AssuranceLevel;
  /** Phase 4: under-assured but allowed because enforcement is off / in grace. */
  graceDowngrade?: boolean;
}

/**
 * A complete assurance decision: the recorded factor (a discriminated union that
 * makes the level/device-id invariants unrepresentable when illegal) intersected
 * with the shared, post-build-mutable fields.
 */
export type AssuranceDecision = DecidedFactor & AssuranceDecisionShared;

/**
 * Defense-in-depth guard before a decision is persisted to the audit columns.
 * The `DecidedFactor` union now makes the factor↔level↔device-id invariants
 * unrepresentable at every *typed* construction site, so this can only fire on
 * an `as`-cast or untyped build — but it stays as a fail-closed runtime backstop
 * at the audit-write boundary rather than recording a self-contradictory
 * forensic row. (#1373: type makes it statically unrepresentable; this keeps the
 * shipped runtime mitigation as belt-and-suspenders.)
 *
 * Exported only so the retained backstop keeps direct negative coverage — no
 * typed caller can drive it to throw now that the union is in place (#1373).
 */
export function assertDecisionConsistent(d: AssuranceDecision): void {
  const isSession = d.decidedVia === 'session_tap';
  const violations: string[] = [];
  if (isSession !== (d.decidedAssuranceLevel === 1)) violations.push('session_tap must be exactly L1');
  if (isSession !== (d.authenticatorDeviceId === null)) violations.push('session_tap must have no device id');
  if (!isSession && d.authenticatorDeviceId === null) violations.push('an L2+ factor must record a device id');
  if (violations.length > 0) {
    throw new Error(`inconsistent assurance decision: ${violations.join('; ')}`);
  }
}

/**
 * The no-proof result: a session tap recorded at L1 with the Breeze default
 * required level. Used directly when a decision presents no proof, and as the
 * base the full `assertApprovalAssurance` builds on.
 *
 * NOTE: partner-policy floor overrides are applied later in
 * `assertApprovalAssurance`, not here — this resolver intentionally returns the
 * Breeze default floor only (`requiredAssurance` with no overrides).
 */
export function resolveApprovalAssurance(riskTier: RiskTier): AssuranceDecision {
  return {
    requiredLevel: requiredAssurance(riskTier),
    decidedAssuranceLevel: 1,
    decidedVia: 'session_tap',
    authenticatorDeviceId: null,
  };
}

/** Convenience for the PAM path, whose risk_tier is a smallint (1..4). */
export function resolveElevationAssurance(riskTierNum: number | null): AssuranceDecision {
  return resolveApprovalAssurance(elevationRiskTierToName(riskTierNum));
}

/**
 * Phase 2/3: verify a presented approval proof against the caller's registered
 * approver device and return the achieved assurance decision.
 *
 * Two L2 factors, discriminated on `proof.type`:
 *  - `webauthn_platform` (Phase 2): a browser WebAuthn assertion, verified via
 *    @simplewebauthn against the device's stored public key.
 *  - `mobile_hw_key` (Phase 3): a biometric-gated Keychain / Keystore RSA-SHA256
 *    signature (NOT Secure Enclave — the SE holds only P-256 keys; #1374)
 *    over the single-use server nonce, verified against the device's stored SPKI
 *    public key. `proof.credentialId` carries the approver device id.
 *
 * The L3/L4 ladder is derived from the SAME signature plus context — no PIN:
 *  - L3 (high): the verified L2 signature, plus a RECENCY check — the
 *    approval-assertion challenge must have been issued within
 *    `APPROVAL_CHALLENGE_TTL_MS`. The issued-at is read server-side from the
 *    consumed challenge (it travels with the nonce in Redis), NOT supplied by
 *    the route — so a stale-but-valid signature is rejected automatically.
 *  - L4 (critical): L3 conditions, plus a genuinely platform-bound key
 *    (`device.is_platform_bound` AND a `platform_bound_basis` in
 *    `L4_TRUSTED_PLATFORM_BOUND_BASES` — #1374) and a FRESH account re-authentication
 *    (`reauthVerified === true`, satisfied inline at the decide surface — this
 *    is the only route-supplied factor).
 *
 * Non-blocking by design:
 *  - No proof presented → today's behavior (session tap, L1). NEVER blocks here.
 *    Enforcing that a proof is REQUIRED for a given tier is Phase 4.
 *  - Proof present and valid → L2 (factor recorded, anti-clone counter bumped),
 *    escalated to L3/L4 when the tier's recency / re-auth factors are satisfied.
 *  - Proof present but INVALID (device not registered/disabled, nonce expired or
 *    tampered, or signature fails) → throw. A presented-but-bad proof is an
 *    error, not a silent downgrade to L1.
 *  - The L3 recency window blown, or an L4 critical missing its platform-bound
 *    key / re-auth → throw (RecencyExpiredError / ReauthRequiredError). A
 *    higher tier is never silently recorded at a lower achieved level.
 */
export async function assertApprovalAssurance(input: {
  approvalId: string;
  userId: string;
  riskTier: RiskTier;
  proof?: ApprovalProof | null;
  /** Phase 4: the caller's partner, used to load the enforcement policy. */
  partnerId?: string | null;
  /** Phase 4: enforcement applies to an approve only — a deny is never blocked. */
  decision?: 'approved' | 'denied';
  /** L4 re-auth: a fresh account re-authentication completed at the decide
   * surface (password / login-MFA). Required to reach L4 (critical). The L3
   * recency clock is NOT a parameter — it is derived server-side from the
   * consumed challenge's issued-at, so a real caller passes nothing for it. */
  reauthVerified?: boolean;
}): Promise<AssuranceDecision> {
  // 1. Establish the achieved factor. No proof → session tap, L1. A
  //    presented-but-invalid proof throws inside these branches (never a silent
  //    downgrade).
  let decision: AssuranceDecision;
  if (!input.proof) {
    decision = resolveApprovalAssurance(input.riskTier);
  } else {
    const factor =
      input.proof.type === 'mobile_hw_key'
        ? await verifyMobileFactor(input.approvalId, input.userId, input.proof)
        : await verifyWebauthnFactor(input.approvalId, input.userId, input.proof);
    decision = {
      requiredLevel: resolveApprovalAssurance(input.riskTier).requiredLevel,
      decidedAssuranceLevel: escalateAchievedLevel(input.riskTier, factor, {
        reauthVerified: input.reauthVerified ?? false,
      }),
      decidedVia: factor.decidedVia,
      authenticatorDeviceId: factor.authenticatorDeviceId,
    };
  }

  // 2. Apply the partner policy floor (raise-only) to the REQUIRED level, then
  //    enforce — but ONLY for an approve. A deny/report is always allowed
  //    through (spec §12 fail-safe): a technician must never be unable to REFUSE.
  //
  // The policy load is gated on `isApprove` so the fail-safe actually holds
  // (#2822 review). `loadPartnerPolicy` now takes a system-context DB escape,
  // which introduces a real failure mode (pool exhaustion, transaction abort)
  // where previously the org-scoped read just returned zero rows. Both callers
  // — routes/pam.ts and routes/approvals.ts — re-classify ANY throw out of this
  // function as an assertion failure and return 401, so loading the policy
  // unconditionally would make a transient DB fault block a technician from
  // REFUSING a request. That is exactly the state spec §12 says must never
  // occur. A deny therefore never touches the partner policy at all.
  const isApprove = (input.decision ?? 'approved') === 'approved';
  const policy = isApprove ? await loadPartnerPolicy(input.partnerId ?? null) : null;
  decision.requiredLevel = requiredAssurance(input.riskTier, policy?.floorOverrides ?? null);

  if (isApprove && decision.decidedAssuranceLevel < decision.requiredLevel) {
    if (isEnforcing(policy, new Date())) {
      throw new StepUpRequiredError(decision.requiredLevel, decision.decidedAssuranceLevel);
    }
    // Under-assured but enforcement is off / still in the grace window — allow,
    // and flag so the decide path can audit the downgrade.
    decision.graceDowngrade = true;
  }

  assertDecisionConsistent(decision);
  return decision;
}

/** The result of a verified L2 factor — carries the device's platform-bound
 * flag so the L4 escalation can gate on a hardware/platform-bound key, and the
 * epoch-ms the signed challenge was ISSUED so the L3 recency gate has an exact,
 * server-derived age (the consume path reads it from Redis; it is never trusted
 * from the route/client). */
interface VerifiedFactor {
  /** A verified factor is always one of the two L2 factors — never a session
   * tap (the no-proof base case). Narrowing this to the L2-only union lets the
   * proof branch build the L2+ arm of `DecidedFactor` without a cast. */
  decidedVia: 'webauthn_platform' | 'mobile_hw_key';
  authenticatorDeviceId: string;
  isPlatformBound: boolean;
  /** WHY the device counts as platform-bound (#1374). Read from the device row,
   * never from the request. */
  platformBoundBasis: PlatformBoundBasis;
  /** When the attestation behind that basis was verified server-side. Null =
   * never (or a basis that carries no attestation). */
  attestationVerifiedAt: Date | null;
  challengeIssuedAt: number;
}

/**
 * Derive the achieved assurance level from a verified L2 factor plus the
 * tier's re-auth context. The L2 signature is always the base; high adds a
 * recency window (read from the factor's server-derived challenge issued-at),
 * critical adds a platform-bound key + fresh re-auth. Throws (never silently
 * downgrades) when a higher tier's factor is missing.
 */
function escalateAchievedLevel(
  riskTier: RiskTier,
  factor: VerifiedFactor,
  ctx: { reauthVerified: boolean },
): Exclude<AssuranceLevel, 1> {
  // low / medium are satisfied by the L2 factor alone.
  if (riskTier !== 'high' && riskTier !== 'critical') return 2;

  // L3 recency: the signed challenge must have been ISSUED within the window.
  // The issued-at travels with the consumed challenge (Redis), so a verified L2
  // factor inherently proves freshness — but we re-assert the explicit bound so
  // a window TIGHTER than the Redis TTL (or a clock-skew edge) still fails
  // closed rather than silently recording L2.
  const ageMs = Date.now() - factor.challengeIssuedAt;
  if (ageMs > APPROVAL_CHALLENGE_TTL_MS) {
    throw new RecencyExpiredError(ageMs);
  }
  if (riskTier === 'high') return 3;

  // L4 (critical): L3 recency + a genuinely platform-bound key + fresh re-auth.
  //
  // #1374: the boolean alone is not enough. Pre-#1374 mobile registration set
  // is_platform_bound = true unconditionally with no attestation, so a software
  // RSA key read as an L4-capable hardware factor. L4 now additionally requires
  // a basis in L4_TRUSTED_PLATFORM_BOUND_BASES, with a recorded verification
  // time for every basis that has an attestation to time-stamp.
  //
  // Failure keeps producing StepUpRequiredError(4, 3) — the achieved level is
  // genuinely L3, and a critical tier is never silently downgraded.
  if (!factor.isPlatformBound) {
    recordAuthenticatorL4Basis(factor.platformBoundBasis, 'denied');
    throw new StepUpRequiredError(4, 3);
  }
  const basisTrusted =
    L4_TRUSTED_PLATFORM_BOUND_BASES.has(factor.platformBoundBasis) &&
    (BASES_WITHOUT_ATTESTATION_TIMESTAMP.has(factor.platformBoundBasis) ||
      factor.attestationVerifiedAt !== null);
  if (!basisTrusted) {
    // The basis check runs BEFORE the re-auth check on purpose: an untrusted
    // basis must surface as a step-up (the honest achieved level is L3), not as
    // a missing re-auth the technician could satisfy and still get nowhere.
    if (authenticatorAttestationEnforced()) {
      recordAuthenticatorL4Basis(factor.platformBoundBasis, 'denied');
      throw new StepUpRequiredError(4, 3);
    }
    // Break-glass: enforcement is off, so the approval proceeds on the legacy
    // boolean. Counted as `would_deny` so the blast radius of turning
    // enforcement back on is measurable while it is off.
    recordAuthenticatorL4Basis(factor.platformBoundBasis, 'would_deny');
  } else {
    recordAuthenticatorL4Basis(factor.platformBoundBasis, 'allowed');
  }
  if (!ctx.reauthVerified) {
    throw new ReauthRequiredError();
  }
  return 4;
}

/** Verify a WebAuthn platform assertion (Phase 2) and bump the signCount. */
async function verifyWebauthnFactor(
  approvalId: string,
  userId: string,
  proof: Extract<ApprovalProof, { type: 'webauthn_platform' }>,
): Promise<VerifiedFactor> {
  const [device] = await db
    .select()
    .from(authenticatorDevices)
    .where(
      and(
        eq(authenticatorDevices.userId, userId),
        eq(authenticatorDevices.credentialId, proof.credentialId),
        eq(authenticatorDevices.kind, 'webauthn_platform'),
        isNull(authenticatorDevices.disabledAt),
      ),
    )
    .limit(1);
  if (!device) throw new Error('authenticator device not registered or disabled');

  const { verified, newSignCount, challengeIssuedAt } = await verifyApprovalAssertion({
    approvalId,
    userId,
    response: {
      id: proof.credentialId,
      rawId: proof.credentialId,
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        authenticatorData: proof.authenticatorData,
        clientDataJSON: proof.clientDataJSON,
        signature: proof.signature,
        userHandle: proof.userHandle ?? undefined,
      },
    },
    device: {
      credentialId: device.credentialId!,
      publicKey: device.publicKey,
      counter: device.signCount,
      // AuthenticatorTransport and PasskeyTransport are the same 7-member union,
      // so this assigns structurally (the previous `as never` over-suppressed).
      transports: device.transports,
    },
  });
  if (!verified) throw new Error('assertion verification failed');

  await db
    .update(authenticatorDevices)
    .set({ signCount: newSignCount, lastUsedAt: new Date() })
    .where(eq(authenticatorDevices.id, device.id));

  return {
    decidedVia: 'webauthn_platform',
    authenticatorDeviceId: device.id,
    isPlatformBound: device.isPlatformBound === true,
    platformBoundBasis: device.platformBoundBasis,
    attestationVerifiedAt: device.attestationVerifiedAt ?? null,
    challengeIssuedAt,
  };
}

/**
 * Verify a mobile hardware-key assertion (Phase 3): consume the single-use
 * server nonce, confirm it matches the nonce the proof was signed over, and
 * verify the RSA-SHA256 signature against the device's stored SPKI public key.
 * Bumps the anti-clone counter on success. Throws on any failure.
 *
 * `proof.credentialId` carries the approver device id (mobile rows never set
 * `credential_id`, so we match on the primary key).
 */
async function verifyMobileFactor(
  approvalId: string,
  userId: string,
  proof: Extract<ApprovalProof, { type: 'mobile_hw_key' }>,
): Promise<VerifiedFactor> {
  const [device] = await db
    .select()
    .from(authenticatorDevices)
    .where(
      and(
        eq(authenticatorDevices.id, proof.credentialId),
        eq(authenticatorDevices.userId, userId),
        eq(authenticatorDevices.kind, 'mobile_hw_key'),
        isNull(authenticatorDevices.disabledAt),
      ),
    )
    .limit(1);
  if (!device) throw new Error('mobile authenticator device not registered or disabled');

  // Single-use nonce: getdel so a replay finds nothing. Must match the nonce the
  // client signed (defeats a client that signs an arbitrary self-chosen string).
  // The consumed value carries the issued-at — the L3/L4 recency clock.
  const consumed = await consumeMobileAssertionNonce(approvalId, userId);
  if (!consumed || consumed.nonce !== proof.nonce) {
    throw new Error('mobile assertion nonce missing or mismatched');
  }

  // The algorithm comes from the DEVICE ROW, never from the proof (#1374 W02):
  // letting a caller pick how their own key is interpreted is the classic
  // algorithm-confusion vector. An unrecognised stored label fails closed rather
  // than defaulting to RSA — a row we cannot describe is a row we cannot verify.
  const alg = toMobileKeyAlg(device.publicKeyAlg);
  if (!alg) throw new Error('mobile authenticator device has an unsupported public_key_alg');

  const verified = verifyMobileSignature({
    publicKeySpkiB64: device.publicKey,
    payload: consumed.nonce,
    signatureB64: proof.signature,
    alg,
  });
  if (!verified) throw new Error('mobile assertion signature verification failed');

  // The mobile signer carries no counter; advance our own anti-clone counter so
  // a stolen-key replay (with a fresh nonce) is still observable in history.
  await db
    .update(authenticatorDevices)
    .set({ signCount: device.signCount + 1, lastUsedAt: new Date() })
    .where(eq(authenticatorDevices.id, device.id));

  return {
    decidedVia: 'mobile_hw_key',
    authenticatorDeviceId: device.id,
    isPlatformBound: device.isPlatformBound === true,
    platformBoundBasis: device.platformBoundBasis,
    attestationVerifiedAt: device.attestationVerifiedAt ?? null,
    challengeIssuedAt: consumed.issuedAt,
  };
}
