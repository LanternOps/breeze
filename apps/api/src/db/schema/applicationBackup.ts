import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  boolean,
  jsonb,
  integer,
  index,
  unique,
} from 'drizzle-orm/pg-core';
import { organizations } from './orgs';
import { devices } from './devices';
import { backupConfigs, backupSnapshots } from './backup';

// sql_instances: discovered SQL Server instances per device
export const sqlInstances = pgTable(
  'sql_instances',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id),
    instanceName: varchar('instance_name', { length: 256 }).notNull(),
    version: varchar('version', { length: 50 }),
    edition: varchar('edition', { length: 100 }),
    port: integer('port'),
    authType: varchar('auth_type', { length: 20 }).notNull().default('windows'),
    databases: jsonb('databases').default([]),
    status: varchar('status', { length: 20 }).notNull().default('unknown'),
    lastDiscoveredAt: timestamp('last_discovered_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    orgDeviceIdx: index('sql_instances_org_device_idx').on(
      table.orgId,
      table.deviceId
    ),
    deviceInstanceUniq: unique('sql_instances_device_instance_uniq').on(
      table.deviceId,
      table.instanceName
    ),
  })
);

// backup_chains: tracks LSN chain continuity for differential / log chains
export const backupChains = pgTable(
  'backup_chains',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id),
    configId: uuid('config_id')
      .notNull()
      .references(() => backupConfigs.id),
    chainType: varchar('chain_type', { length: 20 }).notNull(),
    targetName: varchar('target_name', { length: 256 }).notNull(),
    targetId: varchar('target_id', { length: 256 }),
    isActive: boolean('is_active').notNull().default(true),
    fullSnapshotId: uuid('full_snapshot_id').references(
      () => backupSnapshots.id
    ),
    chainMetadata: jsonb('chain_metadata').notNull().default({}),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    orgConfigIdx: index('backup_chains_org_config_idx').on(
      table.orgId,
      table.configId
    ),
    targetIdx: index('backup_chains_target_idx').on(
      table.deviceId,
      table.targetName
    ),
  })
);
