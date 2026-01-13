import { pgTable, uuid, varchar, text, timestamp, integer, jsonb, pgEnum } from 'drizzle-orm/pg-core';
import { organizations } from './orgs';
import { users } from './users';

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
  status: apiKeyStatusEnum('status').notNull().default('active')
});
