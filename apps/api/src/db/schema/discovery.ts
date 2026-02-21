import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  boolean,
  jsonb,
  pgEnum,
  integer,
  inet,
  real,
  uniqueIndex,
  index
} from 'drizzle-orm/pg-core';
import { organizations, sites, partners } from './orgs';
import { users } from './users';
import { devices } from './devices';
import { alerts } from './alerts';
import type { NetworkBaselineScanSchedule, NetworkBaselineAlertSettings } from '@breeze/shared';

export const discoveredAssetTypeEnum = pgEnum('discovered_asset_type', [
  'workstation',
  'server',
  'printer',
  'router',
  'switch',
  'firewall',
  'access_point',
  'phone',
  'iot',
  'camera',
  'nas',
  'unknown'
]);


export const discoveredAssetApprovalStatusEnum = pgEnum('discovered_asset_approval_status', [
  'pending',
  'approved',
  'dismissed'
]);

export const discoveryJobStatusEnum = pgEnum('discovery_job_status', [
  'scheduled',
  'running',
  'completed',
  'failed',
  'cancelled'
]);

export const discoveryMethodEnum = pgEnum('discovery_method', [
  'arp',
  'ping',
  'port_scan',
  'snmp',
  'wmi',
  'ssh',
  'mdns',
  'netbios'
]);

export const discoveryProfiles = pgTable('discovery_profiles', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  siteId: uuid('site_id').notNull().references(() => sites.id),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  enabled: boolean('enabled').notNull().default(true),
  subnets: text('subnets').array().notNull().default([]),
  excludeIps: text('exclude_ips').array().notNull().default([]),
  methods: discoveryMethodEnum('methods').array().notNull().default([]),
  portRanges: jsonb('port_ranges'),
  snmpCommunities: text('snmp_communities').array().default([]),
  snmpCredentials: jsonb('snmp_credentials'),
  schedule: jsonb('schedule'),
  deepScan: boolean('deep_scan').notNull().default(false),
  identifyOS: boolean('identify_os').notNull().default(false),
  resolveHostnames: boolean('resolve_hostnames').notNull().default(false),
  timeout: integer('timeout'),
  concurrency: integer('concurrency'),
  alertSettings: jsonb('alert_settings').$type<DiscoveryProfileAlertSettings>(),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
});

export const discoveryJobs = pgTable('discovery_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  profileId: uuid('profile_id').notNull().references(() => discoveryProfiles.id),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  siteId: uuid('site_id').notNull().references(() => sites.id),
  agentId: varchar('agent_id', { length: 64 }),
  status: discoveryJobStatusEnum('status').notNull().default('scheduled'),
  scheduledAt: timestamp('scheduled_at'),
  startedAt: timestamp('started_at'),
  completedAt: timestamp('completed_at'),
  hostsScanned: integer('hosts_scanned'),
  hostsDiscovered: integer('hosts_discovered'),
  newAssets: integer('new_assets'),
  errors: jsonb('errors'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
});

export const discoveredAssets = pgTable('discovered_assets', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  siteId: uuid('site_id').notNull().references(() => sites.id),
  ipAddress: inet('ip_address').notNull(),
  macAddress: varchar('mac_address', { length: 17 }),
  hostname: varchar('hostname', { length: 255 }),
  netbiosName: varchar('netbios_name', { length: 255 }),
  assetType: discoveredAssetTypeEnum('asset_type').notNull().default('unknown'),
  approvalStatus: discoveredAssetApprovalStatusEnum('approval_status').notNull().default('pending'),
  isOnline: boolean('is_online').notNull().default(false),
  approvedBy: uuid('approved_by').references(() => users.id),
  approvedAt: timestamp('approved_at'),
  dismissedBy: uuid('dismissed_by').references(() => users.id),
  dismissedAt: timestamp('dismissed_at'),
  manufacturer: varchar('manufacturer', { length: 255 }),
  model: varchar('model', { length: 255 }),
  openPorts: jsonb('open_ports'),
  osFingerprint: jsonb('os_fingerprint'),
  snmpData: jsonb('snmp_data'),
  responseTimeMs: real('response_time_ms'),
  linkedDeviceId: uuid('linked_device_id').references(() => devices.id),
  firstSeenAt: timestamp('first_seen_at').defaultNow().notNull(),
  lastSeenAt: timestamp('last_seen_at'),
  lastJobId: uuid('last_job_id').references(() => discoveryJobs.id),
  discoveryMethods: discoveryMethodEnum('discovery_methods').array().default([]),
  notes: text('notes'),
  tags: text('tags').array().default([]),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (table) => ({
  orgIpUnique: uniqueIndex('discovered_assets_org_ip_unique').on(table.orgId, table.ipAddress)
}));

