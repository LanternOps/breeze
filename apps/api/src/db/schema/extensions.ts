import { pgTable, text, boolean, timestamp, primaryKey } from 'drizzle-orm/pg-core';

/**
 * Lifecycle states for an installed runtime extension. Kept in lockstep with the
 * `CHECK (lifecycle_state IN (...))` constraint in
 * `migrations/2026-08-01-e-runtime-extensions.sql` — the DB enforces the set,
 * this union types it. The reconciler/migrator (later tasks) drive the
 * transitions; `ExtensionStateStore` persists them.
 *
 *  - discovered   — present in the deployment config, nothing verified yet
 *  - verified     — signed bundle verified against a trusted publisher
 *  - migrated     — the bundle's schema migrations have been applied
 *  - active       — mounted and serving
 *  - disabled     — turned off at runtime (the `enabled` flag is false)
 *  - failed       — a lifecycle step failed (see last_error_*)
 *  - incompatible — host cannot satisfy the manifest's requirements
 */
export const EXTENSION_LIFECYCLE_STATES = [
  'discovered',
  'verified',
  'migrated',
  'active',
  'disabled',
  'failed',
  'incompatible',
] as const;

export type ExtensionLifecycleState = (typeof EXTENSION_LIFECYCLE_STATES)[number];

/**
 * Core-owned GLOBAL operational table (no tenant/org axis). One row per known
 * extension, keyed by name. Force-RLS with a single system-only policy — every
 * access goes through system DB scope (see stateStore.ts). Observed
 * version/trust facts come from the deployment config + verified bundle; the
 * `enabled` flag is the only field mutated at runtime.
 */
export const installedExtensions = pgTable('installed_extensions', {
  name: text('name').primaryKey(),
  configuredVersion: text('configured_version'),
  activeVersion: text('active_version'),
  artifactDigest: text('artifact_digest'),
  publisherId: text('publisher_id'),
  manifestApiVersion: text('manifest_api_version'),
  serverSdkVersion: text('server_sdk_version'),
  webSdkVersion: text('web_sdk_version'),
  enabled: boolean('enabled').notNull().default(true),
  lifecycleState: text('lifecycle_state').$type<ExtensionLifecycleState>().notNull(),
  lastErrorCategory: text('last_error_category'),
  lastErrorMessage: text('last_error_message'),
  migratedAt: timestamp('migrated_at', { withTimezone: true }),
  activatedAt: timestamp('activated_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Core-owned GLOBAL operational table (no tenant/org axis). Append-only record of
 * the schema-compatibility floor each bundle version applied, keyed
 * (extension_name, bundle_version). Force-RLS with a single system-only policy.
 * Lets the migrator compute the highest floor ever applied for an extension so a
 * downgrade below it can be refused.
 */
export const extensionSchemaHistory = pgTable(
  'extension_schema_history',
  {
    extensionName: text('extension_name').notNull(),
    bundleVersion: text('bundle_version').notNull(),
    schemaCompatibilityFloor: text('schema_compatibility_floor').notNull(),
    appliedAt: timestamp('applied_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.extensionName, t.bundleVersion] }),
  }),
);
