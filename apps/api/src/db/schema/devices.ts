import { pgTable, uuid, varchar, text, timestamp, boolean, jsonb, pgEnum, integer, real, bigint, date, primaryKey, index, unique, uniqueIndex } from 'drizzle-orm/pg-core';
import { organizations, sites } from './orgs';
import { users } from './users';
import type { BatteryStatus, DesktopAccessState, InterfaceBandwidth, TCCPermissions, VpnPresence } from '@breeze/shared';

export const osTypeEnum = pgEnum('os_type', ['windows', 'macos', 'linux']);
export const deviceStatusEnum = pgEnum('device_status', ['online', 'offline', 'maintenance', 'decommissioned', 'quarantined', 'updating', 'pending']);
export const deviceGroupTypeEnum = pgEnum('device_group_type', ['static', 'dynamic']);
export const membershipSourceEnum = pgEnum('membership_source', ['manual', 'dynamic_rule', 'policy']);
export const ipAssignmentTypeEnum = pgEnum('ip_assignment_type', ['dhcp', 'static', 'vpn', 'link-local', 'unknown']);
export const watchdogStatusEnum = pgEnum('watchdog_status', ['connected', 'failover', 'offline']);

export const devices = pgTable('devices', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  siteId: uuid('site_id').notNull().references(() => sites.id),
  agentId: varchar('agent_id', { length: 64 }).notNull().unique(),
  agentTokenHash: varchar('agent_token_hash', { length: 64 }),
  tokenIssuedAt: timestamp('token_issued_at', { withTimezone: true }),
  previousTokenHash: varchar('previous_token_hash', { length: 64 }),
  previousTokenExpiresAt: timestamp('previous_token_expires_at', { withTimezone: true }),
  watchdogTokenHash: varchar('watchdog_token_hash', { length: 64 }),
  watchdogTokenIssuedAt: timestamp('watchdog_token_issued_at', { withTimezone: true }),
  previousWatchdogTokenHash: varchar('previous_watchdog_token_hash', { length: 64 }),
  previousWatchdogTokenExpiresAt: timestamp('previous_watchdog_token_expires_at', { withTimezone: true }),
  helperTokenHash: varchar('helper_token_hash', { length: 64 }),
  helperTokenIssuedAt: timestamp('helper_token_issued_at', { withTimezone: true }),
  previousHelperTokenHash: varchar('previous_helper_token_hash', { length: 64 }),
  previousHelperTokenExpiresAt: timestamp('previous_helper_token_expires_at', { withTimezone: true }),
  // Issue #2621 — staged credentials for a two-phase rotation. These hashes are
  // accepted for auth while pending, but only become current once the agent
  // confirms it durably persisted the matching plaintext.
  pendingTokenHash: varchar('pending_token_hash', { length: 64 }),
  pendingWatchdogTokenHash: varchar('pending_watchdog_token_hash', { length: 64 }),
  pendingHelperTokenHash: varchar('pending_helper_token_hash', { length: 64 }),
  pendingTokenExpiresAt: timestamp('pending_token_expires_at', { withTimezone: true }),
  mtlsCertSerialNumber: varchar('mtls_cert_serial_number', { length: 128 }),
  mtlsCertExpiresAt: timestamp('mtls_cert_expires_at'),
  mtlsCertIssuedAt: timestamp('mtls_cert_issued_at'),
  mtlsCertCfId: varchar('mtls_cert_cf_id', { length: 128 }),
  quarantinedAt: timestamp('quarantined_at'),
  quarantinedReason: varchar('quarantined_reason', { length: 255 }),
  // Task 18: Auto-suspend agent tokens after repeated cross-tenant probe
  // attempts. Suspension is sticky (DB-backed) — reconnects with the same
  // token fail at the auth gate until an operator clears these columns.
  agentTokenSuspendedAt: timestamp('agent_token_suspended_at'),
  agentTokenSuspendedReason: varchar('agent_token_suspended_reason', { length: 100 }),
  // Task 19: Track the last source IP seen on an authenticated agent request.
  // A sudden change (legit agent → different IP) is a strong compromise signal.
  // We audit-log the transition (once per IP per device per 24h via Redis
  // dedup) and update this column fire-and-forget so the next request can
  // compare.
  lastSeenIp: varchar('last_seen_ip', { length: 45 }),
  // Public IP the agent enrolled from (point-in-time; lastSeenIp above tracks
  // the ongoing value). Feeds the abuse-signals sweep's IP-spread heuristics.
  enrollmentIp: varchar('enrollment_ip', { length: 45 }),
  hostname: varchar('hostname', { length: 255 }).notNull(),
  displayName: varchar('display_name', { length: 255 }),
  osType: osTypeEnum('os_type').notNull(),
  deviceRole: varchar('device_role', { length: 30 }).notNull().default('unknown'),
  deviceRoleSource: varchar('device_role_source', { length: 20 }).notNull().default('auto'),
  // Orthogonal virtualization attribute (issue #1387): is this box running on a
  // hypervisor, and which one. Set by the agent from SMBIOS hardware identity
  // strings. Distinct from device_role — a virtual workstation is still a
  // workstation and keeps matching role-based policies; virtualization is a
  // second policy-targeting axis. virtualization_platform is one of
  // VIRTUALIZATION_PLATFORMS (vmware/hyperv/virtualbox/qemu/kvm/xen/bochs/
  // parallels), or null when physical or undetermined.
  isVirtual: boolean('is_virtual').notNull().default(false),
  virtualizationPlatform: varchar('virtualization_platform', { length: 30 }),
  osVersion: varchar('os_version', { length: 100 }).notNull(),
  osBuild: varchar('os_build', { length: 100 }),
  architecture: varchar('architecture', { length: 20 }).notNull(),
  agentVersion: varchar('agent_version', { length: 50 }).notNull(),
  status: deviceStatusEnum('status').notNull().default('offline'),
  lastSeenAt: timestamp('last_seen_at'),
  enrolledAt: timestamp('enrolled_at').defaultNow().notNull(),
  enrolledBy: uuid('enrolled_by').references(() => users.id),
  // Linked device profiles for multi-boot systems (#2138). NULL => unlinked.
  // When set, the device is one boot profile of a physical machine grouped in
  // `device_link_groups`. A composite FK (link_group_id, org_id) ->
  // device_link_groups(id, org_id) — declared in the migration, not here,
  // matching the users(org_id, partner_id) composite-FK convention — pins every
  // member of a group to the group's org (same-org invariant).
  linkGroupId: uuid('link_group_id'),
  // Member role within an ASYMMETRIC link group (#2308). NULL for unlinked
  // devices and for members of symmetric kinds (multiboot — all peers). For a
  // kind='vm_host' group exactly one member is 'host' (the hypervisor/server
  // record) and the rest are 'guest' (its VMs). Values are app-enforced
  // ('host' | 'guest'), matching kind's varchar-without-CHECK convention.
  // Invariant: link_group_id IS NULL => link_group_role IS NULL (every unlink
  // path clears both together).
  linkGroupRole: varchar('link_group_role', { length: 16 }),
  tags: text('tags').array().default([]),
  customFields: jsonb('custom_fields').default({}),
  managementPosture: jsonb('management_posture'),
  tccPermissions: jsonb('tcc_permissions').$type<TCCPermissions | null>(),
  desktopAccess: jsonb('desktop_access').$type<DesktopAccessState | null>(),
  lastUser: varchar('last_user', { length: 255 }),
  uptimeSeconds: integer('uptime_seconds'),
  isHeadless: boolean('is_headless').notNull().default(false),
  // OS-level pending-reboot flag from the agent heartbeat (Windows registry
  // checks; Linux reboot-required markers / needs-restarting). Self-clears
  // on the first post-reboot heartbeat. Backs the system.rebootRequired
  // filter and the "Reboot pending" UI badge.
  pendingReboot: boolean('pending_reboot').notNull().default(false),
  // Current-state power/battery snapshot from the agent heartbeat (#2142).
  // Latest value only — dynamic per-heartbeat state, stored next to uptime /
  // pendingReboot rather than in the device_metrics time-series. null when the
  // agent has never reported (old agent); { present: false } for a real
  // no-battery desktop. Backs the optional "Power" list column and the
  // device-detail Power section.
  batteryStatus: jsonb('battery_status').$type<BatteryStatus | null>(),
  // Active-VPN-client presence snapshot from the agent's periodic network
  // inventory (#2139). Latest value only — fully replaced each network report,
  // stored next to batteryStatus rather than in a time-series/child table.
  // null when the agent has never reported (old agent); [] when reported with
  // no active VPN. Backs the optional "VPN" list column and the device-detail
  // VPN section. Read-only telemetry — no secrets/peers/keys.
  activeVpns: jsonb('active_vpns').$type<VpnPresence[] | null>(),
  watchdogStatus: watchdogStatusEnum('watchdog_status'),
  watchdogLastSeen: timestamp('watchdog_last_seen'),
  watchdogVersion: varchar('watchdog_version', { length: 50 }),
  // #2288 — the control-plane URL the agent last heartbeated to. Reported by
  // the agent; shows fleet position during a server URL migration.
  agentServerUrl: varchar('agent_server_url', { length: 512 }),
  // Asymmetry detector (#800): set when the watchdog is still reporting
  // in but the main agent has gone silent past the offline threshold.
  // Cleared when the main agent next heartbeats. Distinct from
  // status='offline' which only reflects main-agent silence — operators
  // need to know "box alive, only the BreezeAgent service is wedged" so
  // their support workflow is "remote restart" not "physical visit."
  mainAgentSilentSince: timestamp('main_agent_silent_since'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  partnerExportUpdatedAt: timestamp('partner_export_updated_at', { precision: 3 }).defaultNow().notNull()
}, (table) => ({
  idOrgUnique: uniqueIndex('devices_id_org_id_uniq').on(table.id, table.orgId),
}));