export interface KnownNetworkDevice {
  ip: string;
  mac?: string | null;
  hostname?: string | null;
  assetType?: typeof discoveredAssetTypeEnum.enumValues[number] | null;
  manufacturer?: string | null;
  linkedDeviceId?: string | null;
  firstSeen: string;
  lastSeen: string;
}

export interface DiscoveryProfileAlertSettings {
  enabled: boolean;
  alertOnNew: boolean;
  alertOnDisappeared: boolean;
  alertOnChanged: boolean;
  changeRetentionDays: number;
}

export type { NetworkBaselineScanSchedule, NetworkBaselineAlertSettings } from '@breeze/shared';

export const networkKnownGuests = pgTable('network_known_guests', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id, { onDelete: 'cascade' }),
  macAddress: varchar('mac_address', { length: 17 }).notNull(),
  label: varchar('label', { length: 255 }).notNull(),
  notes: text('notes'),
  addedBy: uuid('added_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (table) => ({
  partnerMacUnique: uniqueIndex('network_known_guests_partner_mac_unique').on(table.partnerId, table.macAddress),
  partnerIdIdx: index('network_known_guests_partner_id_idx').on(table.partnerId)
}));

export const networkBaselines = pgTable('network_baselines', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  siteId: uuid('site_id').notNull().references(() => sites.id),
  subnet: varchar('subnet', { length: 50 }).notNull(),
  lastScanAt: timestamp('last_scan_at'),
  lastScanJobId: uuid('last_scan_job_id').references(() => discoveryJobs.id),
  knownDevices: jsonb('known_devices').$type<KnownNetworkDevice[]>().notNull().default([]),
  scanSchedule: jsonb('scan_schedule').$type<NetworkBaselineScanSchedule>(),
  alertSettings: jsonb('alert_settings').$type<NetworkBaselineAlertSettings>().notNull().default({
    newDevice: true,
    disappeared: true,
    changed: true,
    rogueDevice: false
  }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (table) => ({
  orgSiteSubnetUnique: uniqueIndex('network_baselines_org_site_subnet_unique').on(
    table.orgId,
    table.siteId,
    table.subnet
  ),
  orgIdIdx: index('network_baselines_org_id_idx').on(table.orgId),
  siteIdIdx: index('network_baselines_site_id_idx').on(table.siteId)
}));

export const networkEventTypeEnum = pgEnum('network_event_type', [
  'new_device',
  'device_disappeared',
  'device_changed',
  'rogue_device'
]);

export const networkChangeEvents = pgTable('network_change_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  siteId: uuid('site_id').notNull().references(() => sites.id),
  baselineId: uuid('baseline_id').notNull().references(() => networkBaselines.id),
  profileId: uuid('profile_id').references(() => discoveryProfiles.id),
  eventType: networkEventTypeEnum('event_type').notNull(),
  ipAddress: inet('ip_address').notNull(),
  macAddress: varchar('mac_address', { length: 17 }),
  hostname: varchar('hostname', { length: 255 }),
  assetType: discoveredAssetTypeEnum('asset_type'),
  previousState: jsonb('previous_state'),
  currentState: jsonb('current_state'),
  detectedAt: timestamp('detected_at').defaultNow().notNull(),
  acknowledged: boolean('acknowledged').notNull().default(false),
  acknowledgedBy: uuid('acknowledged_by').references(() => users.id),
  acknowledgedAt: timestamp('acknowledged_at'),
  alertId: uuid('alert_id').references(() => alerts.id),
  linkedDeviceId: uuid('linked_device_id').references(() => devices.id),
  notes: text('notes'),
  createdAt: timestamp('created_at').defaultNow().notNull()
}, (table) => ({
  orgIdIdx: index('network_change_events_org_id_idx').on(table.orgId),
  siteIdIdx: index('network_change_events_site_id_idx').on(table.siteId),
  baselineIdIdx: index('network_change_events_baseline_id_idx').on(table.baselineId),
  profileIdIdx: index('network_change_events_profile_id_idx').on(table.profileId),
  detectedAtIdx: index('network_change_events_detected_at_idx').on(table.detectedAt),
  acknowledgedIdx: index('network_change_events_acknowledged_idx').on(table.acknowledged)
}));

export const networkTopology = pgTable('network_topology', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  siteId: uuid('site_id').notNull().references(() => sites.id),
  sourceType: varchar('source_type', { length: 50 }).notNull(),
  sourceId: uuid('source_id').notNull(),
  targetType: varchar('target_type', { length: 50 }).notNull(),
  targetId: uuid('target_id').notNull(),
  connectionType: varchar('connection_type', { length: 50 }).notNull(),
  interfaceName: varchar('interface_name', { length: 100 }),
  vlan: integer('vlan'),
  bandwidth: integer('bandwidth'),
  latency: real('latency'),
  lastVerifiedAt: timestamp('last_verified_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
});
