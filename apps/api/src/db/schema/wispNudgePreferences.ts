import { foreignKey, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { partners } from './orgs';
import { users } from './users';

/**
 * Wisp W06a (#9912) — per-user nudge preferences (Wisp design §7.4; w00
 * "Nudges (W06)", A28, A29). User axis inside a partner; one row per user.
 * Missing row = defaults (`resolveWispNudgePrefs` in @breeze/shared).
 * Migration: 2027-01-04-110400-wisp-nudge-preferences.sql.
 */
export const wispNudgePreferences = pgTable('wisp_nudge_preferences', {
  userId: uuid('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  partnerId: uuid('partner_id').notNull().references(() => partners.id, { onDelete: 'cascade' }),
  channels: jsonb('channels').$type<{ inApp: boolean; push: boolean }>().notNull().default({ inApp: true, push: true }),
  quietOverride: text('quiet_override').$type<'never' | 'urgent_only'>().notNull().default('never'),
  digestCadenceMinutes: integer('digest_cadence_minutes').notNull().default(240),
  lastDigestAt: timestamp('last_digest_at', { withTimezone: true }),
  /** 'HH:MM' local; NULL = brief off (w00 A28). */
  briefTimeLocal: text('brief_time_local').default('08:00'),
  /** IANA zone; NULL = first registered mobile device zone, else UTC. */
  briefTimezone: text('brief_timezone'),
  lastBriefAt: timestamp('last_brief_at', { withTimezone: true }),
  /** Push severity floor (w00 A29). */
  proactivity: text('proactivity').$type<'quiet' | 'normal' | 'chatty'>().notNull().default('normal'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  userPartnerFk: foreignKey({
    name: 'wisp_nudge_preferences_user_partner_fk',
    columns: [t.userId, t.partnerId],
    foreignColumns: [users.id, users.partnerId],
  }).onDelete('cascade'),
  partnerIdx: index('wisp_nudge_preferences_partner_idx').on(t.partnerId),
}));

/**
 * Wisp W06a (#9912) — the partner's "urgent-capable" severities: a concern of
 * one of these severities may break through quiet hours for a user who chose
 * `quiet_override = 'urgent_only'`. Partner axis; one row per partner; missing
 * row = none (spec §7.4 "default: none").
 */
export const wispPartnerNudgeSettings = pgTable('wisp_partner_nudge_settings', {
  partnerId: uuid('partner_id').primaryKey().references(() => partners.id, { onDelete: 'cascade' }),
  urgentCapableSeverities: text('urgent_capable_severities').array().$type<Array<'info' | 'low' | 'medium' | 'high'>>().notNull().default([]),
  updatedByUserId: uuid('updated_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export type WispNudgePreferencesRow = typeof wispNudgePreferences.$inferSelect;
export type WispPartnerNudgeSettingsRow = typeof wispPartnerNudgeSettings.$inferSelect;
