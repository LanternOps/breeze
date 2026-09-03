import { sql, type SQL } from 'drizzle-orm';
import {
  pgTable, uuid, text, varchar, integer, boolean, timestamp, numeric, char,
  pgEnum, uniqueIndex, index
} from 'drizzle-orm/pg-core';
import { partners, organizations } from './orgs';
import { users } from './users';
import { tickets } from './portal';
import { catalogItems } from './catalog';

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
  // Wave 4 (#3776): snapshot of the org currency at creation / first attach, or
  // of the partner currency when a standalone entry first carries a rate.
  // Nullable only while org_id IS NULL AND hourly_rate IS NULL — CHECKs
  // time_entries_currency_required_when_{org,rate}_chk live in SQL
  // (2026-08-30-ticketing-currency.sql). Never restamped.
  currencyCode: char('currency_code', { length: 3 }),
  billingStatus: billingStatusEnum('billing_status').notNull().default('not_billed'),
  // W06 (#3900) provenance. Server-stamped only — no public zod schema accepts it.
  // Values enforced by CHECK time_entries_source_chk in SQL:
  // 'manual' | 'timer' | 'location' | 'remote_session' | 'support_session'.
  source: varchar('source', { length: 24 }).notNull().default('manual'),
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
  index('time_entries_user_started_idx').on(t.userId, t.startedAt),
  index('time_entries_org_started_at_idx')
    .on(t.orgId, t.startedAt)
    .where(sql`${t.orgId} IS NOT NULL`)
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
  // Snapshot of the org currency when the part is created; never restamped.
  currencyCode: char('currency_code', { length: 3 }).notNull(),
  costBasis: numeric('cost_basis', { precision: 10, scale: 2 }),
  isBillable: boolean('is_billable').notNull().default(true),
  billingStatus: billingStatusEnum('billing_status').notNull().default('not_billed'),
  addedBy: uuid('added_by').references(() => users.id),
  catalogItemId: uuid('catalog_item_id').references(() => catalogItems.id, { onDelete: 'set null' }),
  notes: text('notes'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (t) => [index('ticket_parts_ticket_idx').on(t.ticketId)]);

// W06 (#3900) decisions ledger — RLS Shape 3 partner-axis, same policy shape
// as time_entries. Deliberately NO org_id / device_id: signal rows may be
// purged (Quick Support devices routinely are), so signal_id has no FK and
// the row is an inert orphan until the user or partner is erased.
// time_entry_id is ON DELETE SET NULL so a confirmed decision survives the
// hard delete of its entry as a tombstone (replay -> 410, never re-suggested).
export const timeSuggestionDecisions = pgTable('time_suggestion_decisions', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  signalKind: varchar('signal_kind', { length: 24 }).notNull(),
  signalId: uuid('signal_id').notNull(),
  decision: varchar('decision', { length: 16 }).notNull(),
  timeEntryId: uuid('time_entry_id').references(() => timeEntries.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
}, (t) => [
  uniqueIndex('time_suggestion_decisions_user_signal_uq').on(t.userId, t.signalKind, t.signalId),
  index('time_suggestion_decisions_partner_idx').on(t.partnerId),
  index('time_suggestion_decisions_entry_idx').on(t.timeEntryId).where(sql`${t.timeEntryId} IS NOT NULL`)
]);
