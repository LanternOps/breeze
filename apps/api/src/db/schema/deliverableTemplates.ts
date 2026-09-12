import { pgTable, uuid, varchar, text, integer, boolean, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { organizations, partners } from './orgs';
import { users } from './users';
import { deliverableCadenceEnum, deliverableCompletionModeEnum } from './serviceDeliverables';

/**
 * Spec #5573 §4.6 / D9. Dual ownership: org_id XOR partner_id (CLAUDE.md
 * "Partner-Wide First"). The XOR CHECK, the two branch FKs on items and the
 * partner-wide SELECT policy live in SQL only (migration
 * 2026-10-16-110100-deliverable-templates.sql) — Drizzle cannot express any of
 * them. The single-column `references()` below exist for typing.
 */
export const deliverableTemplateSets = pgTable('deliverable_template_sets', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => organizations.id),
  partnerId: uuid('partner_id').references(() => partners.id),
  name: varchar('name', { length: 200 }).notNull(),
  description: text('description'),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  uniqueIndex('deliverable_template_sets_id_org_uq').on(t.id, t.orgId),
  uniqueIndex('deliverable_template_sets_id_partner_uq').on(t.id, t.partnerId),
  index('deliverable_template_sets_partner_idx').on(t.partnerId),
  index('deliverable_template_sets_org_idx').on(t.orgId),
]);

/** Spec §4.6. Owner columns are copied from the set and pinned by two branch FKs. */
export const deliverableTemplateItems = pgTable('deliverable_template_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  setId: uuid('set_id').notNull().references(() => deliverableTemplateSets.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').references(() => organizations.id),
  partnerId: uuid('partner_id').references(() => partners.id),
  name: varchar('name', { length: 200 }).notNull(),
  description: text('description'),
  cadence: deliverableCadenceEnum('cadence').notNull(),
  leadDays: integer('lead_days').notNull().default(7),
  graceDays: integer('grace_days').notNull().default(14),
  artifactRequired: boolean('artifact_required').notNull().default(true),
  completionMode: deliverableCompletionModeEnum('completion_mode').notNull().default('on_ticket_resolve'),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  uniqueIndex('deliverable_template_items_set_name_uq').on(t.setId, t.name),
  index('deliverable_template_items_set_sort_idx').on(t.setId, t.sortOrder),
  index('deliverable_template_items_partner_idx').on(t.partnerId),
  index('deliverable_template_items_org_idx').on(t.orgId),
]);

export type DeliverableTemplateSetRow = typeof deliverableTemplateSets.$inferSelect;
export type DeliverableTemplateItemRow = typeof deliverableTemplateItems.$inferSelect;
