import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  boolean,
  jsonb,
  integer,
  bigint,
  date,
  index,
  uniqueIndex,
  foreignKey,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations, partners } from './orgs';
import { devices } from './devices';
import { users } from './users';
import { maintenanceWindows } from './maintenance';
import { deploymentStatusEnum } from './deployments';

export const softwareCatalog = pgTable('software_catalog', {
  id: uuid('id').primaryKey().defaultRandom(),
  // Dual-axis ownership: exactly one of org_id / partner_id is set
  // (CHECK software_catalog_one_owner_chk). Partner-scoped rows are built-in
  // integration packages, marked by integrationProvider ('huntress'|'sentinelone',
  // CHECK software_catalog_integration_provider_chk).
  orgId: uuid('org_id').references(() => organizations.id),
  partnerId: uuid('partner_id').references(() => partners.id),
  integrationProvider: varchar('integration_provider', { length: 20 }),
  name: varchar('name', { length: 200 }).notNull(),
  vendor: varchar('vendor', { length: 200 }),
  description: text('description'),
  category: varchar('category', { length: 100 }),
  iconUrl: text('icon_url'),
  websiteUrl: text('website_url'),
  isManaged: boolean('is_managed').notNull().default(false),
  createdAt: timestamp('created_at').defaultNow().notNull()
}, (table) => ({
  orgIdx: index('software_catalog_org_id_idx').on(table.orgId),
  partnerIdx: index('software_catalog_partner_id_idx').on(table.partnerId),
  partnerProviderIdx: index('software_catalog_partner_provider_idx').on(table.partnerId, table.integrationProvider),
  nameIdx: index('software_catalog_name_idx').on(table.name),
  vendorIdx: index('software_catalog_vendor_idx').on(table.vendor),
  categoryIdx: index('software_catalog_category_idx').on(table.category)
}));

export const softwareVersions = pgTable('software_versions', {
  id: uuid('id').primaryKey().defaultRandom(),
  catalogId: uuid('catalog_id').notNull().references(() => softwareCatalog.id),
  version: varchar('version', { length: 100 }).notNull(),
  releaseDate: timestamp('release_date'),
  releaseNotes: text('release_notes'),
  downloadUrl: text('download_url'),
  s3Key: text('s3_key'),
  fileType: varchar('file_type', { length: 20 }),
  originalFileName: varchar('original_file_name', { length: 500 }),
  checksum: varchar('checksum', { length: 128 }),
  fileSize: bigint('file_size', { mode: 'number' }),
  supportedOs: jsonb('supported_os'),
  architecture: varchar('architecture', { length: 20 }),
  silentInstallArgs: text('silent_install_args'),
  silentUninstallArgs: text('silent_uninstall_args'),
  preInstallScript: text('pre_install_script'),
  postInstallScript: text('post_install_script'),
  // Detection rules (issue #2022): an array of clauses the agent evaluates
  // against the device's real state to confirm whether the package is actually
  // present — independent of the installer exit code. Shape validated by
  // detectionRulesSchema in @breeze/shared. Null/empty = exit-code behavior only.
  detectionRules: jsonb('detection_rules'),
  isLatest: boolean('is_latest').notNull().default(false)
}, (table) => ({
  catalogIdx: index('software_versions_catalog_id_idx').on(table.catalogId),
  catalogVersionIdx: index('software_versions_catalog_version_idx').on(table.catalogId, table.version),
  latestIdx: index('software_versions_latest_idx').on(table.catalogId, table.isLatest),
  latestUniqueIdx: uniqueIndex('software_versions_one_latest_per_catalog_idx')
    .on(table.catalogId)
    .where(sql`${table.isLatest} = true`)
}));

export const softwareDeployments = pgTable('software_deployments', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  name: varchar('name', { length: 255 }).notNull(),
  // Exactly one of softwareVersionId / installMethodId is set
  // (CHECK software_deployments_one_target_chk, migration
  // 2026-08-16-b-software-deployments-install-method.sql): a deployment either
  // ships an uploaded/URL version or drives a package manager (winget/brew).
  // A cross-platform catalog item produces ONE deployment per platform, each
  // referencing its own install method row — see splitTargetsByPlatform in
  // routes/software.ts.
  softwareVersionId: uuid('software_version_id').references(() => softwareVersions.id),
  installMethodId: uuid('install_method_id').references(() => softwareInstallMethods.id),
  deploymentType: varchar('deployment_type', { length: 20 }).notNull(),
  targetType: varchar('target_type', { length: 50 }).notNull(),
  targetIds: jsonb('target_ids'),
  scheduleType: varchar('schedule_type', { length: 30 }).notNull(),
  scheduledAt: timestamp('scheduled_at'),
  maintenanceWindowId: uuid('maintenance_window_id').references(() => maintenanceWindows.id),
  options: jsonb('options'),
  createdBy: uuid('created_by').references(() => users.id),
  // Dispatch claim marker: set when the per-device dispatch actually runs.
  // The scheduler claims rows via `SET dispatched_at = now() WHERE dispatched_at IS NULL`
  // so scheduled deployments are never double-dispatched across API instances.
  dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
  createdAt: timestamp('created_at').defaultNow().notNull()
}, (table) => ({
  orgIdx: index('software_deployments_org_id_idx').on(table.orgId),
  versionIdx: index('software_deployments_version_id_idx').on(table.softwareVersionId),
  installMethodIdx: index('software_deployments_install_method_idx').on(table.installMethodId),
  scheduleIdx: index('software_deployments_schedule_idx').on(table.scheduleType, table.scheduledAt)
}));

