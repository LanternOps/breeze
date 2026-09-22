import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  text,
  timestamp,
  boolean,
  integer,
  bigint,
  jsonb,
  date,
  index,
  uniqueIndex,
  foreignKey,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { ExternalBackupStatus } from '@breeze/shared';
import { organizations, partners } from './orgs';
import { users } from './users';
import { devices } from './devices';

/**
 * Normalized, vendor-neutral outcome of the most recent backup session.
 *
 * Label order is the contract: `EXTERNAL_BACKUP_STATUSES` in
 * `packages/shared/src/types/backupHealth.ts` carries the same tuple in the
 * same order, and `backupProviderRls.integration.test.ts` compares the two
 * against live `pg_enum`. `ALTER TYPE ... ADD VALUE` appends, so a future
 * vendor's extra status lands at the end of both.
 *
 * NOT to be confused with `backupProviderEnum` (`backup_provider`) in
 * `./backup`, which names the STORAGE DESTINATION of a FIRST-PARTY backup
 * (local | s3 | azure_blob | ...). Nothing here reuses it.
 */
export const EXTERNAL_BACKUP_STATUS_ENUM_VALUES = [
  'completed',
  'completed_with_errors',
  'failed',
  'in_progress',
  'interrupted',
  'over_quota',
  'no_selection',
  'not_started',
  'no_backups',
  'unknown',
] as const;

export const externalBackupStatusEnum = pgEnum(
  'external_backup_status',
  EXTERNAL_BACKUP_STATUS_ENUM_VALUES,
);

/**
 * One MSP-level connection to an external backup vendor (RLS shape 3 —
 * partner axis, no org axis at all). Credentials are a console login, sealed
 * with an AAD bound to THIS row's id (`encryptedColumnRegistry`,
 * `aadBinding: 'row'`), so a ciphertext moved into another partner's row does
 * not decrypt. No route ever returns `credentialsEncrypted`.
 */
export const backupProviderConnections = pgTable('backup_provider_connections', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  /** Adapter key, validated by `getBackupProvider` — an open string so a second vendor needs no migration. */
  provider: varchar('provider', { length: 30 }).notNull(),
  name: varchar('name', { length: 200 }).notNull(),
  baseUrl: varchar('base_url', { length: 300 })
    .notNull()
    .default('https://api.backup.management/jsonapi'),
  credentialsEncrypted: text('credentials_encrypted').notNull(),
  vendorRootId: varchar('vendor_root_id', { length: 120 }),
  vendorRootName: varchar('vendor_root_name', { length: 255 }),
  isActive: boolean('is_active').notNull().default(true),
  status: varchar('status', { length: 20 })
    .notNull()
    .default('connected')
    .$type<'connected' | 'error' | 'reauth_required'>(),
  syncIntervalMinutes: integer('sync_interval_minutes').notNull().default(30),
  /** D5 — reveal the vendor name in the client portal instead of the generic label. */
  showProviderNameInPortal: boolean('show_provider_name_in_portal').notNull().default(false),
  lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
  lastSyncStatus: varchar('last_sync_status', { length: 20 })
    .$type<'running' | 'success' | 'partial' | 'error'>(),
  lastSyncError: text('last_sync_error'),
  lastSyncCustomers: integer('last_sync_customers'),
  lastSyncUnmappedCustomers: integer('last_sync_unmapped_customers'),
  lastSyncDevices: integer('last_sync_devices'),
  lastSyncUnmappedDevices: integer('last_sync_unmapped_devices'),
  lastSyncLinkedDevices: integer('last_sync_linked_devices'),
  lastSyncAmbiguousDevices: integer('last_sync_ambiguous_devices'),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  idPartnerUniq: uniqueIndex('backup_provider_connections_id_partner_uniq').on(table.id, table.partnerId),
  partnerProviderNameUniq: uniqueIndex('backup_provider_connections_partner_provider_name_uniq')
    .on(table.partnerId, table.provider, table.name),
  partnerIdx: index('backup_provider_connections_partner_idx').on(table.partnerId),
}));

/**
 * A customer discovered in the vendor console, and the Breeze organization it
 * maps to (RLS shape 3 — partner axis). `orgId` is the mapping TARGET and may
 * be NULL: an unmapped customer must stay visible to the partner admin who has
 * to map it, which is why this table is in `ORG_AXIS_POLICY_EXCLUDED_TABLES`
 * even though it carries an `org_id` column — the same treatment as
 * `huntress_org_mappings`.
 */
