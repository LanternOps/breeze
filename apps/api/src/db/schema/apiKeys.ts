import { pgTable, uuid, varchar, text, timestamp, integer, jsonb, pgEnum } from 'drizzle-orm/pg-core';
import { organizations } from './orgs';
import { users } from './users';
import { servicePrincipals } from './servicePrincipals';

export const apiKeyStatusEnum = pgEnum('api_key_status', ['active', 'revoked', 'expired']);

export const apiKeys = pgTable('api_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  name: varchar('name', { length: 255 }).notNull(),
  keyHash: varchar('key_hash', { length: 255 }).notNull(),
  keyPrefix: varchar('key_prefix', { length: 12 }).notNull(),
  scopes: jsonb('scopes').$type<string[]>().notNull().default([]),
  expiresAt: timestamp('expires_at'),
  lastUsedAt: timestamp('last_used_at'),
  usageCount: integer('usage_count').notNull().default(0),
  rateLimit: integer('rate_limit').notNull().default(1000),
  createdBy: uuid('created_by').notNull().references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  status: apiKeyStatusEnum('status').notNull().default('active'),
  source: text('source').notNull().default('manual'),
  // 'human' | 'service' — non-human keys carry principalId (SR2-15).
  principalType: varchar('principal_type', { length: 16 }).notNull().default('human'),
  principalId: uuid('principal_id').references(() => servicePrincipals.id),
  // Snapshot of the creator's users.credential_epoch / users.mfa_epoch at
  // mint time. NULL for service-principal keys. A human key is rejected at
  // auth time once the creator's live epoch no longer matches — see
  // middleware/apiKeyAuth.ts. creator_auth_epoch is still stamped, but is
  // enforced only for a key with no credential snapshot (minted before
  // #7489): auth_epoch also advances on logout, so it cannot be the binding.
  creatorAuthEpoch: integer('creator_auth_epoch'),
  creatorMfaEpoch: integer('creator_mfa_epoch'),
  creatorCredentialEpoch: integer('creator_credential_epoch'),
});
