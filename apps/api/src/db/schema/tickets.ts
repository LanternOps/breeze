// Note: the `tickets` table itself lives in portal.ts; this file defines the
// Phase-1 ticketing extension tables (ticket_categories, ticket_alert_links,
// partner_ticket_sequences).
import {
  pgTable, uuid, varchar, text, integer, boolean, timestamp,
  pgEnum, primaryKey, uniqueIndex, index, type AnyPgColumn
} from 'drizzle-orm/pg-core';
import { partners, organizations } from './orgs';
import { users } from './users';
import { tickets, ticketPriorityEnum } from './portal';
import { alerts } from './alerts';
import { workTypes } from './workTypes';

export const ticketAlertLinkTypeEnum = pgEnum('ticket_alert_link_type', ['created_from', 'attached', 'auto']);

export const ticketCategories = pgTable('ticket_categories', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  name: varchar('name', { length: 100 }).notNull(),
  color: varchar('color', { length: 7 }).notNull().default('#6b7d83'),
  // Composite FK (parent_id, partner_id) -> (id, partner_id) lives in SQL only
  // (2026-06-10-c migration) — same-partner parents enforced at the DB level.
  parentId: uuid('parent_id').references((): AnyPgColumn => ticketCategories.id, { onDelete: 'set null' }),
  defaultPriority: ticketPriorityEnum('default_priority'),
  responseSlaMinutes: integer('response_sla_minutes'),
  resolutionSlaMinutes: integer('resolution_sla_minutes'),
  // #4615 / spec §3.1: the work type applied SERVER-SIDE at stamp time when a
  // caller sends no workTypeId and the entry has a ticket. Composite FK
  // ticket_categories_default_work_type_partner_fk is SQL-migration-only.
  defaultWorkTypeId: uuid('default_work_type_id').references(() => workTypes.id),
  // #4177: minutes an AI time-entry proposal pre-fills for this category.
  // Nullable — no default means "use AI_TIME_ENTRY_DEFAULT_MINUTES". CHECK
  // (0 < n <= 1440) is SQL-only (ticket_categories_default_time_entry_minutes_chk).
  defaultTimeEntryMinutes: integer('default_time_entry_minutes'),
  sortOrder: integer('sort_order').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (t) => [index('ticket_categories_partner_idx').on(t.partnerId)]);

export const ticketAlertLinks = pgTable('ticket_alert_links', {
  id: uuid('id').primaryKey().defaultRandom(),
  ticketId: uuid('ticket_id').notNull().references(() => tickets.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  alertId: uuid('alert_id').notNull().references(() => alerts.id, { onDelete: 'cascade' }),
  linkType: ticketAlertLinkTypeEnum('link_type').notNull().default('attached'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull()
}, (t) => [
  uniqueIndex('ticket_alert_links_ticket_alert_uq').on(t.ticketId, t.alertId),
  index('ticket_alert_links_alert_idx').on(t.alertId)
]);

export const partnerTicketSequences = pgTable('partner_ticket_sequences', {
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  year: integer('year').notNull(),
  counter: integer('counter').notNull().default(0)
}, (t) => [primaryKey({ columns: [t.partnerId, t.year] })]);