// Linked device profiles for multi-boot systems (#2138). One row per physical
// machine whose OS boot profiles are surfaced as separate device records. This
// is a NON-destructive UI/monitoring overlay — the linked device rows keep all
// of their own inventory/software/scripts/history/audit. Shape 1 (direct
// org_id): auto-discovered by the rls-coverage contract test. Membership lives
// on `devices.link_group_id` (one group per device), not a child table.
export const deviceLinkGroups = pgTable('device_link_groups', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  // What the link MEANS. 'multiboot' (v1, #2138): members are peer boot
  // profiles of one physical machine. 'vm_host' (#2308): asymmetric — one
  // member is the host server (devices.link_group_role = 'host') and the rest
  // are its guest VMs ('guest'), nested under the host in the device list.
  kind: varchar('kind', { length: 32 }).notNull().default('multiboot'),
  name: varchar('name', { length: 255 }),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (table) => ({
  orgIdIdx: index('device_link_groups_org_id_idx').on(table.orgId),
  // UNIQUE INDEX (not a constraint) to match the migration's
  // `CREATE UNIQUE INDEX` and satisfy db:check-drift — same convention as the
  // pax8/ticketMailbox composite-(id, axis) FK targets. Backs the composite FK
  // devices(link_group_id, org_id) -> device_link_groups(id, org_id).
  idOrgUnique: uniqueIndex('device_link_groups_id_org_id_uniq').on(table.id, table.orgId),
}));

