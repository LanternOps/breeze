import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar
} from 'drizzle-orm/pg-core';
import { organizations } from './orgs';
import { discoveredAssets } from './discovery';

export const networkConfigTypeEnum = pgEnum('network_config_type', ['running', 'startup']);

export const networkConfigRiskLevelEnum = pgEnum('network_config_risk_level', [
  'low',
  'medium',
  'high',
  'critical'
]);

export const networkDeviceConfigs = pgTable('network_device_configs', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  assetId: uuid('asset_id').notNull().references(() => discoveredAssets.id, { onDelete: 'cascade' }),
  configType: networkConfigTypeEnum('config_type').notNull(),
  configEncrypted: text('config_encrypted').notNull(),
  hash: varchar('hash', { length: 128 }).notNull(),
  changedFromPrevious: boolean('changed_from_previous').notNull().default(false),
  capturedAt: timestamp('captured_at').notNull(),
  metadata: jsonb('metadata')
}, (table) => ({
  orgAssetCapturedIdx: index('net_cfg_org_asset_captured_idx').on(table.orgId, table.assetId, table.capturedAt),
  orgAssetTypeCapturedIdx: index('net_cfg_org_asset_type_captured_idx').on(table.orgId, table.assetId, table.configType, table.capturedAt)
}));

export const networkDeviceFirmware = pgTable('network_device_firmware', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  assetId: uuid('asset_id').notNull().references(() => discoveredAssets.id, { onDelete: 'cascade' }),
  currentVersion: varchar('current_version', { length: 80 }),
  latestVersion: varchar('latest_version', { length: 80 }),
  eolDate: timestamp('eol_date'),
  cveCount: integer('cve_count').notNull().default(0),
  lastCheckedAt: timestamp('last_checked_at'),
  metadata: jsonb('metadata')
}, (table) => ({
  orgAssetIdx: uniqueIndex('net_fw_org_asset_idx').on(table.orgId, table.assetId),
  orgLastCheckedIdx: index('net_fw_org_last_checked_idx').on(table.orgId, table.lastCheckedAt)
}));

export const networkConfigDiffs = pgTable('network_config_diffs', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  assetId: uuid('asset_id').notNull().references(() => discoveredAssets.id, { onDelete: 'cascade' }),
  previousConfigId: uuid('previous_config_id').notNull().references(() => networkDeviceConfigs.id, { onDelete: 'cascade' }),
  currentConfigId: uuid('current_config_id').notNull().references(() => networkDeviceConfigs.id, { onDelete: 'cascade' }),
  summary: text('summary'),
  diff: text('diff').notNull(),
  riskLevel: networkConfigRiskLevelEnum('risk_level').notNull().default('low'),
  createdAt: timestamp('created_at').defaultNow().notNull()
}, (table) => ({
  orgAssetCreatedIdx: index('net_cfg_diff_org_asset_created_idx').on(table.orgId, table.assetId, table.createdAt),
  currentConfigIdx: uniqueIndex('net_cfg_diff_current_cfg_idx').on(table.currentConfigId)
}));
