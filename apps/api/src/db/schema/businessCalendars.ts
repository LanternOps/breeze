import {
  pgTable,
  uuid,
  varchar,
  integer,
  smallint,
  boolean,
  date,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations, partners } from './orgs';
import { users } from './users';

/**
 * Business-hours calendars (#8973 W4, spec §4.1) —
 * 2027-01-03-160000-business-calendars.sql.
 *
 * Ownership follows "Partner-Wide First": org_id XOR partner_id
 * (`*_one_owner_chk`, in the migration per the house convention). The three
 * children copy the parent's owner pair; owner-guard constraint triggers keep
 * them equal. Revisions (and their intervals) are immutable on UPDATE except
 * created_by_user_id -> NULL and an org_id-only restamp (org merge). The
 * current revision is the highest `revision` for a calendar — there is no
 * current_revision_id pointer (it would make an FK cycle).
 *
 * Weekday 0 = Sunday … 6 = Saturday, minutes from local midnight, half-open
 * [start, end) — the CalendarInterval shape of packages/shared businessTime.ts.
 * No jsonb: every column is export-policy `included`.
 */
export const businessCalendars = pgTable(
  'business_calendars',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }),
    partnerId: uuid('partner_id').references(() => partners.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 100 }).notNull(),
    isPartnerDefault: boolean('is_partner_default').notNull().default(false),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    partnerIdx: index('business_calendars_partner_idx').on(table.partnerId).where(sql`org_id IS NULL`),
    orgIdx: index('business_calendars_org_idx').on(table.orgId).where(sql`org_id IS NOT NULL`),
    partnerDefaultUq: uniqueIndex('business_calendars_partner_default_uq')
      .on(table.partnerId)
      .where(sql`is_partner_default AND org_id IS NULL`),
    partnerNameUq: uniqueIndex('business_calendars_partner_name_uq')
      .on(table.partnerId, table.name)
      .where(sql`org_id IS NULL`),
  }),
);

export const businessCalendarRevisions = pgTable(
  'business_calendar_revisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    calendarId: uuid('calendar_id').notNull().references(() => businessCalendars.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }),
    partnerId: uuid('partner_id').references(() => partners.id, { onDelete: 'cascade' }),
    revision: integer('revision').notNull(),
    timezone: varchar('timezone', { length: 64 }).notNull(),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    calendarRevisionUq: uniqueIndex('business_calendar_revisions_calendar_revision_uq').on(table.calendarId, table.revision),
    orgIdx: index('business_calendar_revisions_org_idx').on(table.orgId).where(sql`org_id IS NOT NULL`),
    partnerIdx: index('business_calendar_revisions_partner_idx').on(table.partnerId).where(sql`org_id IS NULL`),
  }),
);

export const businessCalendarIntervals = pgTable(
  'business_calendar_intervals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    revisionId: uuid('revision_id').notNull().references(() => businessCalendarRevisions.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }),
    partnerId: uuid('partner_id').references(() => partners.id, { onDelete: 'cascade' }),
    weekday: smallint('weekday').notNull(),
    startMinute: smallint('start_minute').notNull(),
    endMinute: smallint('end_minute').notNull(),
  },
  (table) => ({
    revisionIdx: index('business_calendar_intervals_revision_idx').on(table.revisionId, table.weekday, table.startMinute),
    orgIdx: index('business_calendar_intervals_org_idx').on(table.orgId).where(sql`org_id IS NOT NULL`),
    partnerIdx: index('business_calendar_intervals_partner_idx').on(table.partnerId).where(sql`org_id IS NULL`),
  }),
);

export const businessCalendarHolidays = pgTable(
  'business_calendar_holidays',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    calendarId: uuid('calendar_id').notNull().references(() => businessCalendars.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }),
    partnerId: uuid('partner_id').references(() => partners.id, { onDelete: 'cascade' }),
    /** Calendar-local date, 'YYYY-MM-DD'. All-day only in v1. */
    holidayDate: date('holiday_date', { mode: 'string' }).notNull(),
    name: varchar('name', { length: 100 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    calendarDateUq: uniqueIndex('business_calendar_holidays_calendar_date_uq').on(table.calendarId, table.holidayDate),
    orgIdx: index('business_calendar_holidays_org_idx').on(table.orgId).where(sql`org_id IS NOT NULL`),
    partnerIdx: index('business_calendar_holidays_partner_idx').on(table.partnerId).where(sql`org_id IS NULL`),
  }),
);
