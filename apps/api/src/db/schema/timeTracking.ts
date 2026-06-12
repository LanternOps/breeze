import { sql, type SQL } from 'drizzle-orm';
import {
  pgTable, uuid, text, varchar, integer, boolean, timestamp, numeric,
  pgEnum, uniqueIndex, index
} from 'drizzle-orm/pg-core';
import { partners, organizations } from './orgs';
import { users } from './users';
import { tickets } from './portal';

export const billingStatusEnum = pgEnum('billing_status', ['not_billed', 'billed', 'no_charge', 'contract']);

// Drizzle partial-index predicate helper (kept local; drizzle-kit only needs it
// for drift detection — the real index is created in the SQL migration).
function sqlIsRunning(t: { endedAt: unknown }): SQL {
  return sql`${t.endedAt} IS NULL`;
}

// Standalone partner-axis table (spec §2 / parent spec §8a): supports technician
// timesheets and non-ticket work, not just ticket time. org_id is denormalized
// from the ticket at write time for filtering only — RLS axis is partner_id.
export const timeEntries = pgTable('time_entries', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  orgId: uuid('org_id').references(() => organizations.id),
  ticketId: uuid('ticket_id').references(() => tickets.id, { onDelete: 'set null' }),
  userId: uuid('user_id').notNull().references(() => users.id),
  startedAt: timestamp('started_at').notNull(),
  endedAt: timestamp('ended_at'),
  durationMinutes: integer('duration_minutes'),
  description: text('description'),
  isBillable: boolean('is_billable').notNull().default(false),
  hourlyRate: numeric('hourly_rate', { precision: 10, scale: 2 }),
  billingStatus: billingStatusEnum('billing_status').notNull().default('not_billed'),
  isApproved: boolean('is_approved').notNull().default(false),
  approvedBy: uuid('approved_by').references(() => users.id),
  approvedAt: timestamp('approved_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (t) => [
  // One running timer per user, DB-enforced (spec D3 backstop)
  uniqueIndex('time_entries_one_running_per_user_uq').on(t.userId).where(sqlIsRunning(t)),
  index('time_entries_partner_started_idx').on(t.partnerId, t.startedAt),
  index('time_entries_ticket_idx').on(t.ticketId),
  index('time_entries_user_started_idx').on(t.userId, t.startedAt)
]);

export const ticketParts = pgTable('ticket_parts', {
  id: uuid('id').primaryKey().defaultRandom(),
  ticketId: uuid('ticket_id').notNull().references(() => tickets.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  description: text('description').notNull(),
  partNumber: varchar('part_number', { length: 100 }),
  vendor: varchar('vendor', { length: 100 }),
  quantity: numeric('quantity', { precision: 10, scale: 2 }).notNull(),
  unitPrice: numeric('unit_price', { precision: 10, scale: 2 }).notNull().default('0'),
  costBasis: numeric('cost_basis', { precision: 10, scale: 2 }),
  isBillable: boolean('is_billable').notNull().default(true),
  billingStatus: billingStatusEnum('billing_status').notNull().default('not_billed'),
  addedBy: uuid('added_by').references(() => users.id),
  notes: text('notes'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (t) => [index('ticket_parts_ticket_idx').on(t.ticketId)]);
