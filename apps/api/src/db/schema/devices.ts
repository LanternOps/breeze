import { pgTable, uuid, varchar, text, timestamp, boolean, jsonb, pgEnum, integer, real, bigint, date, primaryKey } from 'drizzle-orm/pg-core';
import { organizations, sites } from './orgs';
import { users } from './users';
import type { InterfaceBandwidth } from '@breeze/shared';

export const osTypeEnum = pgEnum('os_type', ['windows', 'macos', 'linux']);
export const deviceStatusEnum = pgEnum('device_status', ['online', 'offline', 'maintenance', 'decommissioned']);
export const deviceGroupTypeEnum = pgEnum('device_group_type', ['static', 'dynamic']);
export const membershipSourceEnum = pgEnum('membership_source', ['manual', 'dynamic_rule', 'policy']);

export const devices = pgTable('devices', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  siteId: uuid('site_id').notNull().references(() => sites.id),
  agentId: varchar('agent_id', { length: 64 }).notNull().unique(),
  agentTokenHash: varchar('agent_token_hash', { length: 64 }),
  hostname: varchar('hostname', { length: 255 }).notNull(),
  displayName: varchar('display_name', { length: 255 }),
  osType: osTypeEnum('os_type').notNull(),
  osVersion: varchar('os_version', { length: 100 }).notNull(),
  osBuild: varchar('os_build', { length: 100 }),
  architecture: varchar('architecture', { length: 20 }).notNull(),
  agentVersion: varchar('agent_version', { length: 20 }).notNull(),
  status: deviceStatusEnum('status').notNull().default('offline'),
  lastSeenAt: timestamp('last_seen_at'),
  enrolledAt: timestamp('enrolled_at').defaultNow().notNull(),
  enrolledBy: uuid('enrolled_by').references(() => users.id),
  tags: text('tags').array().default([]),
  customFields: jsonb('custom_fields').default({}),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
});

export const deviceHardware = pgTable('device_hardware', {
  deviceId: uuid('device_id').primaryKey().references(() => devices.id),
  cpuModel: varchar('cpu_model', { length: 255 }),
  cpuCores: integer('cpu_cores'),
  cpuThreads: integer('cpu_threads'),
  ramTotalMb: integer('ram_total_mb'),
  diskTotalGb: integer('disk_total_gb'),
  gpuModel: varchar('gpu_model', { length: 255 }),
  serialNumber: varchar('serial_number', { length: 100 }),
  manufacturer: varchar('manufacturer', { length: 255 }),
  model: varchar('model', { length: 255 }),
  biosVersion: varchar('bios_version', { length: 100 }),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
});

export const deviceNetwork = pgTable('device_network', {
  id: uuid('id').primaryKey().defaultRandom(),
  deviceId: uuid('device_id').notNull().references(() => devices.id),
  interfaceName: varchar('interface_name', { length: 100 }).notNull(),
  macAddress: varchar('mac_address', { length: 17 }),
  ipAddress: varchar('ip_address', { length: 45 }),
  ipType: varchar('ip_type', { length: 4 }).notNull().default('ipv4'),
  isPrimary: boolean('is_primary').notNull().default(false),
  publicIp: varchar('public_ip', { length: 45 }),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
});

export const deviceDisks = pgTable('device_disks', {
  id: uuid('id').primaryKey().defaultRandom(),
  deviceId: uuid('device_id').notNull().references(() => devices.id),
  mountPoint: varchar('mount_point', { length: 255 }).notNull(),
  device: varchar('device', { length: 255 }),
  fsType: varchar('fs_type', { length: 50 }),
  totalGb: real('total_gb').notNull(),
  usedGb: real('used_gb').notNull(),
  freeGb: real('free_gb').notNull(),
  usedPercent: real('used_percent').notNull(),
  health: varchar('health', { length: 50 }).default('healthy'),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
});

export const deviceMetrics = pgTable('device_metrics', {
  deviceId: uuid('device_id').notNull().references(() => devices.id),
  timestamp: timestamp('timestamp').notNull(),
  cpuPercent: real('cpu_percent').notNull(),
  ramPercent: real('ram_percent').notNull(),
  ramUsedMb: integer('ram_used_mb').notNull(),
  diskPercent: real('disk_percent').notNull(),
  diskUsedGb: real('disk_used_gb').notNull(),
  networkInBytes: bigint('network_in_bytes', { mode: 'bigint' }),
  networkOutBytes: bigint('network_out_bytes', { mode: 'bigint' }),
  bandwidthInBps: bigint('bandwidth_in_bps', { mode: 'bigint' }),
  bandwidthOutBps: bigint('bandwidth_out_bps', { mode: 'bigint' }),
  interfaceStats: jsonb('interface_stats').$type<InterfaceBandwidth[]>(),
  processCount: integer('process_count'),
  customMetrics: jsonb('custom_metrics')
}, (table) => ({
  pk: primaryKey({ columns: [table.deviceId, table.timestamp] })
}));

