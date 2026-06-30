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
