// apps/api/src/db/schema/workTypes.ts
import { pgTable, uuid, text, integer, boolean, timestamp } from 'drizzle-orm/pg-core';
import { partners } from './orgs';

/**
 * Partner-owned label for WHAT the labour was (Remote, On-site, Project,
 * After-hours). A label only -- no rate, no default flag. The rate lives on a
 * billing_profile_rules row in W02 (spec §3.1/§3.2).
 *
 * RLS shape 3 (partner-axis), created in
 * apps/api/migrations/2026-10-21-100000-work-types.sql. The
 * UNIQUE (id, partner_id) constraint and the composite FKs that use it
 * are maintained in SQL migrations
 * (same convention as time_entries' org/partner FKs, timeTracking.ts:25-37).
 */
export const workTypes = pgTable('work_types', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  name: text('name').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type WorkType = typeof workTypes.$inferSelect;
export type NewWorkType = typeof workTypes.$inferInsert;
