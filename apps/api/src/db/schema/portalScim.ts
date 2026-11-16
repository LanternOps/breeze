import { pgTable, uuid, text, char, timestamp, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations } from './orgs';
import { users } from './users';

/**
 * Portal registration W9 (#11386): the SCIM bearer credential of one org.
 * Plan: docs/superpowers/plans/portal/2026-11-15-portal-registration-w09-entra-scim.md
 * (D1, D2). Migration: 2027-01-25-130000-portal-entra-scim.sql, which is the
 * spec of record (CHECKs live there); this file mirrors it.
 *
 * Tenancy shape 1 (direct org_id, RLS enabled + forced, breeze_has_org_access
 * per command). `org_id NOT NULL` by design: a credential bound to one org's
 * proven Entra tenant, not configuration.
 *
 * Only a SHA-256 of the secret is stored (`secret_hash`, lowercase hex); the
 * secret exists once, in the create response. A token authenticates only while
 * `entra_tenant_id` is the org's proven tenant and `revoked_at` is null.
 */
export const portalScimTokens = pgTable('portal_scim_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  entraTenantId: text('entra_tenant_id').notNull(),
  label: text('label').notNull(),
  secretHash: char('secret_hash', { length: 64 }).notNull(),
  // The last characters of the secret, shown so the MSP can tell tokens apart.
  secretHint: text('secret_hint').notNull(),
  createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revokedByUserId: uuid('revoked_by_user_id').references(() => users.id, { onDelete: 'set null' }),
}, (table) => ({
  orgLiveIdx: index('portal_scim_tokens_org_live_idx').on(table.orgId).where(sql`${table.revokedAt} IS NULL`),
}));

export type PortalScimToken = typeof portalScimTokens.$inferSelect;
