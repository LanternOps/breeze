import {
  pgTable, uuid, varchar, text, integer, boolean, timestamp, numeric,
  pgEnum, primaryKey, uniqueIndex, index
} from 'drizzle-orm/pg-core';
import { partners, organizations } from './orgs';
import { users } from './users';
import { tickets, ticketPriorityEnum } from './portal';
import { alerts } from './alerts';

export const ticketAlertLinkTypeEnum = pgEnum('ticket_alert_link_type', ['created_from', 'attached', 'auto']);

export const ticketCategories = pgTable('ticket_categories', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  name: varchar('name', { length: 100 }).notNull(),
  color: varchar('color', { length: 7 }).notNull().default('#6b7d83'),
  parentId: uuid('parent_id'),
  defaultPriority: ticketPriorityEnum('default_priority'),
  responseSlaMinutes: integer('response_sla_minutes'),
  resolutionSlaMinutes: integer('resolution_sla_minutes'),
  defaultBillable: boolean('default_billable').notNull().default(true),
  defaultHourlyRate: numeric('default_hourly_rate', { precision: 10, scale: 2 }),
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
