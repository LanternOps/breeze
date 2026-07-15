import { pgTable, uuid, varchar, jsonb, timestamp } from 'drizzle-orm/pg-core';
import { organizations } from './orgs';
import { users } from './users';

// Opt-in, first-class non-human identity (SR2-15). Org-owned (RLS shape-1):
// `service_principals_org_access` policy in 2026-07-19-service-principals.sql
// enforces `breeze_has_org_access(org_id)` for all four commands.
export const servicePrincipals = pgTable('service_principals', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  name: varchar('name', { length: 255 }).notNull(),
  // Plain varchar + CHECK (not pgEnum) to match the migration's
  // `service_principals_status_chk CHECK (status IN ('active','disabled'))`.
  status: varchar('status', { length: 16 }).notNull().default('active'),
  scopes: jsonb('scopes').$type<string[]>().notNull().default([]),
  createdBy: uuid('created_by').notNull().references(() => users.id),
  lastUpdatedBy: uuid('last_updated_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});
