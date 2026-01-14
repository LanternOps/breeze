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
  uniqueIndex
} from 'drizzle-orm/pg-core';
import { organizations, sites } from './orgs';
import { users } from './users';
import { devices } from './devices';

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

export const discoveredAssetStatusEnum = pgEnum('discovered_asset_status', [
  'new',
  'identified',
  'managed',
  'ignored',
  'offline'
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
  status: discoveredAssetStatusEnum('status').notNull().default('new'),
  manufacturer: varchar('manufacturer', { length: 255 }),
  model: varchar('model', { length: 255 }),
  openPorts: jsonb('open_ports'),
  osFingerprint: jsonb('os_fingerprint'),
  snmpData: jsonb('snmp_data'),
  linkedDeviceId: uuid('linked_device_id').references(() => devices.id),
  firstSeenAt: timestamp('first_seen_at').defaultNow().notNull(),
  lastSeenAt: timestamp('last_seen_at'),
  lastJobId: uuid('last_job_id').references(() => discoveryJobs.id),
  discoveryMethods: discoveryMethodEnum('discovery_methods').array().default([]),
  notes: text('notes'),
  tags: text('tags').array().default([]),
  ignoredBy: uuid('ignored_by').references(() => users.id),
  ignoredAt: timestamp('ignored_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (table) => ({
  orgIpUnique: uniqueIndex('discovered_assets_org_ip_unique').on(table.orgId, table.ipAddress)
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