export const backupProviderCustomers = pgTable('backup_provider_customers', {
  id: uuid('id').primaryKey().defaultRandom(),
  connectionId: uuid('connection_id').notNull(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  vendorCustomerId: varchar('vendor_customer_id', { length: 128 }).notNull(),
  vendorCustomerName: varchar('vendor_customer_name', { length: 255 }).notNull(),
  vendorParentId: varchar('vendor_parent_id', { length: 128 }),
  vendorLevel: varchar('vendor_level', { length: 40 }),
  vendorExternalCode: varchar('vendor_external_code', { length: 255 }),
  orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'set null' }),
  /** NULL = never mapped. `manual`/`manual_unmapped` are never touched by auto-mapping. */
  mappingSource: varchar('mapping_source', { length: 20 })
    .$type<'manual' | 'auto_name' | 'auto_external_code' | 'manual_unmapped'>(),
  deviceCount: integer('device_count').notNull().default(0),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  connectionVendorUniq: uniqueIndex('backup_provider_customers_connection_vendor_uniq')
    .on(table.connectionId, table.vendorCustomerId),
  idConnectionUniq: uniqueIndex('backup_provider_customers_id_connection_uniq').on(table.id, table.connectionId),
  idOrgUniq: uniqueIndex('backup_provider_customers_id_org_uniq').on(table.id, table.orgId),
  orgIdx: index('backup_provider_customers_org_idx').on(table.orgId),
  partnerIdx: index('backup_provider_customers_partner_idx').on(table.partnerId),
  connectionIdx: index('backup_provider_customers_connection_idx').on(table.connectionId),
  connectionPartnerFk: foreignKey({
    columns: [table.connectionId, table.partnerId],
    foreignColumns: [backupProviderConnections.id, backupProviderConnections.partnerId],
    name: 'backup_provider_customers_connection_partner_fk',
  }).onDelete('cascade'),
  // Declared DEFERRABLE INITIALLY IMMEDIATE in SQL (drizzle-kit cannot express
  // deferrability); the migration is authoritative.
  orgPartnerFk: foreignKey({
    columns: [table.orgId, table.partnerId],
    foreignColumns: [organizations.id, organizations.partnerId],
    name: 'backup_provider_customers_org_partner_fk',
  }),
}));

/**
 * One vendor device under a MAPPED customer (RLS shape 1 — direct `org_id`,
 * NOT NULL). Devices under an unmapped customer are counted, never stored
 * (spec D8), so `org_id` is always known at write time.
 *
 * `partnerId` is denormalized for the partner-wide overview scan and for the
 * composite FK back to the connection. It is NOT a second RLS read branch:
 * adding one would let a partner token with restricted org access read every
 * org's rows.
 */
