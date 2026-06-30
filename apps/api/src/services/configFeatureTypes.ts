/**
 * Canonical configuration-policy feature types — api-side entry point.
 *
 * The list itself now lives in `@breeze/shared` (constants/configFeatureTypes.ts)
 * so the web layer can derive its feature-type unions from the same source and
 * the two can never silently drift (#2004). This module re-exports it from the
 * `@breeze/shared/constants` subpath (pure literal lists — no DB schema, no zod)
 * so it stays a LEAF re-export: `policyBaselineDefaults.ts` (and the
 * `configurationPolicy.ts` re-export chain) need the feature-type list without
 * dragging in the full `configurationPolicy.ts` service, which references DB
 * schema tables at module-eval (e.g. FEATURE_TABLE_MAP). Importing from here
 * instead of from `configurationPolicy.ts` breaks the configurationPolicy ⇄
 * policyBaselineDefaults import cycle and keeps route/helper test suites (which
 * use partial `db/schema` mocks) from crash-loading the service. (#1725)
 *
 * `configurationPolicy.ts` re-exports both names, so existing importers that pull
 * `ConfigFeatureType` / `CONFIG_FEATURE_TYPES` from there keep working.
 *
 * A parity test (`policyBaselineDefaults.test.ts`) asserts this list matches the
 * Drizzle `configFeatureTypeEnum`.
 */
export { CONFIG_FEATURE_TYPES, type ConfigFeatureType } from '@breeze/shared/constants';
