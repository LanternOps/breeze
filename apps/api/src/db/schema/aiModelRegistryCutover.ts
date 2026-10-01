// AI model registry W03 (#7601, Task 6A): the per-partner legacy → registry
// cutover record and the background sweep's coordinator singleton.
// Migration: 2026-11-19-100400-ai-model-registry-cutover.sql.
import { sql } from 'drizzle-orm';
import { check, pgTable, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { partners } from './orgs';

/** System singleton (id = 1): sweep lease + monotonic completion stamp. Forced RLS, system-only. */
export const aiModelRegistryState = pgTable('ai_model_registry_state', {
  id: smallint('id').primaryKey().default(1),
  cutoverCompletedAt: timestamp('cutover_completed_at', { withTimezone: true }),
  leaseOwner: text('lease_owner'),
  leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [check('ai_model_registry_state_id_check', sql`${t.id} = 1`)]);

/** Shape 3 (partner axis): a row means the partner was projected from legacy config, once. */
export const aiModelRegistryPartnerCutover = pgTable('ai_model_registry_partner_cutover', {
  partnerId: uuid('partner_id').primaryKey().references(() => partners.id, { onDelete: 'cascade' }),
  cutoverAt: timestamp('cutover_at', { withTimezone: true }).notNull().defaultNow(),
});
