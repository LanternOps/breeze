import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  uniqueIndex,
  pgEnum,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const manifestSigningKeyStatus = pgEnum('manifest_signing_key_status', [
  'active',
  'retired',
]);

export const manifestSigningKeys = pgTable(
  'manifest_signing_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    keyId: text('key_id').notNull().unique(),
    publicKeyB64: text('public_key_b64').notNull(),
    privateKeyEnc: text('private_key_enc').notNull(),
    status: manifestSigningKeyStatus('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
  },
  (t) => ({
    statusIdx: index('idx_manifest_signing_keys_status').on(t.status),
    // Single-active invariant: only one 'active' row allowed per deployment.
    // The partial unique index lives in the migration; this declaration is for
    // drift detection only.
    activeUnique: uniqueIndex('uq_manifest_signing_keys_active')
      .on(t.status)
      .where(sql`${t.status} = 'active'`),
  }),
);