export const deploymentResults = pgTable('deployment_results', {
  id: uuid('id').primaryKey().defaultRandom(),
  deploymentId: uuid('deployment_id').notNull().references(() => softwareDeployments.id),
  deviceId: uuid('device_id').notNull().references(() => devices.id),
  status: deploymentStatusEnum('status').notNull().default('pending'),
  startedAt: timestamp('started_at'),
  completedAt: timestamp('completed_at'),
  exitCode: integer('exit_code'),
  output: text('output'),
  errorMessage: text('error_message'),
  retryCount: integer('retry_count').notNull().default(0),
  // Links to the device_commands row created by the offline-queue fallback.
  // Intentionally no FK: device_commands is the agent hot path and stays unconstrained.
  deviceCommandId: uuid('device_command_id')
}, (table) => ({
  deploymentIdx: index('deployment_results_deployment_id_idx').on(table.deploymentId),
  deviceIdx: index('deployment_results_device_id_idx').on(table.deviceId),
  statusIdx: index('deployment_results_status_idx').on(table.status)
}));

export const softwareInventoryObservations = pgTable('software_inventory_observations', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  deviceId: uuid('device_id').notNull(),
  schemaVersion: integer('schema_version').notNull(),
  collectorVersion: varchar('collector_version', { length: 64 }).notNull(),
  agentVersion: varchar('agent_version', { length: 64 }),
  observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  completeness: varchar('completeness', { length: 16 }).notNull(),
  truncated: boolean('truncated').notNull().default(false),
  claimedItemCount: integer('claimed_item_count').notNull(),
  actualItemCount: integer('actual_item_count').notNull(),
  expectedSources: jsonb('expected_sources').$type<string[]>().notNull(),
  succeededSources: jsonb('succeeded_sources').$type<string[]>().notNull(),
  failedSources: jsonb('failed_sources').$type<Array<{ source: string; code: string }>>().notNull(),
  items: jsonb('items').$type<unknown[]>().notNull(),
  reportDigest: varchar('report_digest', { length: 64 }).notNull(),
  acceptedForInventory: boolean('accepted_for_inventory').notNull(),
  absenceResolutionEligible: boolean('absence_resolution_eligible').notNull(),
  reasonCode: varchar('reason_code', { length: 64 }).notNull(),
  visibleItemCount: integer('visible_item_count').notNull(),
}, (table) => ({
  identityOwnerUq: uniqueIndex('software_inventory_observations_identity_owner_uq').on(table.id, table.orgId, table.deviceId),
  deviceReceivedIdx: index('software_inventory_observations_device_received_idx').on(table.deviceId, table.receivedAt, table.id),
  orgReceivedIdx: index('software_inventory_observations_org_received_idx').on(table.orgId, table.receivedAt),
  deviceOrgFk: foreignKey({
    columns: [table.deviceId, table.orgId],
    foreignColumns: [devices.id, devices.orgId],
    name: 'software_inventory_observations_device_org_fkey',
  }).onUpdate('cascade').onDelete('cascade'),
}));

export const deviceSoftwareInventoryState = pgTable('device_software_inventory_state', {
  deviceId: uuid('device_id').primaryKey(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  latestObservationId: uuid('latest_observation_id').references(() => softwareInventoryObservations.id, { onDelete: 'set null' }),
  latestAcceptedObservationId: uuid('latest_accepted_observation_id').references(() => softwareInventoryObservations.id, { onDelete: 'set null' }),
  visibleObservationId: uuid('visible_observation_id').references(() => softwareInventoryObservations.id, { onDelete: 'set null' }),
  hasAcceptedV2: boolean('has_accepted_v2').notNull().default(false),
  visibleItemCount: integer('visible_item_count').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  orgIdx: index('device_software_inventory_state_org_idx').on(table.orgId),
  latestAcceptedIdx: index('device_software_inventory_state_latest_accepted_idx').on(table.latestAcceptedObservationId),
  deviceOrgFk: foreignKey({
    columns: [table.deviceId, table.orgId],
    foreignColumns: [devices.id, devices.orgId],
    name: 'device_software_inventory_state_device_org_fkey',
  }).onUpdate('cascade').onDelete('cascade'),
}));

