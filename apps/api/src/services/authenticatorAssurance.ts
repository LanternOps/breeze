import { and, eq, isNull } from 'drizzle-orm';
import {
  requiredAssurance,
  elevationRiskTierToName,
  type RiskTier,
  type AssuranceLevel,
  type AssertionProof,
} from '@breeze/shared';
import { db } from '../db';
import { authenticatorDevices } from '../db/schema';
import { verifyApprovalAssertion } from './approverWebAuthn';

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
 * Phase 2: verify a presented browser assertion proof against the caller's
 * registered approver device and return the achieved assurance decision.
 *
 * Non-blocking by design:
 *  - No proof presented → today's behavior (session tap, L1). NEVER blocks here;
 *    enforcing that a proof is REQUIRED for a given tier is Phase 4.
 *  - Proof present and valid → webauthn_platform / L2, with the device id and a
 *    bumped anti-clone signCount.
 *  - Proof present but INVALID (device not registered/disabled, or verification
 *    fails) → throw. A presented-but-bad proof is an error, not a silent
 *    downgrade to L1.
 */
export async function assertApprovalAssurance(input: {
  approvalId: string;
  userId: string;
  riskTier: RiskTier;
  proof?: AssertionProof | null;
}): Promise<AssuranceDecision> {
  // No proof presented → today's behavior (session tap, L1). NEVER blocks in P2.
  if (!input.proof) return resolveApprovalAssurance(input.riskTier);

  const [device] = await db
    .select()
    .from(authenticatorDevices)
    .where(
      and(
        eq(authenticatorDevices.userId, input.userId),
        eq(authenticatorDevices.credentialId, input.proof.credentialId),
        eq(authenticatorDevices.kind, 'webauthn_platform'),
        isNull(authenticatorDevices.disabledAt),
      ),
    )
    .limit(1);
  if (!device) throw new Error('authenticator device not registered or disabled');

  const { verified, newSignCount } = await verifyApprovalAssertion({
    approvalId: input.approvalId,
    userId: input.userId,
    response: {
      id: input.proof.credentialId,
      rawId: input.proof.credentialId,
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        authenticatorData: input.proof.authenticatorData,
        clientDataJSON: input.proof.clientDataJSON,
        signature: input.proof.signature,
        userHandle: input.proof.userHandle ?? undefined,
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

  return {
    requiredLevel: resolveApprovalAssurance(input.riskTier).requiredLevel,
    decidedAssuranceLevel: 2,
    decidedVia: 'webauthn_platform',
    authenticatorDeviceId: device.id,
    pinVerified: false, // PIN is Phase 3
  };
}
