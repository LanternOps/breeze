import { pgTable, uuid, varchar, text, integer, boolean, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { organizations, partners } from './orgs';
import { users } from './users';
import { deliverableCadenceEnum, deliverableCompletionModeEnum } from './serviceDeliverables';
import { reportTypeEnum } from './reports';

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
  /** Copied onto the deliverable by applyTemplateSet. Internal only — never
   *  reaches the customer portal (#5808 W03, spec §5). */
  instructions: text('instructions'),
  /** Copied onto the deliverable by applyTemplateSet. A PARTNER-WIDE item may
   *  reference only a partner-wide checklist template of the same partner — an
   *  org-owned one would be invisible to every other org the set is applied to,
   *  and the apply would silently produce an empty checklist. Enforced in
   *  services/checklistTemplateReference.ts, not by the FK, which is
   *  single-column on purpose (see migration 2026-10-16-192300). */
  checklistTemplateId: uuid('checklist_template_id'),
  sortOrder: integer('sort_order').notNull().default(0),
  /**
   * #5784 W01. A managed evidence report TYPE, resolved to that org's managed
   * definition at applyTemplateSet time. Never an id: a partner-wide item has
   * org_id IS NULL and reports.org_id is NOT NULL, so no composite FK could
   * hold it. NULL means the item produces no auto-evidence.
   */
  autoEvidenceReportType: reportTypeEnum('auto_evidence_report_type'),
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
