import { eq } from 'drizzle-orm';
import { db } from '../db';
import { authenticatorPolicies } from '../db/schema';
import { DEFAULT_ASSURANCE_FLOOR, type AssuranceFloorOverrides, type RiskTier } from '@breeze/shared';

export type PartnerAuthenticatorPolicy = typeof authenticatorPolicies.$inferSelect;

/** Load a partner's approval-security policy, or null when none / no partner. */
export async function loadPartnerPolicy(partnerId: string | null): Promise<PartnerAuthenticatorPolicy | null> {
  if (!partnerId) return null;
  const [row] = await db
    .select()
    .from(authenticatorPolicies)
    .where(eq(authenticatorPolicies.partnerId, partnerId))
    .limit(1);
  return row ?? null;
}

/**
 * Whether the policy actively ENFORCES step-up right now. Fail-open: no policy,
 * enrollment not required, or still inside the grace window (`enforceFrom` in
 * the future) all mean "do not block".
 */
export function isEnforcing(
  policy: { requireEnrollment: boolean; enforceFrom: Date | null } | null,
  now: Date,
): boolean {
  if (!policy || !policy.requireEnrollment) return false;
  if (policy.enforceFrom && policy.enforceFrom > now) return false; // grace window
  return true;
}

/**
 * Reject any override that would WEAKEN the Breeze default floor — partner
 * policy is raise-only. Throws on the first offending tier.
 */
export function validateRaiseOnly(overrides: AssuranceFloorOverrides): void {
  for (const [tier, level] of Object.entries(overrides) as [RiskTier, number][]) {
    const floor = DEFAULT_ASSURANCE_FLOOR[tier];
    if (level < floor) {
      throw new Error(`override for '${tier}' (${level}) is below the Breeze floor (${floor})`);
    }
  }
}
