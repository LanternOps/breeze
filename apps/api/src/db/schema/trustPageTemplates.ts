// apps/api/src/db/schema/trustPageTemplates.ts
import { pgTable, uuid, text, integer, boolean, timestamp } from 'drizzle-orm/pg-core';
import { partners } from './orgs';
import { users } from './users';

/**
 * Trust Center W2 (W02g, #8770; spec §18.8, §19 item 33): the partner-wide trust page template — one row per
 * partner, the partner's default for each inheritable trust page setting. NULL = "not set here" (fall through to
 * the built-in default); `introHtml: ''` = explicitly no intro. Resolution is page → template → built-in default
 * (`resolveEffectiveTrustSettings` in @breeze/shared), frozen into `trust_pages.published_config` at publish.
 *
 * RLS shape 3 (partner-axis), created in apps/api/migrations/2026-12-30-120500-trust-page-templates.sql, which is
 * the authority for the CHECK constraints (intro ≤ 40000 chars, revision ≥ 0) and the RLS policy. No org_id: the
 * only registration is PARTNER_TENANT_TABLES; partner erasure reaches it through the partner_id sweep.
 */
export const trustPageTemplates = pgTable('trust_page_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().unique('trust_page_templates_partner_uq').references(() => partners.id),
  introHtml: text('intro_html'),
  searchIndexable: boolean('search_indexable'),
  showPercentages: boolean('show_percentages'),
  showDeviceCount: boolean('show_device_count'),
  showManagedBy: boolean('show_managed_by'),
  showHistory: boolean('show_history'),
  hiddenControlIds: text('hidden_control_ids').array(),
  frameworkView: text('framework_view').array(),
  /** Bumped by every write; the editor echoes it on publish as `expectedTemplateRevision` (409 TEMPLATE_CHANGED). */
  revision: integer('revision').notNull().default(0),
  updatedByUserId: uuid('updated_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type TrustPageTemplateRow = typeof trustPageTemplates.$inferSelect;
export type NewTrustPageTemplateRow = typeof trustPageTemplates.$inferInsert;
