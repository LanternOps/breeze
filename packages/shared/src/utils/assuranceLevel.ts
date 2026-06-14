/** Canonical risk tier (matches the approval_requests.risk_tier enum). */
export type RiskTier = 'low' | 'medium' | 'high' | 'critical';

/** Verification strength demanded of a decision. */
export type AssuranceLevel = 1 | 2 | 3 | 4;

/** Breeze default floor: risk tier → minimum assurance level. */
export const DEFAULT_ASSURANCE_FLOOR: Record<RiskTier, AssuranceLevel> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

/**
 * Partner policy may only RAISE a rung above the Breeze floor, never lower it.
 * Keys are risk tiers; values are the minimum level the partner demands.
 */
export type AssuranceFloorOverrides = Partial<Record<RiskTier, AssuranceLevel>>;

/**
 * Resolve the required assurance level for an approval. A partner override is
 * honored only when it is STRICTLY HIGHER than the Breeze floor — an override
 * that would weaken the floor is ignored (fail-closed).
 */
export function requiredAssurance(
  riskTier: RiskTier,
  overrides?: AssuranceFloorOverrides | null,
): AssuranceLevel {
  const base = DEFAULT_ASSURANCE_FLOOR[riskTier];
  const override = overrides?.[riskTier];
  return override && override > base ? override : base;
}

/**
 * `elevation_requests.risk_tier` is a smallint (1..4) set by pamBridge, while
 * `approval_requests.risk_tier` is the enum low|medium|high|critical. Map the
 * numeric form to the canonical name. Null / 0 / out-of-range default to
 * 'medium' — a safe non-trivial floor, never silently 'low'.
 */
export function elevationRiskTierToName(n: number | null | undefined): RiskTier {
  switch (n) {
    case 1:
      return 'low';
    case 3:
      return 'high';
    case 4:
      return 'critical';
    case 2:
      return 'medium';
    default:
      return 'medium';
  }
}
