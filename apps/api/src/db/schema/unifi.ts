import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  boolean,
  integer,
  bigint,
  real,
  jsonb,
  inet,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { organizations, partners, sites } from './orgs';
import { users } from './users';
import { discoveredAssets } from './discovery';
import { devices } from './devices';

export const unifiIntegrations = pgTable('unifi_integrations', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  connectionType: text('connection_type').notNull().default('cloud'),
  baseUrl: text('base_url').notNull().default('https://api.ui.com'),
  apiKeyEncrypted: text('api_key_encrypted'),
  accountLabel: text('account_label'),
  isActive: boolean('is_active').notNull().default(true),
  status: varchar('status', { length: 20 }).notNull().default('connected'),
  lastSyncAt: timestamp('last_sync_at'),
  lastSyncStatus: varchar('last_sync_status', { length: 20 }),
  lastSyncError: text('last_sync_error'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  partnerActiveIdx: uniqueIndex('unifi_integrations_partner_active_idx')
    .on(table.partnerId)
    .where(sql`${table.isActive}`),
}));

export const unifiSiteMappings = pgTable('unifi_site_mappings', {
  id: uuid('id').primaryKey().defaultRandom(),
  integrationId: uuid('integration_id').notNull().references(() => unifiIntegrations.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  siteId: uuid('site_id').notNull().references(() => sites.id),
  unifiHostId: text('unifi_host_id').notNull(),
  unifiSiteId: text('unifi_site_id').notNull(),
  unifiHostName: text('unifi_host_name'),
  unifiSiteName: text('unifi_site_name'),
  wanMetrics: jsonb('wan_metrics'),
  wanMetricsAt: timestamp('wan_metrics_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  uniqueSiteIdx: uniqueIndex('unifi_site_mappings_unique_site_idx')
    .on(table.integrationId, table.unifiHostId, table.unifiSiteId),
}));

export const unifiDevices = pgTable('unifi_devices', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  siteId: uuid('site_id').notNull().references(() => sites.id),
  integrationId: uuid('integration_id').notNull().references(() => unifiIntegrations.id, { onDelete: 'cascade' }),
  mappingId: uuid('mapping_id').notNull().references(() => unifiSiteMappings.id, { onDelete: 'cascade' }),
  discoveredAssetId: uuid('discovered_asset_id').references(() => discoveredAssets.id),
  unifiDeviceId: text('unifi_device_id').notNull(),
  mac: text('mac'),
  name: text('name'),
  model: text('model'),
  deviceType: varchar('device_type', { length: 40 }),
  ipAddress: inet('ip_address'),
  firmwareVersion: text('firmware_version'),
  firmwareUpdatable: boolean('firmware_updatable'),
  adoptionState: varchar('adoption_state', { length: 30 }),
  uptimeSeconds: bigint('uptime_seconds', { mode: 'number' }),
  isStale: boolean('is_stale').notNull().default(false),
  lastSeenAt: timestamp('last_seen_at'),
  raw: jsonb('raw').notNull(),
  firstSyncedAt: timestamp('first_synced_at').defaultNow().notNull(),
  lastSyncedAt: timestamp('last_synced_at').defaultNow().notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  integrationDeviceIdx: uniqueIndex('unifi_devices_integration_device_idx')
    .on(table.integrationId, table.unifiDeviceId),
  orgMacIdx: index('unifi_devices_org_mac_idx').on(table.orgId, table.mac),
}));

export const unifiSyncRuns = pgTable('unifi_sync_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  integrationId: uuid('integration_id').notNull().references(() => unifiIntegrations.id, { onDelete: 'cascade' }),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  trigger: varchar('trigger', { length: 16 }).notNull(),
  status: varchar('status', { length: 16 }).notNull(),
  startedAt: timestamp('started_at').defaultNow().notNull(),
  finishedAt: timestamp('finished_at'),
  hostsSeen: integer('hosts_seen').notNull().default(0),
  devicesCreated: integer('devices_created').notNull().default(0),
  devicesUpdated: integer('devices_updated').notNull().default(0),
  devicesUnchanged: integer('devices_unchanged').notNull().default(0),
  devicesRemoved: integer('devices_removed').notNull().default(0),
  error: text('error'),
}, (table) => ({
  integrationStartedIdx: index('unifi_sync_runs_integration_started_idx')
    .on(table.integrationId, table.startedAt.desc()),
}));

