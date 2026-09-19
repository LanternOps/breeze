import { pgTable, pgEnum, uuid, varchar, text, date, integer, boolean, timestamp, index } from 'drizzle-orm/pg-core';
import { organizations } from './orgs';
import { users } from './users';
import { tickets } from './portal';

export const orgKeyDateKindEnum = pgEnum('org_key_date_kind', ['insurance_renewal', 'vendor_contract_end', 'compliance_deadline', 'audit', 'other']);

/**
 * Spec #5573 §4.5. Typed org-level dates that drive reminders (W02) and the
 * portal (W04). The `(reminder_ticket_id, org_id)` composite FK is SQL-only.
 */
export const organizationKeyDates = pgTable('organization_key_dates', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  label: varchar('label', { length: 200 }).notNull(),
  kind: orgKeyDateKindEnum('kind').notNull().default('other'),
  date: date('date').notNull(),
  recursAnnually: boolean('recurs_annually').notNull().default(false),
  remindDaysBefore: integer('remind_days_before'),
  ownerUserId: uuid('owner_user_id').references(() => users.id, { onDelete: 'set null' }),
  remindedForDate: date('reminded_for_date'),
  reminderTicketId: uuid('reminder_ticket_id').references(() => tickets.id, { onDelete: 'set null' }),
  portalVisible: boolean('portal_visible').notNull().default(false),
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [index('org_key_dates_org_date_idx').on(t.orgId, t.date)]);

export type OrganizationKeyDateRow = typeof organizationKeyDates.$inferSelect;
