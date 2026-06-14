import {
  requiredAssurance,
  elevationRiskTierToName,
  type RiskTier,
  type AssuranceLevel,
} from '@breeze/shared';

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