export const softwareInventory = pgTable('software_inventory', {
  id: uuid('id').primaryKey().defaultRandom(),
  deviceId: uuid('device_id').notNull().references(() => devices.id),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  catalogId: uuid('catalog_id').references(() => softwareCatalog.id),
  name: varchar('name', { length: 500 }).notNull(),
  version: varchar('version', { length: 100 }),
  vendor: varchar('vendor', { length: 200 }),
  installDate: date('install_date'),
  installLocation: text('install_location'),
  uninstallString: text('uninstall_string'),
  isManaged: boolean('is_managed').notNull().default(false),
  lastSeen: timestamp('last_seen'),
  fileHash: varchar('file_hash', { length: 128 }),
  hashAlgorithm: varchar('hash_algorithm', { length: 10 }),
  observationId: uuid('observation_id').references(() => softwareInventoryObservations.id, { onDelete: 'set null' }),
}, (table) => ({
  deviceIdx: index('software_inventory_device_id_idx').on(table.deviceId),
  catalogIdx: index('software_inventory_catalog_id_idx').on(table.catalogId),
  nameIdx: index('software_inventory_name_idx').on(table.name),
  nameVendorIdx: index('software_inventory_name_vendor_idx').on(table.name, table.vendor),
  nameTrgmIdx: index('software_inventory_name_trgm_idx').using('gin', sql`name gin_trgm_ops`),
  observationIdx: index('software_inventory_observation_id_idx').on(table.observationId).where(sql`observation_id IS NOT NULL`),
}));

// Chunked-upload sessions for software package installers (issue #2951).
// One row per in-flight browser upload; chunks append to temp_path on the API
// host's local disk (single-instance assumption — see routes/softwareUploads.ts).
// Rows are deleted on complete/abort; the softwareUploadSessionCleanup job
// reaps sessions idle for SOFTWARE_UPLOAD_SESSION_IDLE_TTL_HOURS (2h) or older
// than SOFTWARE_UPLOAD_SESSION_MAX_AGE_HOURS (24h) regardless of activity.
// Tenancy shape 1 (direct org_id, forced RLS — see
// migrations/2026-08-11-software-upload-sessions.sql).
export const softwareUploadSessions = pgTable('software_upload_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  // ON DELETE CASCADE so a direct `DELETE FROM software_catalog` outside the
  // org-erasure path cannot strand sessions. It is NOT needed for the org
  // cascade itself: deleteOrgCascade runs topologicalCascadeOrder(), which
  // recomputes an FK-safe order from pg_constraint, so sessions are always
  // deleted before the catalog regardless of alphabetical list position.
  catalogId: uuid('catalog_id').notNull().references(() => softwareCatalog.id, { onDelete: 'cascade' }),
  fileName: varchar('file_name', { length: 500 }).notNull(),
  fileSize: bigint('file_size', { mode: 'number' }).notNull(),
  chunkSize: integer('chunk_size').notNull(),
  bytesReceived: bigint('bytes_received', { mode: 'number' }).notNull().default(0),
  status: varchar('status', { length: 20 }).notNull().default('active'),
  tempPath: text('temp_path').notNull(),
  // Per-process boot id of the API instance that owns the temp file (stamped
  // at create from PROCESS_INSTANCE_ID in routes/softwareUploads.ts). Chunk
  // and complete requests landing on a different process fail fast with a
  // non-retryable 409 'upload_instance_mismatch' instead of an opaque resync
  // loop — the multi-replica-without-sticky-sessions tripwire.
  ownerInstanceId: varchar('owner_instance_id', { length: 64 }).notNull(),
  // Version metadata captured at session create (version, architecture,
  // releaseNotes, downloadUrl, supportedOs, silent args, pre/post scripts,
  // detectionRules) — validated by uploadVersionMetadataSchema before insert.
  versionMetadata: jsonb('version_metadata').notNull().default({}),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  lastActivityAt: timestamp('last_activity_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  orgIdx: index('software_upload_sessions_org_id_idx').on(table.orgId),
  catalogIdx: index('software_upload_sessions_catalog_id_idx').on(table.catalogId),
  lastActivityIdx: index('software_upload_sessions_last_activity_idx').on(table.lastActivityAt),
}));

// Package-manager install methods (one per catalog item × platform × kind).
// Parent-FK join tenancy: no org_id — RLS EXISTS-joins to software_catalog
// (migration 2026-08-16-a-software-install-methods.sql). Version intent
// (latest/exact) lives on the deployment, not here.
export const softwareInstallMethods = pgTable('software_install_methods', {
  id: uuid('id').primaryKey().defaultRandom(),
  catalogId: uuid('catalog_id').notNull().references(() => softwareCatalog.id, { onDelete: 'cascade' }),
  platform: varchar('platform', { length: 10 }).notNull(),   // 'windows' | 'macos'
  kind: varchar('kind', { length: 20 }).notNull(),           // 'winget' | 'homebrew_cask' | 'homebrew_formula'
  packageId: varchar('package_id', { length: 256 }).notNull(),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
}, (table) => ({
  catalogPlatformKindUq: uniqueIndex('software_install_methods_catalog_platform_kind_uq').on(table.catalogId, table.platform, table.kind),
  catalogIdx: index('software_install_methods_catalog_id_idx').on(table.catalogId)
}));

export type SoftwareInstallMethod = typeof softwareInstallMethods.$inferSelect;
export type InstallMethodPlatform = 'windows' | 'macos';
export type InstallMethodKind = 'winget' | 'homebrew_cask' | 'homebrew_formula';
