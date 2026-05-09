import { pgTable, uuid, text, timestamp, index } from 'drizzle-orm/pg-core';

export const manifestSigningKeys = pgTable(
  'manifest_signing_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    keyId: text('key_id').notNull().unique(),
    algorithm: text('algorithm').notNull().default('ed25519'),
    publicKeyB64: text('public_key_b64').notNull(),
    privateKeyEnc: text('private_key_enc').notNull(),
    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
  },
  (t) => ({ statusIdx: index('idx_manifest_signing_keys_status').on(t.status) }),
);
