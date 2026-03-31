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
  index,
} from 'drizzle-orm/pg-core';
import { organizations } from './orgs';
import { backupConfigs } from './backup';

// ── C2C Connections ─────────────────────────────────────────────────────────

export const c2cConnections = pgTable(
  'c2c_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    provider: varchar('provider', { length: 30 }).notNull(),
    displayName: varchar('display_name', { length: 200 }).notNull(),
    authMethod: varchar('auth_method', { length: 20 }).notNull().default('manual'),
    tenantId: varchar('tenant_id', { length: 100 }),
    clientId: varchar('client_id', { length: 200 }),
    clientSecret: text('client_secret'),
    refreshToken: text('refresh_token'),
    accessToken: text('access_token'),
    tokenExpiresAt: timestamp('token_expires_at'),
    scopes: text('scopes'),
    status: varchar('status', { length: 20 }).notNull().default('active'),
    lastSyncAt: timestamp('last_sync_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    orgIdx: index('c2c_connections_org_idx').on(table.orgId),
    statusIdx: index('c2c_connections_status_idx').on(table.orgId, table.status),
  })
);

// ── C2C Backup Configs ──────────────────────────────────────────────────────

export const c2cBackupConfigs = pgTable(
  'c2c_backup_configs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => c2cConnections.id),
    name: varchar('name', { length: 200 }).notNull(),
    backupScope: varchar('backup_scope', { length: 30 }).notNull(),
    targetUsers: jsonb('target_users').default([]),
    storageConfigId: uuid('storage_config_id').references(() => backupConfigs.id),
    schedule: jsonb('schedule'),
    retention: jsonb('retention'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    orgIdx: index('c2c_configs_org_idx').on(table.orgId),
    connectionIdx: index('c2c_configs_connection_idx').on(table.connectionId),
  })
);

// ── C2C Backup Jobs ─────────────────────────────────────────────────────────

export const c2cBackupJobs = pgTable(
  'c2c_backup_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    configId: uuid('config_id')
      .notNull()
      .references(() => c2cBackupConfigs.id),
    status: varchar('status', { length: 20 }).notNull().default('pending'),
    startedAt: timestamp('started_at'),
    completedAt: timestamp('completed_at'),
    itemsProcessed: integer('items_processed').default(0),
    itemsNew: integer('items_new').default(0),
    itemsUpdated: integer('items_updated').default(0),
    itemsDeleted: integer('items_deleted').default(0),
    bytesTransferred: bigint('bytes_transferred', { mode: 'number' }).default(0),
    deltaToken: text('delta_token'),
    errorLog: text('error_log'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    orgIdx: index('c2c_jobs_org_idx').on(table.orgId),
    configIdx: index('c2c_jobs_config_idx').on(table.configId),
    statusIdx: index('c2c_jobs_status_idx').on(table.status),
  })
);

// ── C2C Consent Sessions (OAuth admin consent state) ───────────────────────

export const c2cConsentSessions = pgTable('c2c_consent_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id')
    .notNull()
    .references(() => organizations.id),
  state: varchar('state', { length: 64 }).notNull().unique(),
  provider: varchar('provider', { length: 30 }).notNull().default('microsoft_365'),
  displayName: varchar('display_name', { length: 200 }),
  scopes: text('scopes'),
  redirectUrl: varchar('redirect_url', { length: 500 }),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// ── C2C Backup Items ────────────────────────────────────────────────────────

export const c2cBackupItems = pgTable(
  'c2c_backup_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    configId: uuid('config_id')
      .notNull()
      .references(() => c2cBackupConfigs.id),
    jobId: uuid('job_id').references(() => c2cBackupJobs.id),
    itemType: varchar('item_type', { length: 30 }).notNull(),
    externalId: varchar('external_id', { length: 500 }).notNull(),
    userEmail: varchar('user_email', { length: 320 }),
    subjectOrName: text('subject_or_name'),
    parentPath: text('parent_path'),
    storagePath: text('storage_path'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    itemDate: timestamp('item_date'),
    isDeleted: boolean('is_deleted').default(false),
    deletedAt: timestamp('deleted_at'),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    orgConfigIdx: index('c2c_items_org_config_idx').on(table.orgId, table.configId),
    userIdx: index('c2c_items_user_idx').on(table.orgId, table.userEmail),
    externalIdx: index('c2c_items_external_idx').on(table.externalId),
    typeDateIdx: index('c2c_items_type_date_idx').on(table.itemType, table.itemDate),
  })
);
