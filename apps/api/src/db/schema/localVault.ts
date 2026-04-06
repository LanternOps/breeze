import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  boolean,
  integer,
  bigint,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { organizations } from './orgs';
import { devices } from './devices';
import { backupSnapshots } from './backup';

export const localVaults = pgTable(
  'local_vaults',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id),
    vaultPath: text('vault_path').notNull(),
    vaultType: varchar('vault_type', { length: 20 }).notNull().default('local'),
    isActive: boolean('is_active').notNull().default(true),
    retentionCount: integer('retention_count').notNull().default(3),
    lastSyncAt: timestamp('last_sync_at'),
    lastSyncStatus: varchar('last_sync_status', { length: 30 }),
    lastSyncSnapshotId: varchar('last_sync_snapshot_id', { length: 200 }),
    syncSizeBytes: bigint('sync_size_bytes', { mode: 'number' }),
    lastSyncError: text('last_sync_error'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    orgIdx: index('local_vaults_org_idx').on(table.orgId),
    deviceIdx: index('local_vaults_device_idx').on(table.deviceId),
  })
);

export const vaultSnapshotInventory = pgTable(
  'vault_snapshot_inventory',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    vaultId: uuid('vault_id')
      .notNull()
      .references(() => localVaults.id, { onDelete: 'cascade' }),
    snapshotDbId: uuid('snapshot_db_id')
      .notNull()
      .references(() => backupSnapshots.id, { onDelete: 'cascade' }),
    externalSnapshotId: varchar('external_snapshot_id', { length: 200 }).notNull(),
    syncedAt: timestamp('synced_at').defaultNow().notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    fileCount: integer('file_count'),
    manifestVerified: boolean('manifest_verified').notNull().default(false),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    orgIdx: index('vault_snapshot_inventory_org_idx').on(table.orgId),
    vaultIdx: index('vault_snapshot_inventory_vault_idx').on(table.vaultId),
    snapshotIdx: index('vault_snapshot_inventory_snapshot_idx').on(table.snapshotDbId),
    externalSnapshotIdx: index('vault_snapshot_inventory_external_snapshot_idx').on(table.externalSnapshotId),
    vaultSnapshotUniqueIdx: uniqueIndex('vault_snapshot_inventory_vault_snapshot_uniq').on(
      table.vaultId,
      table.snapshotDbId
    ),
  })
);
