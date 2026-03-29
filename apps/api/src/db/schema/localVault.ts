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
} from 'drizzle-orm/pg-core';
import { organizations } from './orgs';
import { devices } from './devices';

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
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    orgIdx: index('local_vaults_org_idx').on(table.orgId),
    deviceIdx: index('local_vaults_device_idx').on(table.deviceId),
  })
);