export const backupProviderDevices = pgTable('backup_provider_devices', {
  id: uuid('id').primaryKey().defaultRandom(),
  connectionId: uuid('connection_id').notNull(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  customerId: uuid('customer_id').notNull(),
  /** Denormalized from the connection so an ORG token (the portal) can label the row. */
  provider: varchar('provider', { length: 30 }).notNull(),
  portalShowProviderName: boolean('portal_show_provider_name').notNull().default(false),
  vendorDeviceId: varchar('vendor_device_id', { length: 128 }).notNull(),
  vendorDeviceName: varchar('vendor_device_name', { length: 255 }).notNull(),
  computerName: varchar('computer_name', { length: 255 }),
  osType: varchar('os_type', { length: 20 })
    .notNull()
    .default('unknown')
    .$type<'workstation' | 'server' | 'unknown'>(),
  osVersion: varchar('os_version', { length: 255 }),
  clientVersion: varchar('client_version', { length: 64 }),
  /** Lower-case, colon-separated; normalized by the adapter. */
  macAddresses: text('mac_addresses').array().notNull().default(sql`'{}'::text[]`),
  accountType: varchar('account_type', { length: 20 })
    .notNull()
    .default('unknown')
    .$type<'backup_manager' | 'm365' | 'unknown'>(),
  dataSources: text('data_sources').array().notNull().default(sql`'{}'::text[]`),
  status: externalBackupStatusEnum('status').notNull().default('unknown').$type<ExternalBackupStatus>(),
  vendorStatusCode: integer('vendor_status_code'),
  lastSessionAt: timestamp('last_session_at', { withTimezone: true }),
  lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
  lastCompletedAt: timestamp('last_completed_at', { withTimezone: true }),
  selectedBytes: bigint('selected_bytes', { mode: 'number' }),
  usedBytes: bigint('used_bytes', { mode: 'number' }),
  errorsCount: integer('errors_count').notNull().default(0),
  /**
   * Link, not ownership. Named `breeze_device_id` on purpose: `device_id`
   * would enrol the table in `breeze_device_child_orgid_tables()` (the generic
   * `SET org_id` re-stamp loop the devices org-move trigger fires) and in
   * `cascadeDelete.test.ts`'s `device_id` contract — both wrong for a link
   * whose `org_id` comes from the CUSTOMER MAPPING, not from the device, and
   * whose FK is `ON DELETE SET NULL (breeze_device_id)`. The rename is blocked
   * by a contract case in `routes/devices/cascadeDelete.test.ts`; the org-move
   * detach it forces lives in `routes/devices/moveOrg.ts`.
   */
  breezeDeviceId: uuid('breeze_device_id'),
  deviceMatchSource: varchar('device_match_source', { length: 20 })
    .$type<'auto_hostname' | 'auto_mac' | 'manual'>(),
  /** W02 two-poll hysteresis: the alert condition seen on the PREVIOUS sync. */
  pendingCondition: varchar('pending_condition', { length: 30 }),
  vendorCreatedAt: timestamp('vendor_created_at', { withTimezone: true }),
  vendorExpiresAt: timestamp('vendor_expires_at', { withTimezone: true }),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  /** Full vendor Settings map, for debugging and future columns. `excludedOpen` in the export policy. */
  vendorRaw: jsonb('vendor_raw').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  connectionVendorUniq: uniqueIndex('backup_provider_devices_connection_vendor_uniq')
    .on(table.connectionId, table.vendorDeviceId),
  idOrgUniq: uniqueIndex('backup_provider_devices_id_org_uniq').on(table.id, table.orgId),
  breezeDeviceUniq: uniqueIndex('backup_provider_devices_breeze_device_uniq')
    .on(table.breezeDeviceId)
    .where(sql`${table.breezeDeviceId} IS NOT NULL`),
  orgStatusIdx: index('backup_provider_devices_org_status_idx').on(table.orgId, table.status),
  partnerStatusIdx: index('backup_provider_devices_partner_status_idx').on(table.partnerId, table.status),
  orgBreezeDeviceIdx: index('backup_provider_devices_org_breeze_device_idx').on(table.orgId, table.breezeDeviceId),
  customerIdx: index('backup_provider_devices_customer_idx').on(table.customerId),
  lastSuccessIdx: index('backup_provider_devices_last_success_idx').on(table.lastSuccessAt),
  connectionPartnerFk: foreignKey({
    columns: [table.connectionId, table.partnerId],
    foreignColumns: [backupProviderConnections.id, backupProviderConnections.partnerId],
    name: 'backup_provider_devices_connection_partner_fk',
  }).onDelete('cascade'),
  customerConnectionFk: foreignKey({
    columns: [table.customerId, table.connectionId],
    foreignColumns: [backupProviderCustomers.id, backupProviderCustomers.connectionId],
    name: 'backup_provider_devices_customer_connection_fk',
  }).onDelete('cascade'),
  customerOrgFk: foreignKey({
    columns: [table.customerId, table.orgId],
    foreignColumns: [backupProviderCustomers.id, backupProviderCustomers.orgId],
    name: 'backup_provider_devices_customer_org_fk',
  }).onDelete('cascade'),
  // `ON DELETE SET NULL (breeze_device_id)` — the PG15 COLUMN-LIST form —
  // cannot be expressed in Drizzle; the migration is authoritative and
  // `backupProviderRls.integration.test.ts` pins `confdelsetcols`. Declaring
  // it here without the column list would make drizzle-kit propose a bare SET
  // NULL, so it is deliberately NOT declared in this file at all (same as
  // m365_intune_devices, which also omits it).
}));

/**
 * Observed daily health for the 28-day bar (spec D10). One row per provider
 * device per UTC day, upserted by every sync: `status` = worse of (existing,
 * observed), `errorsCount` = max, `observations` + 1.
 *
 * These are OBSERVATIONS, not sessions. A day with no poll is a gap; a failed
 * session seen by 40 polls is one failed day. Nothing downstream may count
 * these rows as jobs ("N backups succeeded" is never derivable from here).
 */
export const backupProviderDeviceHistory = pgTable('backup_provider_device_history', {
  id: uuid('id').primaryKey().defaultRandom(),
  providerDeviceId: uuid('provider_device_id').notNull(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  day: date('day').notNull(),
  status: externalBackupStatusEnum('status').notNull().$type<ExternalBackupStatus>(),
  lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
  errorsCount: integer('errors_count').notNull().default(0),
  observations: integer('observations').notNull().default(1),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  deviceDayUniq: uniqueIndex('backup_provider_device_history_device_day_uniq')
    .on(table.providerDeviceId, table.day),
  orgDayIdx: index('backup_provider_device_history_org_day_idx').on(table.orgId, table.day),
  deviceOrgFk: foreignKey({
    columns: [table.providerDeviceId, table.orgId],
    foreignColumns: [backupProviderDevices.id, backupProviderDevices.orgId],
    name: 'backup_provider_device_history_device_org_fk',
  }).onDelete('cascade'),
}));

export type BackupProviderConnectionRow = typeof backupProviderConnections.$inferSelect;
export type BackupProviderCustomerRow = typeof backupProviderCustomers.$inferSelect;
export type BackupProviderDeviceRow = typeof backupProviderDevices.$inferSelect;
export type BackupProviderDeviceHistoryRow = typeof backupProviderDeviceHistory.$inferSelect;
