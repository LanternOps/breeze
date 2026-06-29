/**
 * Canonical list of configuration-policy feature types.
 *
 * This lives in its own LEAF module (no heavy imports) on purpose. Light
 * consumers — `policyBaselineDefaults.ts`, and transitively `pamSettings.ts`
 * and the agent `helpers.ts` — need the feature-type list without dragging in
 * the full `configurationPolicy.ts` service, which references DB schema tables
 * at module-eval (e.g. FEATURE_TABLE_MAP). Importing the list from here instead
 * of from `configurationPolicy.ts` breaks the configurationPolicy ⇄
 * policyBaselineDefaults import cycle and keeps route/helper test suites (which
 * use partial `db/schema` mocks) from crash-loading the service. (#1725)
 *
 * `configurationPolicy.ts` re-exports both names, so existing importers that
 * pull `ConfigFeatureType` / `CONFIG_FEATURE_TYPES` from there keep working.
 *
 * A parity test asserts this list matches the Drizzle `configFeatureTypeEnum`.
 */
export const CONFIG_FEATURE_TYPES = [
  'patch', 'alert_rule', 'backup', 'security', 'monitoring', 'maintenance',
  'compliance', 'automation', 'event_log', 'software_policy', 'sensitive_data',
  'peripheral_control', 'warranty', 'helper', 'remote_access', 'pam', 'onedrive_helper',
  'vulnerability',
] as const;

export type ConfigFeatureType = typeof CONFIG_FEATURE_TYPES[number];
