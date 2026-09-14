import { pgTable, pgEnum, uuid, varchar, text, integer, timestamp, index } from 'drizzle-orm/pg-core';
import { organizations } from './orgs';
import { users } from './users';
import { tickets } from './portal';

export const ticketChecklistItemSourceEnum = pgEnum('ticket_checklist_item_source', [
  'manual',
  'deliverable',
  'checklist_template',
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
