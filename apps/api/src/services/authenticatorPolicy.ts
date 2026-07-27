import { eq } from 'drizzle-orm';
import { db } from '../db';
import { readWithPartnerAxisVisibility } from '../db/partnerAxisRead';
import { authenticatorPolicies } from '../db/schema';
import { DEFAULT_ASSURANCE_FLOOR, type AssuranceFloorOverrides, type RiskTier } from '@breeze/shared';

export type PartnerAuthenticatorPolicy = typeof authenticatorPolicies.$inferSelect;

/**
 * Load a partner's approval-security policy, or null when none / no partner.
 *
 * Read under a SYSTEM context (#2822). `authenticator_policies` is partner-axis
 * (`breeze_has_partner_access(partner_id)`), and both approval surfaces that
 * consume this admit ORGANIZATION scope — `routes/pam.ts` is
 * requireScope('organization','partner','system') and `routes/approvals.ts` has
 * no requireScope at all. An org-scoped JWT carries a partnerId, so the lookup
 * *looks* right, but accessiblePartnerIds is [] and the row came back empty.
 * `isEnforcing(null, now)` is false and `resolveAssuranceFloor` falls back to
 * DEFAULT_ASSURANCE_FLOOR, so an org-scoped technician could approve a critical
 * JIT-admin elevation with a bare L1 session tap while a partner-scoped
 * technician on the identical row got 403 step_up_required — a silent step-up
 * MFA fail-open, recorded in the audit row as an ordinary `graceDowngrade`.
 * `partnerId` is server-derived from the caller's auth context, never client
 * input, so this pinned lookup does not widen which partner is legible.
 *
 * NOTE: `isEnforcing(null, …) === false` remains a deliberate fail-OPEN for a
 * partner that genuinely has no policy row. This fix makes the read honest; it
 * does not change that default. Whether an unreadable policy should instead
 * fail CLOSED is a separate decision (tracked on #2822).
 */
export async function loadPartnerPolicy(partnerId: string | null): Promise<PartnerAuthenticatorPolicy | null> {
  if (!partnerId) return null;
  const [row] = await readWithPartnerAxisVisibility(() =>
    db
      .select()
      .from(authenticatorPolicies)
      .where(eq(authenticatorPolicies.partnerId, partnerId))
      .limit(1)
  );
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
