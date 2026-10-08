import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  boolean,
  integer,
  jsonb,
  index,
  uniqueIndex,
  foreignKey,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type {
  EdrActionKey,
  EdrActionRequestedVia,
  EdrActionStatus,
  EdrConnectionStatus,
  EdrDetectionStatus,
  EdrDeviceMatchSource,
  EdrEndpointHealth,
  EdrEndpointType,
  EdrIsolationState,
  EdrMappingSource,
  EdrOsPlatform,
  EdrSeverity,
  EdrSyncStatus,
  EdrVendorKind,
} from '@breeze/shared';
import { organizations, partners } from './orgs';
import { users } from './users';

/*
 * EDR provider framework (#8164 W01, spec
 * docs/superpowers/specs/integrations/2026-09-30-edr-provider-framework-spec.md).
 *
 * The migration `2026-12-16-100000-edr-provider-framework.sql` is
 * AUTHORITATIVE for everything Drizzle cannot express:
 *   - CHECK constraints for the normalized value sets (`@breeze/shared` tuples
 *     in `types/edr.ts`; `edrProviderRls.integration.test.ts` compares them);
 *   - DEFERRABLE INITIALLY IMMEDIATE on every composite FK whose referenced
 *     columns include `org_id` (org-merge contract);
 *   - the PG15 column-list `ON DELETE SET NULL (col)` FKs — the device links,
 *     and on detections/actions the tenant/endpoint/detection links. Declaring
 *     those here without the column list would make drizzle-kit propose a bare
 *     SET NULL that nulls `org_id` (NOT NULL → 23502 mid org erasure, #4100),
 *     so they are deliberately NOT declared in this file (backupProviders.ts
 *     precedent).
 */

/**
 * One MSP-level connection to a vendor EDR console (RLS shape 3 — partner
 * axis, no org axis at all). Credentials are sealed with an AAD bound to THIS
 * row's id (`encryptedColumnRegistry`, `aadBinding: 'row'`). No route ever
 * returns a `*Encrypted` column.
 */
export const edrConnections = pgTable('edr_connections', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  /** Adapter key, validated by the EDR registry — an open string so a new vendor needs no migration. */
  provider: varchar('provider', { length: 30 }).notNull(),
  name: varchar('name', { length: 200 }).notNull(),
  /** NULL = adapter default. Validated against the adapter host allowlist on write and at dial time. */
  baseUrl: varchar('base_url', { length: 300 }),
  region: varchar('region', { length: 40 }),
  credentialsEncrypted: text('credentials_encrypted').notNull(),
  /** Breeze-generated push/webhook shared secret (W03). */
  webhookSecretEncrypted: text('webhook_secret_encrypted'),
  vendorRootId: varchar('vendor_root_id', { length: 128 }),
  vendorRootName: varchar('vendor_root_name', { length: 255 }),
  /** Which kind of key this is (partner / company / organization / tenant) — set at testConnection. */
  vendorRootType: varchar('vendor_root_type', { length: 40 }),
  isActive: boolean('is_active').notNull().default(true),
  status: varchar('status', { length: 20 }).notNull().default('connected').$type<EdrConnectionStatus>(),
  /** Operator overrides; NULL = adapter default. */
  detectionIntervalMinutes: integer('detection_interval_minutes'),
  inventoryIntervalMinutes: integer('inventory_interval_minutes'),
  /** What the scheduler actually runs at after the vendor request budget. Scheduler-written. */
  effectiveDetectionIntervalMinutes: integer('effective_detection_interval_minutes'),
  effectiveInventoryIntervalMinutes: integer('effective_inventory_interval_minutes'),
  lastInventorySyncAt: timestamp('last_inventory_sync_at', { withTimezone: true }),
  lastInventorySyncStatus: varchar('last_inventory_sync_status', { length: 20 }).$type<EdrSyncStatus>(),
  lastInventorySyncError: text('last_inventory_sync_error'),
  lastDetectionSyncAt: timestamp('last_detection_sync_at', { withTimezone: true }),
  lastDetectionSyncStatus: varchar('last_detection_sync_status', { length: 20 }).$type<EdrSyncStatus>(),
  lastDetectionSyncError: text('last_detection_sync_error'),
  lastSyncTenants: integer('last_sync_tenants'),
  lastSyncUnmappedTenants: integer('last_sync_unmapped_tenants'),
  lastSyncFailedTenants: integer('last_sync_failed_tenants'),
  lastSyncEndpoints: integer('last_sync_endpoints'),
  lastSyncLinkedEndpoints: integer('last_sync_linked_endpoints'),
  lastSyncAmbiguousEndpoints: integer('last_sync_ambiguous_endpoints'),
  lastSyncOpenDetections: integer('last_sync_open_detections'),
  /** The adapter's capability keys at the last successful test. */
  capabilitiesSnapshot: text('capabilities_snapshot').array().notNull().default(sql`'{}'::text[]`),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  idPartnerUniq: uniqueIndex('edr_connections_id_partner_uniq').on(table.id, table.partnerId),
  partnerProviderNameUniq: uniqueIndex('edr_connections_partner_provider_name_uniq')
    .on(table.partnerId, table.provider, table.name),
  partnerIdx: index('edr_connections_partner_idx').on(table.partnerId),
}));

