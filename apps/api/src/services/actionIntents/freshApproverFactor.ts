/**
 * Tools whose approval must carry FRESH second-factor proof from the approver
 * (topology M4-D3, #6000).
 *
 * A supervised self-decide normally skips the assurance ladder entirely and
 * records a session tap, and the durable release rebuilds the requester's
 * AuthContext with a SYNTHESIZED `mfa: true` (actionIntents/actorContext.ts).
 * Neither is proof that a human with a second factor accepted THIS effect. For
 * the tools listed here the decision itself must be a hardware-backed factor
 * assertion (WebAuthn platform or mobile hardware key, >= L3) made for THIS
 * approval — a reused step-up grant does not count — and the release path
 * re-reads that recorded decision instead of trusting any session claim.
 *
 * Deliberately a light leaf module: both the decide core
 * (approvals/decideApprovalRequest.ts) and the topology release path import it.
 */
export const FRESH_APPROVER_FACTOR_TOOLS: ReadonlySet<string> = new Set(['diagnose_connectivity']);

export const FRESH_APPROVER_FACTOR_MIN_LEVEL = 3;

export function requiresFreshApproverFactor(toolName: string): boolean {
  return FRESH_APPROVER_FACTOR_TOOLS.has(toolName);
}

export type ApproverFactorRecord = {
  decidedVia: string | null | undefined;
  decidedAssuranceLevel: number | null | undefined;
  /** True when the decision redeemed an earlier ceremony's step-up grant. */
  stepUpGrantReuse: boolean | null | undefined;
};

/** A verified hardware-backed assertion made for this decision, at >= L3. */
export function isFreshApproverFactor(record: ApproverFactorRecord): boolean {
  return (record.decidedVia === 'webauthn_platform' || record.decidedVia === 'mobile_hw_key')
    && typeof record.decidedAssuranceLevel === 'number'
    && record.decidedAssuranceLevel >= FRESH_APPROVER_FACTOR_MIN_LEVEL
    && record.stepUpGrantReuse !== true;
}
