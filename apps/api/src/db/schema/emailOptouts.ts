import { date, index, pgTable, primaryKey, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';

// Connection health W3 (#8847, spec 2026-10-15 §2.2, §2.3). Both tables are
// Shape 6 (user-id scoped RLS, breeze_current_user_id()), user_id only: no org
// cascade, merge or export registration. The CHECK constraints (topic, source,
// status, error length, sent_at ⇔ sent) live in the migration only.

/** A user's email opt-out per topic (services/emailOptouts.ts owns the topic list). */
export const userEmailOptouts = pgTable('user_email_optouts', {
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  topic: text('topic').notNull(),
  source: text('source').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  pk: primaryKey({ name: 'user_email_optouts_pkey', columns: [t.userId, t.topic] }),
}));

/** Per-user daily digest delivery ledger (at most once per user per partner-local date). */
export const connectionHealthDigestDeliveries = pgTable('connection_health_digest_deliveries', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  digestDate: date('digest_date').notNull(),
  status: text('status').notNull(),
  incidentIds: uuid('incident_ids').array().notNull().default(sql`'{}'::uuid[]`),
  claimedAt: timestamp('claimed_at', { withTimezone: true }).notNull(),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  error: text('error'),
}, (t) => ({
  userDateUniq: unique('connection_health_digest_deliveries_user_date_uniq').on(t.userId, t.digestDate),
  claimedIdx: index('connection_health_digest_deliveries_claimed_idx')
    .on(t.claimedAt)
    .where(sql`${t.status} = 'claimed'`),
  dateIdx: index('connection_health_digest_deliveries_date_idx').on(t.digestDate),
}));