/**
 * A vendor tenant (GravityZone company, Sophos tenant, Emsisoft workspace)
 * discovered under a connection, and the Breeze organization it maps to (RLS
 * shape 3 — partner axis). `orgId` is the mapping TARGET and may be NULL, which
 * is why this table is in `ORG_AXIS_POLICY_EXCLUDED_TABLES` even though it
 * carries an `org_id` column (backup_provider_customers precedent).
 */
export const edrTenants = pgTable('edr_tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  connectionId: uuid('connection_id').notNull(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  vendorTenantId: varchar('vendor_tenant_id', { length: 128 }).notNull(),
  vendorTenantName: varchar('vendor_tenant_name', { length: 255 }).notNull(),
  vendorParentId: varchar('vendor_parent_id', { length: 128 }),
  vendorTenantType: varchar('vendor_tenant_type', { length: 40 }),
  vendorExternalCode: varchar('vendor_external_code', { length: 255 }),
  /** Per-tenant data-region host (Sophos); allowlist-validated on write and at dial time. */
  apiHost: varchar('api_host', { length: 300 }),
  orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'set null' }),
  /** NULL = never mapped. `manual` / `manual_unmapped` are never touched by auto-mapping. */
  mappingSource: varchar('mapping_source', { length: 20 }).$type<EdrMappingSource>(),
  /** Per-tenant installer token / link (W06). */
  installerSecretEncrypted: text('installer_secret_encrypted'),
  endpointCount: integer('endpoint_count').notNull().default(0),
  openDetectionCount: integer('open_detection_count').notNull().default(0),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  /** D13: absent from the vendor's tenant list since; tombstoned, never hard-deleted. */
  vendorMissingSince: timestamp('vendor_missing_since', { withTimezone: true }),
  lastInventorySyncAt: timestamp('last_inventory_sync_at', { withTimezone: true }),
  lastInventorySyncStatus: varchar('last_inventory_sync_status', { length: 20 }).$type<EdrSyncStatus>(),
  lastInventorySyncError: text('last_inventory_sync_error'),
  lastDetectionSyncAt: timestamp('last_detection_sync_at', { withTimezone: true }),
  lastDetectionSyncStatus: varchar('last_detection_sync_status', { length: 20 }).$type<EdrSyncStatus>(),
  lastDetectionSyncError: text('last_detection_sync_error'),
  detectionCursor: text('detection_cursor'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  connectionVendorUniq: uniqueIndex('edr_tenants_connection_vendor_uniq')
    .on(table.connectionId, table.vendorTenantId),
  idConnectionUniq: uniqueIndex('edr_tenants_id_connection_uniq').on(table.id, table.connectionId),
  idOrgUniq: uniqueIndex('edr_tenants_id_org_uniq').on(table.id, table.orgId),
  orgIdx: index('edr_tenants_org_idx').on(table.orgId),
  partnerIdx: index('edr_tenants_partner_idx').on(table.partnerId),
  connectionIdx: index('edr_tenants_connection_idx').on(table.connectionId),
  connectionPartnerFk: foreignKey({
    columns: [table.connectionId, table.partnerId],
    foreignColumns: [edrConnections.id, edrConnections.partnerId],
    name: 'edr_tenants_connection_partner_fk',
  }).onDelete('cascade'),
  // DEFERRABLE INITIALLY IMMEDIATE in SQL; the migration is authoritative.
  orgPartnerFk: foreignKey({
    columns: [table.orgId, table.partnerId],
    foreignColumns: [organizations.id, organizations.partnerId],
    name: 'edr_tenants_org_partner_fk',
  }),
}));

