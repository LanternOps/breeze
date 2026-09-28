import { eq } from 'drizzle-orm';
import { db } from '../db';
import { readWithPartnerAxisVisibility } from '../db/partnerAxisRead';
import { authenticatorPolicies } from '../db/schema';
import { DEFAULT_ASSURANCE_FLOOR, type AssuranceFloorOverrides, type RiskTier } from '@breeze/shared';
import { approverAssuranceDefaultEnforceFrom } from '../config/env';

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
 * A partner with no row is NOT exempt: `isEnforcing(null, …)` resolves the
 * platform default (see `resolveEffectivePolicy`), which enforces high and
 * critical approvals from the platform date.
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

/** The stored fields the resolver reads. `requireEnrollment: null` = the
 * partner left the enforcement choice blank and inherits the platform default. */
export interface StoredAuthenticatorPolicy {
  requireEnrollment: boolean | null;
  enforceFrom: Date | null;
  floorOverrides?: AssuranceFloorOverrides | null;
}

export type AuthenticatorPolicySource = 'explicit' | 'platform_default';
export type AuthenticatorPolicyMode = 'off' | 'grace' | 'enforcing';

const ALL_RISK_TIERS: readonly RiskTier[] = Object.freeze(['low', 'medium', 'high', 'critical']);

/**
 * Tiers the platform default enforces: the ones whose Breeze floor needs a
 * registered approver device plus recency (L3+). Medium stays on the
 * lightweight lane unless a partner explicitly chooses Required.
 */
export const PLATFORM_DEFAULT_ENFORCED_TIERS: readonly RiskTier[] = Object.freeze(
  ALL_RISK_TIERS.filter((tier) => DEFAULT_ASSURANCE_FLOOR[tier] >= 3),
);

/** The policy that actually applies to a partner once the platform default is folded in. */
export interface EffectiveAuthenticatorPolicy {
  source: AuthenticatorPolicySource;
  requireEnrollment: boolean;
  enforceFrom: Date | null;
  floorOverrides: AssuranceFloorOverrides;
  /** Risk tiers an enforcing policy blocks under-assured approvals on. */
  enforcedTiers: readonly RiskTier[];
}

/**
 * Fold the platform default into a partner's stored policy.
 *
 * - An explicit choice (`requireEnrollment` true or false) is used as saved,
 *   across every tier — including an explicit "not required", which stays
 *   non-enforcing after the platform date.
 * - No row, or a blank choice, inherits the platform default: required for
 *   high/critical from `defaultEnforceFrom` (any stored `enforceFrom` is
 *   ignored while inheriting). Floor overrides on the row still apply.
 */
export function resolveEffectivePolicy(
  stored: StoredAuthenticatorPolicy | null,
  defaultEnforceFrom: Date,
): EffectiveAuthenticatorPolicy {
  const floorOverrides = stored?.floorOverrides ?? {};
  if (!stored || stored.requireEnrollment === null) {
    return {
      source: 'platform_default',
      requireEnrollment: true,
      enforceFrom: defaultEnforceFrom,
      floorOverrides,
      enforcedTiers: PLATFORM_DEFAULT_ENFORCED_TIERS,
    };
  }
  return {
    source: 'explicit',
    requireEnrollment: stored.requireEnrollment,
    enforceFrom: stored.enforceFrom,
    floorOverrides,
    enforcedTiers: ALL_RISK_TIERS,
  };
}

/** off = never blocks; grace = will enforce from `enforceFrom`; enforcing = blocks now. */
export function effectivePolicyMode(policy: EffectiveAuthenticatorPolicy, now: Date): AuthenticatorPolicyMode {
  if (!policy.requireEnrollment) return 'off';
  if (policy.enforceFrom && policy.enforceFrom > now) return 'grace';
  return 'enforcing';
}

/**
 * Whether an under-assured APPROVE at `riskTier` must be refused right now.
 * Non-enforcing (allowed, recorded as a grace downgrade) when the partner
 * explicitly chose "not required", while a grace window is still running, or
 * — for a partner inheriting the platform default — for low/medium tiers.
 */
export function isEnforcing(
  stored: StoredAuthenticatorPolicy | null,
  now: Date,
  riskTier: RiskTier,
  defaultEnforceFrom: Date = approverAssuranceDefaultEnforceFrom(),
): boolean {
  const effective = resolveEffectivePolicy(stored, defaultEnforceFrom);
  return effectivePolicyMode(effective, now) === 'enforcing' && effective.enforcedTiers.includes(riskTier);
}

/** Wire shape of the effective policy, for the settings tab and the approvals notice. */
export interface EffectivePolicyDescription {
  source: AuthenticatorPolicySource;
  mode: AuthenticatorPolicyMode;
  requireEnrollment: boolean;
  enforceFrom: string | null;
  enforcedTiers: RiskTier[];
  /** Only for a partner inheriting the platform default: before the date
   * 'upcoming', from the date 'active'. Null for an explicit choice. */
  defaultNotice: 'upcoming' | 'active' | null;
}

export function describeEffectivePolicy(
  stored: StoredAuthenticatorPolicy | null,
  now: Date,
  defaultEnforceFrom: Date = approverAssuranceDefaultEnforceFrom(),
): EffectivePolicyDescription {
  const effective = resolveEffectivePolicy(stored, defaultEnforceFrom);
  const mode = effectivePolicyMode(effective, now);
  return {
    source: effective.source,
    mode,
    requireEnrollment: effective.requireEnrollment,
    enforceFrom: effective.enforceFrom ? effective.enforceFrom.toISOString() : null,
    enforcedTiers: [...effective.enforcedTiers],
    defaultNotice:
      effective.source === 'platform_default' ? (mode === 'enforcing' ? 'active' : 'upcoming') : null,
  };
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
