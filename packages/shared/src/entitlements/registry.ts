/**
 * Partner entitlements registry (spec docs/superpowers/specs/billing/2026-09-07-partner-entitlements-design.md §5).
 *
 * One typed declaration per commercially-gated feature. The API resolver
 * (`apps/api/src/services/entitlements.ts`) folds the live `partner_entitlements`
 * rows over these plan defaults under `manual > license > billing > plan default`;
 * the web reads the resolved set via `GET /partner/me/entitlements`.
 *
 * Browser-safe: no Node builtins (enforced by browserSafeBarrel.test.ts).
 *
 * Adding a key: append to ENTITLEMENT_KEYS, add its definition below (every
 * `plan_type` value needs a default — a missing plan is a compile error), and
 * add its label/why copy to the web `settings.planAndFeatures.features` block.
 * Removing a key is safe at runtime: rows whose `feature_key` is no longer in
 * the registry are ignored by the resolver.
 */
import { z } from 'zod';
import type { PlanType } from '../types';

export type PartnerPlan = PlanType;

export const ENTITLEMENT_KEYS = ['onboarding_supervisor', 'verified_library', 'wisp'] as const;
export type EntitlementKey = (typeof ENTITLEMENT_KEYS)[number];

export type EntitlementState = 'enabled' | 'disabled';
/** `'plan'` is the absence of a live row; the table stores only the row sources. */
export type EntitlementSource = 'plan' | 'billing' | 'license' | 'manual';
export const ENTITLEMENT_ROW_SOURCES = ['billing', 'license', 'manual'] as const;
export type EntitlementRowSource = (typeof ENTITLEMENT_ROW_SOURCES)[number];
/** Higher wins. A `disabled` row wins its rank exactly like an `enabled` one. */
export const ENTITLEMENT_SOURCE_RANK: Record<EntitlementRowSource, number> = { billing: 1, license: 2, manual: 3 };
/** An expired row stays live for this many days after `expires_at`. */
export const ENTITLEMENT_GRACE_DAYS = 14;

export type EntitlementDefinition<K extends EntitlementKey = EntitlementKey, L = unknown> = {
  key: K;
  /** Plan & features row label and the `error` of the 403 `entitlement_required` body. */
  label: string;
  /** One sentence: the upsell line shown beside a locked surface. */
  why: string;
  /** EVERY plan value — adding a plan to `plan_type` is a compile error here until a default is chosen. */
  defaults: Record<PartnerPlan, EntitlementState>;
  /** Absent ⇒ stored `limits` must be null. */
  limits?: z.ZodType<L>;
  /** Per-plan limits applied when the winning row carries none (or the plan default wins). */
  defaultLimits?: Partial<Record<PartnerPlan, L>>;
};

export const wispLimitsSchema = z
  .object({
    maxGrants: z.number().int().min(0),
    budgetCentsPerDayCeiling: z.number().int().min(0),
    minFloorTickMinutes: z.number().int().min(1)
  })
  .strict();
export type WispLimits = z.infer<typeof wispLimitsSchema>;

export const onboardingSupervisorLimitsSchema = z
  .object({
    maxWakesPerRun: z.number().int().min(0),
    maxRepairsPerStep: z.number().int().min(0),
    perRunCostCents: z.number().int().min(0)
  })
  .strict();
export type OnboardingSupervisorLimits = z.infer<typeof onboardingSupervisorLimitsSchema>;

export const verifiedLibraryLimitsSchema = z
  .object({ maxVerifiedPackages: z.number().int().min(0).nullable() })
  .strict();
export type VerifiedLibraryLimits = z.infer<typeof verifiedLibraryLimitsSchema>;

/** The limits type each key carries. */
export type EntitlementLimitsByKey = {
  onboarding_supervisor: OnboardingSupervisorLimits;
  verified_library: VerifiedLibraryLimits;
  wisp: WispLimits;
};

const PRO_AND_ABOVE: Record<PartnerPlan, EntitlementState> = {
  free: 'disabled',
  starter: 'disabled',
  community: 'disabled',
  pro: 'enabled',
  enterprise: 'enabled',
  unlimited: 'enabled'
};

// Placeholder values: the onboarding supervisor spec (§9) fixes only
// maxRepairsPerStep = 2 and defers the rest ("start conservative").
const ONBOARDING_SUPERVISOR_DEFAULT_LIMITS: OnboardingSupervisorLimits = {
  maxWakesPerRun: 6,
  maxRepairsPerStep: 2,
  perRunCostCents: 200
};

export const ENTITLEMENTS: { [K in EntitlementKey]: EntitlementDefinition<K, EntitlementLimitsByKey[K]> } = {
  onboarding_supervisor: {
    key: 'onboarding_supervisor',
    label: 'Onboarding supervisor',
    why: 'An AI supervisor that diagnoses and repairs zero-touch onboarding failures.',
    defaults: { ...PRO_AND_ABOVE },
    limits: onboardingSupervisorLimitsSchema,
    defaultLimits: {
      pro: { ...ONBOARDING_SUPERVISOR_DEFAULT_LIMITS },
      enterprise: { ...ONBOARDING_SUPERVISOR_DEFAULT_LIMITS },
      unlimited: { ...ONBOARDING_SUPERVISOR_DEFAULT_LIMITS }
    }
  },
  verified_library: {
    key: 'verified_library',
    label: 'Verified software library',
    why: 'Curated, verified packages you can deploy with confidence.',
    defaults: { ...PRO_AND_ABOVE },
    limits: verifiedLibraryLimitsSchema,
    defaultLimits: {
      pro: { maxVerifiedPackages: null },
      enterprise: { maxVerifiedPackages: null },
      unlimited: { maxVerifiedPackages: null }
    }
  },
  wisp: {
    key: 'wisp',
    label: 'Wisp',
    why: 'Wisp triages your fleet continuously and nudges the right person; available on Pro and above.',
    defaults: { ...PRO_AND_ABOVE },
    limits: wispLimitsSchema,
    defaultLimits: {
      pro: { maxGrants: 25, budgetCentsPerDayCeiling: 1000, minFloorTickMinutes: 15 },
      enterprise: { maxGrants: 100, budgetCentsPerDayCeiling: 2500, minFloorTickMinutes: 15 },
      unlimited: { maxGrants: 500, budgetCentsPerDayCeiling: 5000, minFloorTickMinutes: 15 }
    }
  }
};

export function isEntitlementKey(v: string): v is EntitlementKey {
  return (ENTITLEMENT_KEYS as readonly string[]).includes(v);
}
