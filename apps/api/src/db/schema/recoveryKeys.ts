import { pgTable, uuid, varchar, text, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { devices } from './devices';
import { organizations } from './orgs';

// Escrowed disk-encryption recovery keys (BitLocker / FileVault). One row per
// key; rotation supersedes rather than overwrites so a half-failed rotation
// still leaves the old (possibly still valid) key retrievable.
//
// `encryptedKey` is app-layer-encrypted (see encryptedColumnRegistry.ts) —
// callers MUST run values through `encryptColumnValueForWrite('device_recovery_keys',
// 'encrypted_key', value)` before writing.
export const deviceRecoveryKeys = pgTable('device_recovery_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  deviceId: uuid('device_id').notNull().references(() => devices.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  keyType: varchar('key_type', { length: 50 }).notNull(),
  volumeMount: varchar('volume_mount', { length: 100 }),
  protectorId: varchar('protector_id', { length: 100 }),
  encryptedKey: text('encrypted_key').notNull(),
  keyFingerprint: varchar('key_fingerprint', { length: 64 }).notNull(),
  status: varchar('status', { length: 20 }).notNull().default('active'),
  escrowedAt: timestamp('escrowed_at').defaultNow().notNull(),
  supersededAt: timestamp('superseded_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (table) => ({
  deviceIdx: index('device_recovery_keys_device_idx').on(table.deviceId),
  orgIdx: index('device_recovery_keys_org_idx').on(table.orgId),
  activeSlotUnique: uniqueIndex('device_recovery_keys_active_slot_unique')
    .on(table.deviceId, table.keyType, sql`COALESCE(${table.volumeMount}, '')`)
    .where(sql`${table.status} = 'active'`)
}));

// Append-only who-viewed-when ledger for key reveals.
export const recoveryKeyAccessEvents = pgTable('recovery_key_access_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  keyId: uuid('key_id').notNull().references(() => deviceRecoveryKeys.id, { onDelete: 'cascade' }),
  deviceId: uuid('device_id').notNull().references(() => devices.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull(),
  userEmail: varchar('user_email', { length: 255 }).notNull(),
  action: varchar('action', { length: 20 }).notNull().default('revealed'),
  createdAt: timestamp('created_at').defaultNow().notNull()
}, (table) => ({
  keyIdx: index('recovery_key_access_events_key_idx').on(table.keyId),
  deviceIdx: index('recovery_key_access_events_device_idx').on(table.deviceId),
  orgIdx: index('recovery_key_access_events_org_idx').on(table.orgId)
}));