/**
 * One vendor endpoint under a MAPPED tenant (RLS shape 1 — direct `org_id`,
 * NOT NULL; endpoints of unmapped tenants are counted, never stored, D5).
 * `partnerId` is denormalized for the composite FKs and the partner overview
 * scan; it is NOT a second RLS read branch.
 */
export const edrEndpoints = pgTable('edr_endpoints', {
  id: uuid('id').primaryKey().defaultRandom(),
  connectionId: uuid('connection_id').notNull(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  tenantId: uuid('tenant_id').notNull(),
  /** Denormalized from the connection so an ORG token can label the row. */
  provider: varchar('provider', { length: 30 }).notNull(),
  vendorEndpointId: varchar('vendor_endpoint_id', { length: 128 }).notNull(),
  hostname: varchar('hostname', { length: 255 }),
  fqdn: varchar('fqdn', { length: 255 }),
  serialNumber: varchar('serial_number', { length: 128 }),
  /** Lower-case, colon-separated; normalized by the adapter. */
  macAddresses: text('mac_addresses').array().notNull().default(sql`'{}'::text[]`),
  ipAddresses: text('ip_addresses').array().notNull().default(sql`'{}'::text[]`),
  osPlatform: varchar('os_platform', { length: 20 }).notNull().default('other').$type<EdrOsPlatform>(),
  osName: varchar('os_name', { length: 255 }),
  endpointType: varchar('endpoint_type', { length: 20 }).notNull().default('unknown').$type<EdrEndpointType>(),
  agentVersion: varchar('agent_version', { length: 64 }),
  health: varchar('health', { length: 20 }).notNull().default('unknown').$type<EdrEndpointHealth>(),
  online: boolean('online'),
  isolationState: varchar('isolation_state', { length: 20 }).notNull().default('unknown').$type<EdrIsolationState>(),
  tamperProtection: boolean('tamper_protection'),
  policyName: varchar('policy_name', { length: 255 }),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  /** Per-endpoint detail enrichment, refreshed oldest first. */
  vendorDetailSyncedAt: timestamp('vendor_detail_synced_at', { withTimezone: true }),
  /**
   * Link, not ownership. Named `breeze_device_id` on purpose (spec D4): a
   * `device_id` column would enrol the table in
   * `breeze_device_child_orgid_tables()` and in `cascadeDelete.test.ts`'s
   * `device_id` contract — both wrong for a link whose `org_id` comes from the
   * TENANT MAPPING. Its FK is `ON DELETE SET NULL (breeze_device_id)` in SQL
   * only; a device org move detaches it in `moveDeviceOrgInTransaction.ts`.
   */
  breezeDeviceId: uuid('breeze_device_id'),
  deviceMatchSource: varchar('device_match_source', { length: 20 }).$type<EdrDeviceMatchSource>(),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
  /** Full vendor record. `excludedOpen` in the export policy. */
  vendorRaw: jsonb('vendor_raw').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  connectionVendorUniq: uniqueIndex('edr_endpoints_connection_vendor_uniq')
    .on(table.connectionId, table.vendorEndpointId),
  idOrgUniq: uniqueIndex('edr_endpoints_id_org_uniq').on(table.id, table.orgId),
  /** Per CONNECTION, not global: a device may run two protection products. */
  connectionBreezeDeviceUniq: uniqueIndex('edr_endpoints_connection_breeze_device_uniq')
    .on(table.connectionId, table.breezeDeviceId)
    .where(sql`${table.breezeDeviceId} IS NOT NULL`),
  orgBreezeDeviceIdx: index('edr_endpoints_org_breeze_device_idx').on(table.orgId, table.breezeDeviceId),
  breezeDeviceIdx: index('edr_endpoints_breeze_device_idx').on(table.breezeDeviceId),
  tenantIdx: index('edr_endpoints_tenant_idx').on(table.tenantId),
  partnerHealthIdx: index('edr_endpoints_partner_health_idx').on(table.partnerId, table.health),
  connectionPartnerFk: foreignKey({
    columns: [table.connectionId, table.partnerId],
    foreignColumns: [edrConnections.id, edrConnections.partnerId],
    name: 'edr_endpoints_connection_partner_fk',
  }).onDelete('cascade'),
  tenantConnectionFk: foreignKey({
    columns: [table.tenantId, table.connectionId],
    foreignColumns: [edrTenants.id, edrTenants.connectionId],
    name: 'edr_endpoints_tenant_connection_fk',
  }).onDelete('cascade'),
  // DEFERRABLE INITIALLY IMMEDIATE in SQL.
  tenantOrgFk: foreignKey({
    columns: [table.tenantId, table.orgId],
    foreignColumns: [edrTenants.id, edrTenants.orgId],
    name: 'edr_endpoints_tenant_org_fk',
  }).onDelete('cascade'),
  // DEFERRABLE INITIALLY IMMEDIATE in SQL.
  orgPartnerFk: foreignKey({
    columns: [table.orgId, table.partnerId],
    foreignColumns: [organizations.id, organizations.partnerId],
    name: 'edr_endpoints_org_partner_fk',
  }),
  // edr_endpoints_breeze_device_org_fk: SQL only (column-list SET NULL).
}));

