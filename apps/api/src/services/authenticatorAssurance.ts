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

/** Thrown when an approver PIN is presented but cannot be verified. The decide
 * paths map this (like an assertion failure) to a 401 — a presented-but-bad PIN
 * is an error, never a silent downgrade to the L2 factor-only result. */
export class PinVerificationError extends Error {
  constructor(public readonly locked: boolean) {
    super(locked ? 'approver PIN is locked' : 'approver PIN verification failed');
    this.name = 'PinVerificationError';
  }
}

export interface AssuranceDecision {
  /** Level the policy would require for this approval (telemetry / future gate). */
  requiredLevel: AssuranceLevel;
  /** Level actually satisfied by the recorded decision. */
  decidedAssuranceLevel: AssuranceLevel;
  /** Factor actually used. Phase 1 is always a session tap. */
  decidedVia: 'session_tap' | 'mobile_hw_key' | 'webauthn_platform';
  authenticatorDeviceId: string | null;
  pinVerified: boolean;
}

/**
 * Phase 1 (foundation): resolve the would-be required assurance and return the
 * factor-recording fields for the decide path to persist. This NEVER blocks —
 * proof verification (Phase 2/3) and partner-policy enforcement (Phase 4) layer
 * on later. Today every decision is a logged-in session tap, so the recorded
 * level is 1 regardless of the required level.
 *
 * NOTE: partner-policy floor overrides are intentionally NOT consulted yet
 * (the table exists for Phase 4). `requiredAssurance` is called with defaults.
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
}): Promise<AssuranceDecision> {
  // No proof presented → today's behavior (session tap, L1). NEVER blocks here.
  // A PIN cannot stand alone — without a verified factor there is nothing to
  // step up, so we don't even consult it.
  if (!input.proof) return resolveApprovalAssurance(input.riskTier);

  // Verify the L2 factor. Each branch loads its own device shape and bumps the
  // anti-clone counter on success; either throws on any failure.
  const factor =
    input.proof.type === 'mobile_hw_key'
      ? await verifyMobileFactor(input.approvalId, input.userId, input.proof)
      : await verifyWebauthnFactor(input.approvalId, input.userId, input.proof);

  // A valid factor recorded → L2. If a PIN rides along, step up to L3.
  const decision: AssuranceDecision = {
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
      transports: device.transports as never,
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
