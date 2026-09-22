import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  text,
  integer,
  timestamp,
  index,
  boolean,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { organizations, partners } from './orgs';
import { users } from './users';
import { tickets } from './portal';

/**
 * Label order mirrors the shipped type's ordinals exactly, and is APPEND-ONLY:
 * 'manual'/'deliverable'/'checklist_template' from
 * 2026-10-16-190000-ticket-checklist-items.sql, then 'operator_task' from
 * 2026-10-26-170000-ticket-checklist-operator-task-source.sql. Single-sourced
 * in spirit from `CHECKLIST_ITEM_SOURCES` (@breeze/shared) — the two are pinned
 * together by packages/shared/src/validators/ticketChecklists.test.ts, by
 * db/schema/aiOperatorHumanWork.test.ts and by `pnpm db:check-drift`.
 */
export const ticketChecklistItemSourceEnum = pgEnum('ticket_checklist_item_source', [
  'manual',
  'deliverable',
  'checklist_template',
  'operator_task',
]);

/**
 * Spec #5783 §4.1. One tickable step on one ticket.
 * Migration: 2026-10-16-190000-ticket-checklist-items.sql.
 *
 * Tenancy shape 1: `org_id` is denormalized from the ticket, so BOTH org movers
 * re-stamp it (services/ticketOrgMoveLockOrder.ts and routes/devices/moveOrg.ts).
 *
 * The composite FK `(ticket_id, org_id) -> tickets(id, org_id)`,
 * DEFERRABLE INITIALLY IMMEDIATE ON DELETE CASCADE, is declared in SQL only —
 * Drizzle cannot express DEFERRABLE, and `tickets_id_org_uq` is itself SQL-only.
 * The single-column `references()` below exist for typing, matching this schema
 * directory's established convention.
 *
 * `sourceTemplateItemId` deliberately has NO reference: the source template may
 * be partner-wide (org_id NULL), so no composite org FK is expressible, and the
 * row is audit provenance that must survive the template item's deletion.
 */
export const ticketChecklistItems = pgTable('ticket_checklist_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  ticketId: uuid('ticket_id').notNull().references(() => tickets.id),
  label: varchar('label', { length: 500 }).notNull(),
  detail: text('detail'),
  position: integer('position').notNull().default(0),
  /** THE authority for "done". Survives the completer's user row being deleted. */
  doneAt: timestamp('done_at', { withTimezone: true }),
  doneByUserId: uuid('done_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  source: ticketChecklistItemSourceEnum('source').notNull().default('manual'),
  sourceTemplateItemId: uuid('source_template_item_id'),
  /**
   * The `ai_operator_task_steps` row that created this item, for
   * `source = 'operator_task'` (recipe spec §5.3). Provenance, NOT a
   * reference — see `sourceTemplateItemId` above for the shape and migration
   * 2026-10-26-170100's header note B for why this one's case is stronger:
   * after a ticket org-move the step and the item legitimately live in
   * different orgs.
   */
  operatorStepId: uuid('operator_step_id'),
  /** NULL for sweep-created rows — the sweep actor's nil UUID is not a users row. */
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('ticket_checklist_items_ticket_pos_idx').on(t.ticketId, t.position),
  index('ticket_checklist_items_org_idx').on(t.orgId),
]);

export type TicketChecklistItemRow = typeof ticketChecklistItems.$inferSelect;
export type TicketChecklistItemSource = TicketChecklistItemRow['source'];

/**
 * Spec #5783 §4.2. A reusable, ordered list of step labels.
 * Migration: 2026-10-16-191300-ticket-checklist-templates.sql.
 *
 * Dual ownership: org_id XOR partner_id (CLAUDE.md "Partner-Wide First"). The
 * XOR CHECK, the two branch FKs on items and BOTH RLS policies (the dual-axis
 * `FOR ALL` isolation policy and the separate SELECT-only partner-wide read
 * branch) live in SQL only — Drizzle can express none of them. The
 * single-column `references()` below exist for typing, matching this schema
 * directory's established convention.
 */
export const ticketChecklistTemplates = pgTable(
  'ticket_checklist_templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').references(() => organizations.id),
    partnerId: uuid('partner_id').references(() => partners.id),
    name: varchar('name', { length: 200 }).notNull(),
    description: text('description'),
    /** Internal runbook prose. Never rendered in the customer portal (spec §5). */
    instructions: text('instructions'),
    isActive: boolean('is_active').notNull().default(true),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('ticket_checklist_templates_id_org_uq').on(t.id, t.orgId),
    uniqueIndex('ticket_checklist_templates_id_partner_uq').on(t.id, t.partnerId),
    index('ticket_checklist_templates_partner_idx').on(t.partnerId),
    index('ticket_checklist_templates_org_idx').on(t.orgId),
  ],
);

/**
 * Spec #5783 §4.3. Owner columns are copied from the template and pinned by TWO
 * branch FKs — `(template_id, org_id)` and `(template_id, partner_id)`, both
 * `ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE`, declared in SQL only. A
 * single three-column FK would be MATCH SIMPLE and therefore never evaluated
 * (the XOR guarantees one owner column is always NULL).
 */
export const ticketChecklistTemplateItems = pgTable(
  'ticket_checklist_template_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    templateId: uuid('template_id')
      .notNull()
      .references(() => ticketChecklistTemplates.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id').references(() => organizations.id),
    partnerId: uuid('partner_id').references(() => partners.id),
    label: varchar('label', { length: 500 }).notNull(),
    detail: text('detail'),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('ticket_checklist_template_items_template_label_uq').on(t.templateId, t.label),
    index('ticket_checklist_template_items_template_sort_idx').on(t.templateId, t.sortOrder),
    index('ticket_checklist_template_items_partner_idx').on(t.partnerId),
    index('ticket_checklist_template_items_org_idx').on(t.orgId),
  ],
);

export type TicketChecklistTemplateRow = typeof ticketChecklistTemplates.$inferSelect;
export type TicketChecklistTemplateItemRow = typeof ticketChecklistTemplateItems.$inferSelect;