/**
 * One vendor alert / detection / threat / incident (RLS shape 1).
 *
 * D13 tombstones: a tenant remap sets `detachedAt` and nulls `tenantId` (the
 * DB pins "a tombstone holds no tenant"), and the live identity index is
 * partial on `detached_at IS NULL`, so the next sync creates a fresh row in
 * the new org instead of moving history across customers. Upserts must name
 * that predicate in their `ON CONFLICT` target.
 */
export const edrDetections = pgTable('edr_detections', {
  id: uuid('id').primaryKey().defaultRandom(),
  connectionId: uuid('connection_id').notNull(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  /** NULL once tombstoned. */
  tenantId: uuid('tenant_id'),
  /** Resolved at write time, back-filled by the inventory job. */
  endpointId: uuid('endpoint_id'),
  vendorEndpointId: varchar('vendor_endpoint_id', { length: 128 }),
  /** Denormalized from the endpoint link so the feed's site predicate needs no join. Link — see edrEndpoints. */
  breezeDeviceId: uuid('breeze_device_id'),
  provider: varchar('provider', { length: 30 }).notNull(),
  vendorDetectionId: varchar('vendor_detection_id', { length: 255 }).notNull(),
  vendorKind: varchar('vendor_kind', { length: 30 }).notNull().$type<EdrVendorKind>(),
  severity: varchar('severity', { length: 20 }).notNull().default('unknown').$type<EdrSeverity>(),
  vendorSeverity: varchar('vendor_severity', { length: 64 }),
  status: varchar('status', { length: 20 }).notNull().default('unknown').$type<EdrDetectionStatus>(),
  vendorStatus: varchar('vendor_status', { length: 64 }),
  /** Severity last published as an event/alert. */
  notifiedSeverity: varchar('notified_severity', { length: 20 }).$type<EdrSeverity>(),
  /** D13 tombstone. */
  detachedAt: timestamp('detached_at', { withTimezone: true }),
  /** D14: link cleared by an org move / device delete; `lastSiteId` keeps the site restriction. */
  deviceDetachedAt: timestamp('device_detached_at', { withTimezone: true }),
  lastSiteId: uuid('last_site_id'),
  title: varchar('title', { length: 500 }),
  category: varchar('category', { length: 128 }),
  threatName: varchar('threat_name', { length: 500 }),
  filePath: text('file_path'),
  processName: varchar('process_name', { length: 500 }),
  /** Technique ids as text[] (not jsonb) so the column stays `included` in the export policy. */
  mitreTechniques: text('mitre_techniques').array().notNull().default(sql`'{}'::text[]`),
  detectedAt: timestamp('detected_at', { withTimezone: true }),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  lastVendorUpdateAt: timestamp('last_vendor_update_at', { withTimezone: true }),
  /** `excludedOpen` in the export policy. */
  details: jsonb('details').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  liveVendorUniq: uniqueIndex('edr_detections_live_vendor_uniq')
    .on(table.connectionId, table.vendorKind, table.vendorDetectionId)
    .where(sql`${table.detachedAt} IS NULL`),
  idOrgUniq: uniqueIndex('edr_detections_id_org_uniq').on(table.id, table.orgId),
  orgStatusIdx: index('edr_detections_org_status_idx').on(table.orgId, table.status),
  orgSeverityStatusIdx: index('edr_detections_org_severity_status_idx')
    .on(table.orgId, table.severity, table.status),
  orgDetectedOpenIdx: index('edr_detections_org_detected_open_idx')
    .on(table.orgId, table.detectedAt.desc())
    .where(sql`${table.status} IN ('open', 'in_progress', 'unknown')`),
  breezeDeviceIdx: index('edr_detections_breeze_device_idx').on(table.breezeDeviceId),
  tenantIdx: index('edr_detections_tenant_idx').on(table.tenantId),
  endpointIdx: index('edr_detections_endpoint_idx').on(table.endpointId),
  connectionVendorEndpointIdx: index('edr_detections_connection_vendor_endpoint_idx')
    .on(table.connectionId, table.vendorEndpointId),
  connectionPartnerFk: foreignKey({
    columns: [table.connectionId, table.partnerId],
    foreignColumns: [edrConnections.id, edrConnections.partnerId],
    name: 'edr_detections_connection_partner_fk',
  }).onDelete('cascade'),
  // DEFERRABLE INITIALLY IMMEDIATE in SQL. Load-bearing: with tenant_id NULL
  // on a tombstone, this is the only tie between the row's org and its
  // connection's partner.
  orgPartnerFk: foreignKey({
    columns: [table.orgId, table.partnerId],
    foreignColumns: [organizations.id, organizations.partnerId],
    name: 'edr_detections_org_partner_fk',
  }),
  // SQL only (column-list SET NULL): edr_detections_tenant_connection_fk,
  // _tenant_org_fk, _endpoint_org_fk, _breeze_device_org_fk.
}));

