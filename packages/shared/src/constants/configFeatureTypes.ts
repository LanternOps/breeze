/**
 * Canonical list of configuration-policy feature types — the SINGLE SOURCE OF
 * TRUTH shared across api, agent helpers, and web.
 *
 * It lives here (a pure leaf module in `@breeze/shared`, no DB / heavy imports)
 * so every layer can derive from the same list and they cannot silently drift:
 *
 *  - The API re-exports it from `apps/api/src/services/configFeatureTypes.ts`,
 *    and a parity test (`apps/api/src/services/policyBaselineDefaults.test.ts`)
 *    pins this list to the Drizzle `configFeatureTypeEnum` — keeping it in
 *    lockstep with the DB enum.
 *  - The web layer derives its per-surface unions from `ConfigFeatureType` via
 *    `Exclude<…>` (config-policy editor tabs, device Effective Config tab), so a
 *    new canonical feature type fails to compile until each surface accounts for
 *    it, and runtime parity tests assert the documented exclusions stay honest.
 *    See issue #2004.
 *
 * When adding a feature type: add it here AND to the Drizzle enum in the same
 * change (the api parity test enforces this), then resolve the resulting web
 * compile errors / parity-test failures.
 */
export const CONFIG_FEATURE_TYPES = [
  'patch', 'alert_rule', 'backup', 'security', 'monitoring', 'maintenance',
  'compliance', 'automation', 'event_log', 'software_policy', 'sensitive_data',
  'peripheral_control', 'warranty', 'helper', 'remote_access', 'pam', 'onedrive_helper',
  'vulnerability',
] as const;

export type ConfigFeatureType = typeof CONFIG_FEATURE_TYPES[number];

/**
 * Feature types whose per-feature config is fundamentally org-scoped and
 * cannot be authored on a partner-wide ("all organizations") config policy
 * (org_id NULL, #1724): onedrive_helper settings carry per-tenant M365
 * library mappings, so a partner-wide policy has no owning org to anchor
 * them to. backup left this set with the backup-profiles model (spec
 * 2026-07-13): its settings row is now dual-axis and partner-wide links
 * resolve each device org's default destination at job time.
 *
 * Every other feature type has migrated to partner-wide support as part of
 * epic #2135 (dual-ownership templates, partner-axis update rings, or
 * partner-agnostic inline settings) — this set should stay small and shrink
 * further only when a feature's underlying storage moves off a required
 * org_id (see the partner-wide-first rule in CLAUDE.md).
 *
 * SINGLE SOURCE OF TRUTH for this restriction — consumed by:
 *  - `apps/api/src/routes/configurationPolicies/featureLinks.ts`
 *    (`ORG_SCOPED_ONLY_FEATURES`, write-time 400 rejection)
 *  - `apps/web/src/components/configurationPolicies/ConfigPolicyDetailPage.tsx`
 *    (gates the feature tab so the UI can't offer an edit that will 400 — #2101)
 * Keeping one list means the API rule and the UI gating can't silently drift.
 */
export const ORG_SCOPED_ONLY_FEATURE_TYPES: ReadonlySet<ConfigFeatureType> = new Set([
  'onedrive_helper',
]);
