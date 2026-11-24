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
  unique,
  foreignKey,
  check,
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
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  partnerActiveIdx: uniqueIndex('unifi_integrations_partner_active_idx')
    .on(table.partnerId)
    .where(sql`${table.isActive}`),
  // Target of unifi_integration_keys' composite FK (#11808).
  idPartnerUnique: unique('unifi_integrations_id_partner_unique').on(table.id, table.partnerId),
}));

// One encrypted UniFi Site Manager API key per row (#11808). Partner axis:
// partner_id is pinned to the integration's by the composite FK. The ciphertext
// keeps the legacy column-bound AAD tag: seal and open it ONLY through
// columnAad(UNIFI_KEY_COLUMN_SPEC) (services/unifi/unifiKeyService.ts), never
// decryptForColumn('unifi_integration_keys', ...).
export const unifiIntegrationKeys = pgTable('unifi_integration_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  integrationId: uuid('integration_id').notNull(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  label: text('label').notNull(),
  apiKeyEncrypted: text('api_key_encrypted').notNull(),
  keyLast4: varchar('key_last4', { length: 4 }),
  isEnabled: boolean('is_enabled').notNull().default(true),
  status: varchar('status', { length: 20 }).notNull().default('pending'),
  lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
  lastSyncStatus: varchar('last_sync_status', { length: 16 }),
  lastSyncError: text('last_sync_error'),
  lastOkAt: timestamp('last_ok_at', { withTimezone: true }),
  hostsSeen: integer('hosts_seen'),
  sitesSeen: integer('sites_seen'),
  lastSeenHostIds: text('last_seen_host_ids').array(),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  integrationFk: foreignKey({
    columns: [table.integrationId, table.partnerId],
    foreignColumns: [unifiIntegrations.id, unifiIntegrations.partnerId],
    name: 'unifi_integration_keys_integration_fk',
  }).onDelete('cascade'),
  labelIdx: uniqueIndex('unifi_integration_keys_label_idx')
    .on(table.integrationId, sql`lower(btrim(${table.label}))`),
  integrationIdx: index('unifi_integration_keys_integration_idx')
    .on(table.integrationId, table.createdAt, table.id),
  labelCheck: check('unifi_integration_keys_label_chk', sql`char_length(btrim(${table.label})) BETWEEN 1 AND 100`),
  statusCheck: check(
    'unifi_integration_keys_status_chk',
    sql`${table.status} IN ('pending', 'connected', 'reauth_required', 'error')`,
  ),
  lastSyncStatusCheck: check(
    'unifi_integration_keys_last_sync_status_chk',
    sql`${table.lastSyncStatus} IS NULL OR ${table.lastSyncStatus} IN ('success', 'failed', 'skipped')`,
  ),
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
  // M2 topology: advanced whenever UniFi topology sources this mapping authorized are revoked.
  topologyGeneration: bigint('topology_generation', { mode: 'number' }).notNull().default(0),
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
  // Listed sites with no mapping row. NULL = not recorded (older, failed, no-mapping or incomplete-list runs).
  sitesUnmapped: integer('sites_unmapped'),
  error: text('error'),
  // One entry per API key the run read (#11808): { keyId, label, status, hostsSeen, sitesSeen, error }.
  // Never a key or its ciphertext. NULL on runs before W2.
  keyResults: jsonb('key_results'),
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
  // M2 topology: advanced whenever this collector's UniFi topology sources are revoked.
  topologyGeneration: bigint('topology_generation', { mode: 'number' }).notNull().default(0),
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
  // Wi-Fi current state (topology v2 materializer, spec section 8.3). Written only by the
  // materializer; each family is gated by its own *_observed_at (non-null = that family's row was present).
  controllerState: text('controller_state'),
  wifiCapable: boolean('wifi_capable'),
  deviceInventoryObservedAt: timestamp('device_inventory_observed_at'),
  wifiRadioOverview: jsonb('wifi_radio_overview'),
  wifiRadioStatistics: jsonb('wifi_radio_statistics'),
  uplinkRxRateBps: bigint('uplink_rx_rate_bps', { mode: 'number' }),
  uplinkTxRateBps: bigint('uplink_tx_rate_bps', { mode: 'number' }),
  wifiDetailObservedAt: timestamp('wifi_detail_observed_at'),
  wifiStatisticsObservedAt: timestamp('wifi_statistics_observed_at'),
  wifiClientsObservedAt: timestamp('wifi_clients_observed_at'),
  statisticsLastHeartbeatAt: timestamp('statistics_last_heartbeat_at'),
  statisticsNextHeartbeatAt: timestamp('statistics_next_heartbeat_at'),
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
  // Controller site the client was reported on (W04, #11504). '' means
  // "controller site not recorded": every legacy row, plus a row a cloud
  // collector wrote when the agent sent no site id (a self-hosted collector
  // skips such records). It is never a real controller site id. Part of the
  // unique identity below, so the same MAC at two sites of one controller is two
  // rows, each filed under its own mapped site (possibly in different orgs).
  localSiteId: text('local_site_id').notNull().default(''),
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
  collectorSiteMacIdx: uniqueIndex('unifi_clients_collector_site_mac_idx').on(table.collectorId, table.localSiteId, table.mac),
  orgMacIdx: index('unifi_clients_org_mac_idx').on(table.orgId, table.mac),
}));

export const unifiControllerSites = pgTable('unifi_controller_sites', {
  id: uuid('id').primaryKey().defaultRandom(),
  collectorId: uuid('collector_id').notNull().references(() => unifiCollectors.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  localSiteId: text('local_site_id').notNull(),
  name: text('name'),
  lastSeenAt: timestamp('last_seen_at').defaultNow().notNull(),
  // M2 topology: bounded coverage note for a controller site that produced no topology.
  topologyCoverageReason: varchar('topology_coverage_reason', { length: 64 }),
  topologyCoverageAt: timestamp('topology_coverage_at', { withTimezone: true }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  collectorSiteIdx: uniqueIndex('unifi_controller_sites_collector_site_idx')
    .on(table.collectorId, table.localSiteId),
  topologyCoverageReasonChk: check('unifi_controller_sites_topology_coverage_reason_chk',
    sql`${table.topologyCoverageReason} IS NULL OR ${table.topologyCoverageReason} ~ '^[a-z][a-z0-9_]{0,63}$'`),
}));