/**
 * Audit + status ledger for EDR response actions (RLS shape 1; the
 * provider-neutral analogue of the SentinelOne `s1_actions` ledger). Not append-only — status advances — so not in
 * `AUDIT_ADMIN_REQUIRED_TABLES`. Written from W03.
 */
export const edrActions = pgTable('edr_actions', {
  id: uuid('id').primaryKey().defaultRandom(),
  connectionId: uuid('connection_id').notNull(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  /** NULL once tombstoned, as edrDetections. */
  tenantId: uuid('tenant_id'),
  endpointId: uuid('endpoint_id'),
  detectionId: uuid('detection_id'),
  /** Link — see edrEndpoints. */
  breezeDeviceId: uuid('breeze_device_id'),
  provider: varchar('provider', { length: 30 }).notNull(),
  action: varchar('action', { length: 40 }).notNull().$type<EdrActionKey>(),
  requestedBy: uuid('requested_by').references(() => users.id, { onDelete: 'set null' }),
  requestedVia: varchar('requested_via', { length: 20 }).notNull().$type<EdrActionRequestedVia>(),
  /** No FK in W01 — W03 decides. */
  aiSessionId: uuid('ai_session_id'),
  approvalId: uuid('approval_id'),
  status: varchar('status', { length: 20 }).notNull().default('queued').$type<EdrActionStatus>(),
  vendorActionId: varchar('vendor_action_id', { length: 255 }),
  /** `excludedOpen` in the export policy. */
  payload: jsonb('payload').$type<Record<string, unknown>>(),
  error: text('error'),
  detachedAt: timestamp('detached_at', { withTimezone: true }),
  requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  orgRequestedIdx: index('edr_actions_org_requested_idx').on(table.orgId, table.requestedAt.desc()),
  connectionIdx: index('edr_actions_connection_idx').on(table.connectionId),
  openStatusIdx: index('edr_actions_open_status_idx')
    .on(table.connectionId, table.status)
    .where(sql`${table.status} IN ('queued', 'submitted')`),
  breezeDeviceIdx: index('edr_actions_breeze_device_idx').on(table.breezeDeviceId),
  tenantIdx: index('edr_actions_tenant_idx').on(table.tenantId),
  endpointIdx: index('edr_actions_endpoint_idx').on(table.endpointId),
  detectionIdx: index('edr_actions_detection_idx').on(table.detectionId),
  connectionPartnerFk: foreignKey({
    columns: [table.connectionId, table.partnerId],
    foreignColumns: [edrConnections.id, edrConnections.partnerId],
    name: 'edr_actions_connection_partner_fk',
  }).onDelete('cascade'),
  // DEFERRABLE INITIALLY IMMEDIATE in SQL; load-bearing as on edrDetections.
  orgPartnerFk: foreignKey({
    columns: [table.orgId, table.partnerId],
    foreignColumns: [organizations.id, organizations.partnerId],
    name: 'edr_actions_org_partner_fk',
  }),
  // SQL only (column-list SET NULL): edr_actions_tenant_connection_fk,
  // _tenant_org_fk, _endpoint_org_fk, _detection_org_fk, _breeze_device_org_fk.
}));

export type EdrConnectionRow = typeof edrConnections.$inferSelect;
export type EdrTenantRow = typeof edrTenants.$inferSelect;
export type EdrEndpointRow = typeof edrEndpoints.$inferSelect;
export type EdrDetectionRow = typeof edrDetections.$inferSelect;
export type EdrActionRow = typeof edrActions.$inferSelect;