export const deviceSoftware = pgTable('device_software', {
  id: uuid('id').primaryKey().defaultRandom(),
  deviceId: uuid('device_id').notNull().references(() => devices.id),
  name: varchar('name', { length: 500 }).notNull(),
  version: varchar('version', { length: 100 }),
  publisher: varchar('publisher', { length: 255 }),
  installDate: date('install_date'),
  installLocation: text('install_location'),
  isSystem: boolean('is_system').notNull().default(false),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
});

export const deviceRegistryState = pgTable('device_registry_state', {
  deviceId: uuid('device_id').notNull().references(() => devices.id),
  registryPath: text('registry_path').notNull(),
  valueName: text('value_name').notNull(),
  valueData: text('value_data'),
  valueType: varchar('value_type', { length: 64 }),
  collectedAt: timestamp('collected_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (table) => ({
  pk: primaryKey({ columns: [table.deviceId, table.registryPath, table.valueName] })
}));

export const deviceConfigState = pgTable('device_config_state', {
  deviceId: uuid('device_id').notNull().references(() => devices.id),
  filePath: text('file_path').notNull(),
  configKey: text('config_key').notNull(),
  configValue: text('config_value'),
  collectedAt: timestamp('collected_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (table) => ({
  pk: primaryKey({ columns: [table.deviceId, table.filePath, table.configKey] })
}));

export const deviceGroups = pgTable('device_groups', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  siteId: uuid('site_id').references(() => sites.id),
  name: varchar('name', { length: 255 }).notNull(),
  type: deviceGroupTypeEnum('type').notNull().default('static'),
  rules: jsonb('rules'),
  filterConditions: jsonb('filter_conditions'),
  filterFieldsUsed: text('filter_fields_used').array().default([]),
  parentId: uuid('parent_id'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
});

export const deviceGroupMemberships = pgTable('device_group_memberships', {
  deviceId: uuid('device_id').notNull().references(() => devices.id),
  groupId: uuid('group_id').notNull().references(() => deviceGroups.id),
  isPinned: boolean('is_pinned').notNull().default(false),
  addedAt: timestamp('added_at').defaultNow().notNull(),
  addedBy: membershipSourceEnum('added_by').notNull().default('manual')
}, (table) => ({
  pk: primaryKey({ columns: [table.deviceId, table.groupId] })
}));

// Audit log for group membership changes
export const groupMembershipLogActionEnum = pgEnum('group_membership_log_action', ['added', 'removed']);
export const groupMembershipLogReasonEnum = pgEnum('group_membership_log_reason', [
  'manual',
  'filter_match',
  'filter_unmatch',
  'pinned',
  'unpinned'
]);

export const groupMembershipLog = pgTable('group_membership_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  groupId: uuid('group_id').notNull().references(() => deviceGroups.id),
  deviceId: uuid('device_id').notNull().references(() => devices.id),
  action: groupMembershipLogActionEnum('action').notNull(),
  reason: groupMembershipLogReasonEnum('reason').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull()
});

export const deviceCommands = pgTable('device_commands', {
  id: uuid('id').primaryKey().defaultRandom(),
  deviceId: uuid('device_id').notNull().references(() => devices.id),
  type: varchar('type', { length: 50 }).notNull(),
  payload: jsonb('payload'),
  status: varchar('status', { length: 20 }).notNull().default('pending'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  executedAt: timestamp('executed_at'),
  completedAt: timestamp('completed_at'),
  result: jsonb('result')
});

export const connectionProtocolEnum = pgEnum('connection_protocol', ['tcp', 'tcp6', 'udp', 'udp6']);

export const deviceConnections = pgTable('device_connections', {
  id: uuid('id').primaryKey().defaultRandom(),
  deviceId: uuid('device_id').notNull().references(() => devices.id),
  protocol: connectionProtocolEnum('protocol').notNull(),
  localAddr: varchar('local_addr', { length: 45 }).notNull(),
  localPort: integer('local_port').notNull(),
  remoteAddr: varchar('remote_addr', { length: 45 }),
  remotePort: integer('remote_port'),
  state: varchar('state', { length: 20 }),
  pid: integer('pid'),
  processName: varchar('process_name', { length: 255 }),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
});
