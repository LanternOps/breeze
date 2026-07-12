import { pgTable, uuid, varchar, timestamp, jsonb, pgEnum, real, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { partners } from './orgs';

export const abuseSignalSeverityEnum = pgEnum('abuse_signal_severity', ['info', 'watch', 'alert']);

// Platform-operator abuse signals ABOUT partners — never visible TO partners.
// RLS is a system-only policy (see the migration); all reads/writes happen
// under withSystemDbAccessContext. Do NOT add breeze_has_partner_access
// policies to this table.
export const partnerAbuseSignals = pgTable('partner_abuse_signals', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id, { onDelete: 'cascade' }),
  signalKey: varchar('signal_key', { length: 64 }).notNull(),
  severity: abuseSignalSeverityEnum('severity').notNull(),
  score: real('score').notNull().default(0),
  evidence: jsonb('evidence').notNull().default({}),
  firstFiredAt: timestamp('first_fired_at', { withTimezone: true }).defaultNow().notNull(),
  computedAt: timestamp('computed_at', { withTimezone: true }).defaultNow().notNull(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
  acknowledgedBy: varchar('acknowledged_by', { length: 255 }),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
}, (t) => [
  // One OPEN row per (partner, signal); resolved rows keep history.
  uniqueIndex('partner_abuse_signals_open_uq').on(t.partnerId, t.signalKey).where(sql`resolved_at IS NULL`),
  index('partner_abuse_signals_partner_idx').on(t.partnerId),
]);
