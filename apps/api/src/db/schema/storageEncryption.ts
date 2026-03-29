import { pgTable, uuid, varchar, text, boolean, timestamp, index } from 'drizzle-orm/pg-core';
import { organizations } from './orgs';

export const storageEncryptionKeys = pgTable('storage_encryption_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  name: varchar('name', { length: 200 }).notNull(),
  keyType: varchar('key_type', { length: 20 }).notNull().default('aes_256'),
  publicKeyPem: text('public_key_pem'),
  encryptedPrivateKey: text('encrypted_private_key'),
  keyHash: varchar('key_hash', { length: 128 }).notNull(),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  rotatedAt: timestamp('rotated_at'),
  expiresAt: timestamp('expires_at'),
}, (table) => ({
  orgIdx: index('encryption_keys_org_idx').on(table.orgId),
  activeIdx: index('encryption_keys_active_idx').on(table.orgId, table.isActive),
}));
