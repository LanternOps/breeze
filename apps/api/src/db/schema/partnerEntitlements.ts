import { sql } from 'drizzle-orm';
import { check, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { partners } from './orgs';
import { users } from './users';

// Partner Entitlements W1 (#9907) — migration 2027-01-04-100000-partner-entitlements.sql.
// RLS Shape 3 partner-axis: partner_id only, deliberately NO org_id, so its only
// registration is PARTNER_TENANT_TABLES (rls-coverage). One row per
// (partner, feature_key, source); `plan` is the absence of a live row. Read it
// through services/entitlements.ts, never directly from a request context —
// org-scoped tokens see zero rows here by design.
export const partnerEntitlements = pgTable('partner_entitlements', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id, { onDelete: 'cascade' }),
  featureKey: varchar('feature_key', { length: 64 }).notNull(),
  state: varchar('state', { length: 16 }).notNull(),
  source: varchar('source', { length: 16 }).notNull(),
  limits: jsonb('limits'),
  grantedAt: timestamp('granted_at', { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  reason: text('reason'),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
}, (t) => [
  uniqueIndex('partner_entitlements_partner_key_source_uq').on(t.partnerId, t.featureKey, t.source),
  index('partner_entitlements_partner_idx').on(t.partnerId),
  check('partner_entitlements_state_chk', sql`${t.state} IN ('enabled','disabled')`),
  check('partner_entitlements_source_chk', sql`${t.source} IN ('billing','license','manual')`),
  check('partner_entitlements_manual_reason_chk', sql`${t.source} <> 'manual' OR ${t.reason} IS NOT NULL`)
]);

export type PartnerEntitlementRow = typeof partnerEntitlements.$inferSelect;