export const deviceHardware = pgTable('device_hardware', {
  deviceId: uuid('device_id').primaryKey().references(() => devices.id),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  cpuModel: varchar('cpu_model', { length: 255 }),
  cpuCores: integer('cpu_cores'),
  cpuThreads: integer('cpu_threads'),
  ramTotalMb: integer('ram_total_mb'),
  diskTotalGb: integer('disk_total_gb'),
  gpuModel: varchar('gpu_model', { length: 255 }),
  serialNumber: varchar('serial_number', { length: 100 }),
  manufacturer: varchar('manufacturer', { length: 255 }),
  model: varchar('model', { length: 255 }),
  motherboardManufacturer: varchar('motherboard_manufacturer', { length: 255 }),
  motherboardProduct: varchar('motherboard_product', { length: 255 }),
  motherboardVersion: varchar('motherboard_version', { length: 255 }),
  biosVersion: varchar('bios_version', { length: 100 }),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  partnerExportUpdatedAt: timestamp('partner_export_updated_at', { precision: 3 }).defaultNow().notNull()
});

// Resource-specific material fingerprints for reconstruction exports. Deferred
// database triggers refresh these only when the final durable child state has
// actually changed, so periodic delete/reinsert inventory collection and
// heartbeat fields do not create false incremental changes.
export const partnerExportDeviceMaterialState = pgTable('partner_export_device_material_state', {
  deviceId: uuid('device_id').primaryKey().references(() => devices.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  inventoryUpdatedAt: timestamp('inventory_updated_at', { precision: 3 }).defaultNow().notNull(),
  softwareUpdatedAt: timestamp('software_updated_at', { precision: 3 }).defaultNow().notNull(),
  relationshipsUpdatedAt: timestamp('relationships_updated_at', { precision: 3 }).defaultNow().notNull(),
}, (table) => ({
  orgIdIdx: index('partner_export_device_material_state_org_id_idx').on(table.orgId),
  orgDeviceUnique: uniqueIndex('partner_export_device_material_state_org_device_uniq').on(table.orgId, table.deviceId),
}));

export const partnerExportSiteMaterialState = pgTable('partner_export_site_material_state', {
  siteId: uuid('site_id').primaryKey().references(() => sites.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  inventoryUpdatedAt: timestamp('inventory_updated_at', { precision: 3 }).defaultNow().notNull(),
  relationshipsUpdatedAt: timestamp('relationships_updated_at', { precision: 3 }).defaultNow().notNull(),
}, (table) => ({
  orgIdIdx: index('partner_export_site_material_state_org_id_idx').on(table.orgId),
  orgSiteUnique: uniqueIndex('partner_export_site_material_state_org_site_uniq').on(table.orgId, table.siteId),
}));

export const deviceNetwork = pgTable('device_network', {
  id: uuid('id').primaryKey().defaultRandom(),
  deviceId: uuid('device_id').notNull().references(() => devices.id),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  interfaceName: text('interface_name').notNull(),
  macAddress: varchar('mac_address', { length: 17 }),
  ipAddress: varchar('ip_address', { length: 45 }),
  ipType: varchar('ip_type', { length: 4 }).notNull().default('ipv4'),
  isPrimary: boolean('is_primary').notNull().default(false),
  publicIp: varchar('public_ip', { length: 45 }),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
});

export const deviceIpHistory = pgTable('device_ip_history', {
  id: uuid('id').primaryKey().defaultRandom(),
  deviceId: uuid('device_id').notNull().references(() => devices.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  interfaceName: text('interface_name').notNull(),
  ipAddress: varchar('ip_address', { length: 45 }).notNull(),
  ipType: varchar('ip_type', { length: 4 }).notNull().default('ipv4'),
  assignmentType: ipAssignmentTypeEnum('assignment_type').notNull().default('unknown'),
  macAddress: varchar('mac_address', { length: 17 }),
  subnetMask: varchar('subnet_mask', { length: 45 }),
  gateway: varchar('gateway', { length: 45 }),
  dnsServers: text('dns_servers').array(),
  firstSeen: timestamp('first_seen').notNull().defaultNow(),
  lastSeen: timestamp('last_seen').notNull().defaultNow(),
  isActive: boolean('is_active').notNull().default(true),
  deactivatedAt: timestamp('deactivated_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (table) => ({
  deviceIdIdx: index('device_ip_history_device_id_idx').on(table.deviceId),
  orgIdIdx: index('device_ip_history_org_id_idx').on(table.orgId),
  ipAddressIdx: index('device_ip_history_ip_address_idx').on(table.ipAddress),
  firstSeenIdx: index('device_ip_history_first_seen_idx').on(table.firstSeen),
  lastSeenIdx: index('device_ip_history_last_seen_idx').on(table.lastSeen),
  isActiveIdx: index('device_ip_history_is_active_idx').on(table.isActive),
  ipAddressTimeIdx: index('device_ip_history_ip_time_idx').on(table.ipAddress, table.firstSeen, table.lastSeen),
}));

export const deviceDisks = pgTable('device_disks', {
  id: uuid('id').primaryKey().defaultRandom(),
  deviceId: uuid('device_id').notNull().references(() => devices.id),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
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
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  timestamp: timestamp('timestamp').notNull(),
  cpuPercent: real('cpu_percent').notNull(),
  ramPercent: real('ram_percent').notNull(),
  ramUsedMb: integer('ram_used_mb').notNull(),
  diskPercent: real('disk_percent').notNull(),
  diskUsedGb: real('disk_used_gb').notNull(),
  diskActivityAvailable: boolean('disk_activity_available'),
  diskReadBytes: bigint('disk_read_bytes', { mode: 'bigint' }),
  diskWriteBytes: bigint('disk_write_bytes', { mode: 'bigint' }),
  diskReadBps: bigint('disk_read_bps', { mode: 'bigint' }),
  diskWriteBps: bigint('disk_write_bps', { mode: 'bigint' }),
  diskReadOps: bigint('disk_read_ops', { mode: 'bigint' }),
  diskWriteOps: bigint('disk_write_ops', { mode: 'bigint' }),
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

export type TopProcess = {
  name: string;
  pid: number;
  cpu: number;
  ramMb: number;
  diskBps?: number;
  netBps?: number;
};

export const deviceProcessSamples = pgTable('device_process_samples', {
  deviceId: uuid('device_id').notNull().references(() => devices.id),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  timestamp: timestamp('timestamp', { withTimezone: true }).notNull(),
  agentTimestamp: timestamp('agent_timestamp', { withTimezone: true }),
  topProcesses: jsonb('top_processes').$type<TopProcess[]>().notNull()
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
  orgId: uuid('org_id').notNull().references(() => organizations.id),
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
  orgId: uuid('org_id').notNull().references(() => organizations.id),
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
  orgId: uuid('org_id').notNull().references(() => organizations.id),
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
  orgId: uuid('org_id').notNull().references(() => organizations.id),
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
  targetRole: varchar('target_role', { length: 20 }).notNull().default('agent'),
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
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  protocol: connectionProtocolEnum('protocol').notNull(),
  localAddr: text('local_addr').notNull(),
  localPort: integer('local_port').notNull(),
  remoteAddr: text('remote_addr'),
  remotePort: integer('remote_port'),
  state: varchar('state', { length: 20 }),
  pid: integer('pid'),
  processName: varchar('process_name', { length: 255 }),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (table) => ({
  devicePortStateIdx: index('device_connections_device_port_state_idx').on(
    table.deviceId,
    table.localPort,
    table.state
  ),
  deviceUpdatedIdx: index('device_connections_device_updated_idx').on(table.deviceId, table.updatedAt)
}));

// Boot performance metrics - stores boot time history and startup item analysis per device
export interface BootStartupItem {
  itemId?: string;
  name: string;
  type: 'service' | 'run_key' | 'startup_folder' | 'login_item' | 'launch_agent' | 'launch_daemon' | 'systemd' | 'cron' | 'init_d';
  path: string;
  enabled: boolean;
  cpuTimeMs: number;
  diskIoBytes: number;
  impactScore: number;
}

export const deviceBootMetrics = pgTable('device_boot_metrics', {
  id: uuid('id').primaryKey().defaultRandom(),
  deviceId: uuid('device_id').notNull().references(() => devices.id),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  bootTimestamp: timestamp('boot_timestamp').notNull(),
  biosSeconds: real('bios_seconds'),
  osLoaderSeconds: real('os_loader_seconds'),
  desktopReadySeconds: real('desktop_ready_seconds'),
  totalBootSeconds: real('total_boot_seconds').notNull(),
  startupItemCount: integer('startup_item_count').notNull(),
  startupItems: jsonb('startup_items').notNull().$type<BootStartupItem[]>(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  deviceBootIdx: index('device_boot_metrics_device_boot_idx').on(table.deviceId, table.bootTimestamp),
  deviceCreatedIdx: index('device_boot_metrics_device_created_idx').on(table.deviceId, table.createdAt),
  orgDeviceIdx: index('device_boot_metrics_org_device_idx').on(table.orgId, table.deviceId),
  deviceBootUnique: unique('device_boot_metrics_device_boot_uniq').on(table.deviceId, table.bootTimestamp),
}));
