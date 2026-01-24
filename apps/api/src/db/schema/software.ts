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
  index
} from 'drizzle-orm/pg-core';
import { organizations } from './orgs';
import { devices } from './devices';
import { users } from './users';
import { maintenanceWindows } from './maintenance';
import { deploymentStatusEnum } from './deployments';

export const softwareCatalog = pgTable('software_catalog', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 200 }).notNull(),
  vendor: varchar('vendor', { length: 200 }),
  description: text('description'),
  category: varchar('category', { length: 100 }),
  iconUrl: text('icon_url'),
  websiteUrl: text('website_url'),
  isManaged: boolean('is_managed').notNull().default(false),
  createdAt: timestamp('created_at').defaultNow().notNull()
}, (table) => ({
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
  checksum: varchar('checksum', { length: 128 }),
  fileSize: bigint('file_size', { mode: 'bigint' }),
  supportedOs: jsonb('supported_os'),
  architecture: varchar('architecture', { length: 20 }),
  silentInstallArgs: text('silent_install_args'),
  silentUninstallArgs: text('silent_uninstall_args'),
  preInstallScript: text('pre_install_script'),
  postInstallScript: text('post_install_script'),
  isLatest: boolean('is_latest').notNull().default(false)
}, (table) => ({
  catalogIdx: index('software_versions_catalog_id_idx').on(table.catalogId),
  catalogVersionIdx: index('software_versions_catalog_version_idx').on(table.catalogId, table.version),
  latestIdx: index('software_versions_latest_idx').on(table.catalogId, table.isLatest)
}));

export const softwareDeployments = pgTable('software_deployments', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  name: varchar('name', { length: 255 }).notNull(),
  softwareVersionId: uuid('software_version_id').notNull().references(() => softwareVersions.id),
  deploymentType: varchar('deployment_type', { length: 20 }).notNull(),
  targetType: varchar('target_type', { length: 50 }).notNull(),
  targetIds: jsonb('target_ids'),
  scheduleType: varchar('schedule_type', { length: 30 }).notNull(),
  scheduledAt: timestamp('scheduled_at'),
  maintenanceWindowId: uuid('maintenance_window_id').references(() => maintenanceWindows.id),
  options: jsonb('options'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull()
}, (table) => ({
  orgIdx: index('software_deployments_org_id_idx').on(table.orgId),
  versionIdx: index('software_deployments_version_id_idx').on(table.softwareVersionId),
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
  retryCount: integer('retry_count').notNull().default(0)
}, (table) => ({
  deploymentIdx: index('deployment_results_deployment_id_idx').on(table.deploymentId),
  deviceIdx: index('deployment_results_device_id_idx').on(table.deviceId),
  statusIdx: index('deployment_results_status_idx').on(table.status)
}));

export const softwareInventory = pgTable('software_inventory', {
  id: uuid('id').primaryKey().defaultRandom(),
  deviceId: uuid('device_id').notNull().references(() => devices.id),
  catalogId: uuid('catalog_id').references(() => softwareCatalog.id),
  name: varchar('name', { length: 500 }).notNull(),
  version: varchar('version', { length: 100 }),
  vendor: varchar('vendor', { length: 200 }),
  installDate: date('install_date'),
  installLocation: text('install_location'),
  uninstallString: text('uninstall_string'),
  isManaged: boolean('is_managed').notNull().default(false),
  lastSeen: timestamp('last_seen')
}, (table) => ({
  deviceIdx: index('software_inventory_device_id_idx').on(table.deviceId),
  catalogIdx: index('software_inventory_catalog_id_idx').on(table.catalogId),
  nameIdx: index('software_inventory_name_idx').on(table.name)
}));
