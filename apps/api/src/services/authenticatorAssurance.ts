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
import { verifyApprovalAssertion } from './approverWebAuthn';
import { verifyMobileSignature, consumeMobileAssertionNonce } from './mobileHwKey';
import { verifyPinAttempt } from './pin';
import { loadPartnerPolicy, isEnforcing } from './authenticatorPolicy';

/** Thrown when an approver PIN is presented but cannot be verified. The decide
 * paths map this (like an assertion failure) to a 401 — a presented-but-bad PIN
 * is an error, never a silent downgrade to the L2 factor-only result. */
export class PinVerificationError extends Error {
  constructor(public readonly locked: boolean) {
    super(locked ? 'approver PIN is locked' : 'approver PIN verification failed');
    this.name = 'PinVerificationError';
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

export interface AssuranceDecision {
  /** Level the policy would require for this approval (telemetry / future gate). */
  requiredLevel: AssuranceLevel;
  /** Level actually satisfied by the recorded decision. */
  decidedAssuranceLevel: AssuranceLevel;
  /** Factor recorded: 'session_tap' when no proof was presented, else the verified L2 factor. */
  decidedVia: 'session_tap' | 'mobile_hw_key' | 'webauthn_platform';
  authenticatorDeviceId: string | null;
  pinVerified: boolean;
  /** Phase 4: under-assured but allowed because enforcement is off / in grace. */
  graceDowngrade?: boolean;
}

/**
 * Guard the cross-field invariants of a decision before it is persisted to the
 * audit columns: the four fields are independent at the type level, so a future
 * edit to a construction site could write a self-contradictory forensic row.
 * Throws (fail-closed) rather than recording an inconsistent assurance record.
 */
function assertDecisionConsistent(d: AssuranceDecision): void {
  const isSession = d.decidedVia === 'session_tap';
  const violations: string[] = [];
  if (isSession !== (d.decidedAssuranceLevel === 1)) violations.push('session_tap must be exactly L1');
  if (isSession !== (d.authenticatorDeviceId === null)) violations.push('session_tap must have no device id');
  if (d.pinVerified && d.decidedAssuranceLevel < 3) violations.push('pinVerified requires L3');
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
    pinVerified: false,
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
 *  - `mobile_hw_key` (Phase 3): a Secure-Enclave / Keystore RSA-SHA256 signature
 *    over the single-use server nonce, verified against the device's stored SPKI
 *    public key. `proof.credentialId` carries the approver device id.
 *
 * An optional approver `pin` (Phase 3) steps a verified L2 factor up to L3.
 *
 * Non-blocking by design:
 *  - No proof presented → today's behavior (session tap, L1). NEVER blocks here;
 *    a presented PIN with no factor cannot stand alone and stays L1. Enforcing
 *    that a proof is REQUIRED for a given tier is Phase 4.
 *  - Proof present and valid → L2 (factor recorded, anti-clone counter bumped);
 *    a valid PIN on top → L3 (`pinVerified=true`).
 *  - Proof present but INVALID (device not registered/disabled, nonce expired or
 *    tampered, or signature fails) → throw. A presented-but-bad proof is an
 *    error, not a silent downgrade to L1.
 *  - PIN presented alongside a valid factor but wrong/locked → throw. A
 *    presented-but-bad PIN never silently records the L2 factor-only result.
 */
export async function assertApprovalAssurance(input: {
  approvalId: string;
  userId: string;
  riskTier: RiskTier;
  proof?: ApprovalProof | null;
  pin?: string | null;
  /** Phase 4: the caller's partner, used to load the enforcement policy. */
  partnerId?: string | null;
  /** Phase 4: enforcement applies to an approve only — a deny is never blocked. */
  decision?: 'approved' | 'denied';
}): Promise<AssuranceDecision> {
  // 1. Establish the achieved factor. No proof → session tap, L1 (a PIN cannot
  //    stand alone — without a verified factor there is nothing to step up).
  //    A presented-but-invalid proof/PIN throws inside these branches (never a
  //    silent downgrade).
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
      decidedAssuranceLevel: 2,
      decidedVia: factor.decidedVia,
      authenticatorDeviceId: factor.authenticatorDeviceId,
      pinVerified: false,
    };
    if (input.pin) {
      const { verified, locked } = await verifyPinAttempt(input.userId, input.pin);
      if (!verified) throw new PinVerificationError(locked);
      decision.decidedAssuranceLevel = 3;
      decision.pinVerified = true;
    }
  }

  // 2. Apply the partner policy floor (raise-only) to the REQUIRED level, then
  //    enforce — but ONLY for an approve. A deny/report is always allowed
  //    through (spec §12 fail-safe): a technician must never be unable to REFUSE.
  const policy = await loadPartnerPolicy(input.partnerId ?? null);
  decision.requiredLevel = requiredAssurance(input.riskTier, policy?.floorOverrides ?? null);

  if ((input.decision ?? 'approved') === 'approved' && decision.decidedAssuranceLevel < decision.requiredLevel) {
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

/** Verify a WebAuthn platform assertion (Phase 2) and bump the signCount. */
async function verifyWebauthnFactor(
  approvalId: string,
  userId: string,
  proof: Extract<ApprovalProof, { type: 'webauthn_platform' }>,
): Promise<{ decidedVia: AssuranceDecision['decidedVia']; authenticatorDeviceId: string }> {
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

  const { verified, newSignCount } = await verifyApprovalAssertion({
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

  return { decidedVia: 'webauthn_platform', authenticatorDeviceId: device.id };
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
): Promise<{ decidedVia: AssuranceDecision['decidedVia']; authenticatorDeviceId: string }> {
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
  const serverNonce = await consumeMobileAssertionNonce(approvalId, userId);
  if (!serverNonce || serverNonce !== proof.nonce) {
    throw new Error('mobile assertion nonce missing or mismatched');
  }

  const verified = verifyMobileSignature({
    publicKeySpkiB64: device.publicKey,
    payload: serverNonce,
    signatureB64: proof.signature,
  });
  if (!verified) throw new Error('mobile assertion signature verification failed');

  // The mobile signer carries no counter; advance our own anti-clone counter so
  // a stolen-key replay (with a fresh nonce) is still observable in history.
  await db
    .update(authenticatorDevices)
    .set({ signCount: device.signCount + 1, lastUsedAt: new Date() })
    .where(eq(authenticatorDevices.id, device.id));

  return { decidedVia: 'mobile_hw_key', authenticatorDeviceId: device.id };
}
