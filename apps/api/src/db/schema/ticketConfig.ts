import {
  pgTable, uuid, varchar, integer, boolean, timestamp, numeric, jsonb,
  uniqueIndex, index
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { partners, organizations } from './orgs';
import { ticketStatusEnum, ticketPriorityEnum } from './portal';

export const ticketStatuses = pgTable('ticket_statuses', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 60 }).notNull(),
  coreStatus: ticketStatusEnum('core_status').notNull(),
  color: varchar('color', { length: 7 }),
  sortOrder: integer('sort_order').notNull().default(0),
  // The six seeded rows: renameable/recolorable, never deactivated/re-mapped/deleted.
  isSystem: boolean('is_system').notNull().default(false),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (t) => [
  index('ticket_statuses_partner_idx').on(t.partnerId),
  uniqueIndex('ticket_statuses_partner_name_uq').on(t.partnerId, sql`lower(${t.name})`),
  uniqueIndex('ticket_statuses_partner_core_status_system_uq').on(t.partnerId, t.coreStatus).where(sql`${t.isSystem}`)
]);

export const ticketPrioritySettings = pgTable('ticket_priority_settings', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id, { onDelete: 'cascade' }),
  priority: ticketPriorityEnum('priority').notNull(),
  label: varchar('label', { length: 40 }),
  responseSlaMinutes: integer('response_sla_minutes'),
  resolutionSlaMinutes: integer('resolution_sla_minutes'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (t) => [uniqueIndex('ticket_priority_settings_partner_priority_uq').on(t.partnerId, t.priority)]);

export const orgTicketSettings = pgTable('org_ticket_settings', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().unique().references(() => organizations.id, { onDelete: 'cascade' }),
  // { "<priority>": { "responseMinutes": n|null, "resolutionMinutes": n|null } } — shape owned by the shared Zod validator
  slaOverrides: jsonb('sla_overrides').notNull().default(sql`'{}'::jsonb`),
  defaultHourlyRate: numeric('default_hourly_rate', { precision: 10, scale: 2 }),
  defaultBillable: boolean('default_billable'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
});
