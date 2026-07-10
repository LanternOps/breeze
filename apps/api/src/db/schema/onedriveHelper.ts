import {
  pgTable,
  uuid,
  boolean,
  varchar,
  jsonb,
  timestamp,
  integer,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { organizations } from './orgs';
import { configPolicyFeatureLinks } from './configurationPolicies';
import { devices } from './devices';

export const configPolicyOnedriveSettings = pgTable('config_policy_onedrive_settings', {
  id: uuid('id').primaryKey().defaultRandom(),
  featureLinkId: uuid('feature_link_id').notNull()
    .references(() => configPolicyFeatureLinks.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  silentAccountConfig: boolean('silent_account_config').notNull().default(true),
  filesOnDemand: boolean('files_on_demand').notNull().default(true),
  kfmSilentOptIn: boolean('kfm_silent_opt_in').notNull().default(false),
  kfmFolders: jsonb('kfm_folders').notNull().default(['Desktop', 'Documents', 'Pictures']),
  kfmBlockOptOut: boolean('kfm_block_opt_out').notNull().default(false),
  tenantAssociationId: varchar('tenant_association_id', { length: 64 }),
  restartOnChange: boolean('restart_on_change').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  featureLinkUniq: uniqueIndex('onedrive_settings_feature_link_uniq').on(t.featureLinkId),
  orgIdx: index('onedrive_settings_org_idx').on(t.orgId),
}));

export const configPolicyOnedriveLibraries = pgTable('config_policy_onedrive_libraries', {
  id: uuid('id').primaryKey().defaultRandom(),
  settingsId: uuid('settings_id').notNull()
    .references(() => configPolicyOnedriveSettings.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  libraryId: varchar('library_id', { length: 1024 }).notNull(),
  displayName: varchar('display_name', { length: 255 }).notNull(),
  siteUrl: varchar('site_url', { length: 1024 }),
  siteId: varchar('site_id', { length: 512 }),
  webId: varchar('web_id', { length: 128 }),
  listId: varchar('list_id', { length: 128 }),
  targetingMode: varchar('targeting_mode', { length: 20 }).notNull().default('everyone'),
  groupId: varchar('group_id', { length: 128 }),
  groupName: varchar('group_name', { length: 255 }),
  hiveScope: varchar('hive_scope', { length: 8 }).notNull().default('hkcu'),
  sortOrder: integer('sort_order').notNull().default(0),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => ({
  settingsIdx: index('onedrive_libraries_settings_idx').on(t.settingsId),
  orgIdx: index('onedrive_libraries_org_idx').on(t.orgId),
}));

export const onedriveDeviceState = pgTable('onedrive_device_state', {
  deviceId: uuid('device_id').primaryKey().references(() => devices.id),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  signedIn: boolean('signed_in').notNull().default(false),
  oneDriveVersion: varchar('onedrive_version', { length: 64 }),
  filesOnDemandOn: boolean('files_on_demand_on').notNull().default(false),
  kfmFolderStates: jsonb('kfm_folder_states').notNull().default({}),
  mountedLibraries: jsonb('mounted_libraries').notNull().default([]),
  entitledLibraries: jsonb('entitled_libraries').notNull().default([]),
  signedInUpns: jsonb('signed_in_upns').notNull().default([]),
  driftEntries: jsonb('drift_entries').notNull().default([]),
  lastReportedAt: timestamp('last_reported_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  orgIdx: index('onedrive_device_state_org_idx').on(t.orgId),
}));
