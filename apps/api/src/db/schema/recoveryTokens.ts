import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { organizations } from './orgs';
import { devices } from './devices';
import { users } from './users';
import { backupSnapshots } from './backup';

export const recoveryTokens = pgTable(
  'recovery_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id),
    snapshotId: uuid('snapshot_id')
      .notNull()
      .references(() => backupSnapshots.id),
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    restoreType: varchar('restore_type', { length: 30 }).notNull(),
    targetConfig: jsonb('target_config'),
    status: varchar('status', { length: 20 }).notNull().default('active'),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    expiresAt: timestamp('expires_at').notNull(),
    authenticatedAt: timestamp('authenticated_at'),
    completedAt: timestamp('completed_at'),
    usedAt: timestamp('used_at'),
  },
  (table) => ({
    orgIdx: index('recovery_tokens_org_idx').on(table.orgId),
    hashIdx: index('recovery_tokens_hash_idx').on(table.tokenHash),
    statusIdx: index('recovery_tokens_status_idx').on(table.status),
  })
);

export const recoveryMediaArtifacts = pgTable(
  'recovery_media_artifacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    tokenId: uuid('token_id')
      .notNull()
      .references(() => recoveryTokens.id, { onDelete: 'cascade' }),
    snapshotId: uuid('snapshot_id')
      .notNull()
      .references(() => backupSnapshots.id, { onDelete: 'cascade' }),
    platform: varchar('platform', { length: 20 }).notNull(),
    architecture: varchar('architecture', { length: 20 }).notNull(),
    status: varchar('status', { length: 20 }).notNull().default('pending'),
    storageKey: varchar('storage_key', { length: 1024 }),
    checksumSha256: varchar('checksum_sha256', { length: 64 }),
    checksumStorageKey: varchar('checksum_storage_key', { length: 1024 }),
    signatureFormat: varchar('signature_format', { length: 32 }),
    signatureStorageKey: varchar('signature_storage_key', { length: 1024 }),
    signingKeyId: varchar('signing_key_id', { length: 128 }),
    metadata: jsonb('metadata'),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    signedAt: timestamp('signed_at'),
    completedAt: timestamp('completed_at'),
  },
  (table) => ({
    orgIdx: index('recovery_media_artifacts_org_idx').on(table.orgId),
    tokenIdx: index('recovery_media_artifacts_token_idx').on(table.tokenId),
    snapshotIdx: index('recovery_media_artifacts_snapshot_idx').on(table.snapshotId),
    statusIdx: index('recovery_media_artifacts_status_idx').on(table.status),
    tokenPlatformArchIdx: uniqueIndex('recovery_media_artifacts_token_platform_arch_uniq').on(
      table.tokenId,
      table.platform,
      table.architecture
    ),
  })
);

export const recoveryBootMediaArtifacts = pgTable(
  'recovery_boot_media_artifacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    tokenId: uuid('token_id')
      .notNull()
      .references(() => recoveryTokens.id, { onDelete: 'cascade' }),
    snapshotId: uuid('snapshot_id')
      .notNull()
      .references(() => backupSnapshots.id, { onDelete: 'cascade' }),
    bundleArtifactId: uuid('bundle_artifact_id')
      .notNull()
      .references(() => recoveryMediaArtifacts.id, { onDelete: 'cascade' }),
    platform: varchar('platform', { length: 20 }).notNull(),
    architecture: varchar('architecture', { length: 20 }).notNull(),
    mediaType: varchar('media_type', { length: 20 }).notNull().default('iso'),
    status: varchar('status', { length: 20 }).notNull().default('pending'),
    storageKey: varchar('storage_key', { length: 1024 }),
    checksumSha256: varchar('checksum_sha256', { length: 64 }),
    checksumStorageKey: varchar('checksum_storage_key', { length: 1024 }),
    signatureFormat: varchar('signature_format', { length: 32 }),
    signatureStorageKey: varchar('signature_storage_key', { length: 1024 }),
    signingKeyId: varchar('signing_key_id', { length: 128 }),
    metadata: jsonb('metadata'),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    signedAt: timestamp('signed_at'),
    completedAt: timestamp('completed_at'),
  },
  (table) => ({
    orgIdx: index('recovery_boot_media_artifacts_org_idx').on(table.orgId),
    tokenIdx: index('recovery_boot_media_artifacts_token_idx').on(table.tokenId),
    snapshotIdx: index('recovery_boot_media_artifacts_snapshot_idx').on(table.snapshotId),
    bundleIdx: index('recovery_boot_media_artifacts_bundle_idx').on(table.bundleArtifactId),
    statusIdx: index('recovery_boot_media_artifacts_status_idx').on(table.status),
    tokenMediaTypeIdx: uniqueIndex('recovery_boot_media_artifacts_token_media_type_uniq').on(
      table.tokenId,
      table.platform,
      table.architecture,
      table.mediaType
    ),
  })
);