export const unifiCollectors = pgTable('unifi_collectors', {
  id: uuid('id').primaryKey().defaultRandom(),
  integrationId: uuid('integration_id').notNull().references(() => unifiIntegrations.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  siteId: uuid('site_id').notNull().references(() => sites.id),
  unifiHostId: text('unifi_host_id'),
  collectorDeviceId: uuid('collector_device_id').notNull().references(() => devices.id),
  controllerUrl: text('controller_url').notNull(),
  localApiKeyEncrypted: text('local_api_key_encrypted').notNull(),
  isEnabled: boolean('is_enabled').notNull().default(true),
  pollIntervalSeconds: integer('poll_interval_seconds').notNull().default(60),
  status: varchar('status', { length: 20 }).notNull().default('pending'),
  firmwareOk: boolean('firmware_ok'),
  lastPollAt: timestamp('last_poll_at'),
  lastPollStatus: varchar('last_poll_status', { length: 16 }),
  lastPollError: text('last_poll_error'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  integrationHostIdx: uniqueIndex('unifi_collectors_integration_host_idx')
    .on(table.integrationId, table.unifiHostId)
    .where(sql`${table.unifiHostId} IS NOT NULL`),
  integrationUrlIdx: uniqueIndex('unifi_collectors_integration_url_idx')
    .on(table.integrationId, table.controllerUrl)
    .where(sql`${table.unifiHostId} IS NULL`),
  deviceIdx: index('unifi_collectors_device_idx').on(table.collectorDeviceId).where(sql`${table.isEnabled}`),
}));

export const unifiDeviceTelemetry = pgTable('unifi_device_telemetry', {
  id: uuid('id').primaryKey().defaultRandom(),
  collectorId: uuid('collector_id').notNull().references(() => unifiCollectors.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  siteId: uuid('site_id').notNull().references(() => sites.id),
  unifiDeviceId: text('unifi_device_id').notNull(),
  mac: text('mac'),
  name: text('name'),
  uptimeSeconds: bigint('uptime_seconds', { mode: 'number' }),
  cpuPct: real('cpu_pct'),
  memPct: real('mem_pct'),
  txBytes: bigint('tx_bytes', { mode: 'number' }),
  rxBytes: bigint('rx_bytes', { mode: 'number' }),
  numClients: integer('num_clients'),
  discoveredAssetId: uuid('discovered_asset_id').references(() => discoveredAssets.id),
  poePorts: jsonb('poe_ports'),
  raw: jsonb('raw').notNull(),
  isStale: boolean('is_stale').notNull().default(false),
  lastSeenAt: timestamp('last_seen_at'),
  firstSyncedAt: timestamp('first_synced_at').defaultNow().notNull(),
  lastSyncedAt: timestamp('last_synced_at').defaultNow().notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  collectorDeviceIdx: uniqueIndex('unifi_device_telemetry_collector_device_idx').on(table.collectorId, table.unifiDeviceId),
  orgIdx: index('unifi_device_telemetry_org_idx').on(table.orgId, table.siteId),
}));

export const unifiClients = pgTable('unifi_clients', {
  id: uuid('id').primaryKey().defaultRandom(),
  collectorId: uuid('collector_id').notNull().references(() => unifiCollectors.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  siteId: uuid('site_id').notNull().references(() => sites.id),
  mac: text('mac').notNull(),
  hostname: text('hostname'),
  ipAddress: inet('ip_address'),
  connectedDeviceId: text('connected_device_id'),
  uplinkPortIdx: integer('uplink_port_idx'),
  isWired: boolean('is_wired'),
  ssid: text('ssid'),
  vlan: integer('vlan'),
  signalDbm: integer('signal_dbm'),
  txBytes: bigint('tx_bytes', { mode: 'number' }),
  rxBytes: bigint('rx_bytes', { mode: 'number' }),
  uptimeSeconds: bigint('uptime_seconds', { mode: 'number' }),
  discoveredAssetId: uuid('discovered_asset_id').references(() => discoveredAssets.id),
  raw: jsonb('raw').notNull(),
  isStale: boolean('is_stale').notNull().default(false),
  firstSeenAt: timestamp('first_seen_at').defaultNow().notNull(),
  lastSeenAt: timestamp('last_seen_at').defaultNow().notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  collectorMacIdx: uniqueIndex('unifi_clients_collector_mac_idx').on(table.collectorId, table.mac),
  orgMacIdx: index('unifi_clients_org_mac_idx').on(table.orgId, table.mac),
}));

export const unifiControllerSites = pgTable('unifi_controller_sites', {
  id: uuid('id').primaryKey().defaultRandom(),
  collectorId: uuid('collector_id').notNull().references(() => unifiCollectors.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  localSiteId: text('local_site_id').notNull(),
  name: text('name'),
  lastSeenAt: timestamp('last_seen_at').defaultNow().notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  collectorSiteIdx: uniqueIndex('unifi_controller_sites_collector_site_idx')
    .on(table.collectorId, table.localSiteId),
}));
