import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  jsonb,
  index,
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
    usedAt: timestamp('used_at'),
  },
  (table) => ({
    orgIdx: index('recovery_tokens_org_idx').on(table.orgId),
    hashIdx: index('recovery_tokens_hash_idx').on(table.tokenHash),
    statusIdx: index('recovery_tokens_status_idx').on(table.status),
  })
);
