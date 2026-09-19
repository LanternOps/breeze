import { pgTable, pgEnum, uuid, boolean, timestamp, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';

export const ticketSlaPushScopeEnum = pgEnum('ticket_sla_push_scope', ['off', 'owned', 'any']);

/**
 * Per-user mobile push preferences for ticket events (W07, #3901).
 * Shape 6 (user-scoped RLS, breeze_current_user_id). Missing row = defaults;
 * see resolveTicketPushPrefs in @breeze/shared.
 */
export const ticketPushPreferences = pgTable('ticket_push_preferences', {
  userId: uuid('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  assignedEnabled: boolean('assigned_enabled').notNull().default(true),
  slaScope: ticketSlaPushScopeEnum('sla_scope').notNull().default('owned'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  slaAnyIdx: index('ticket_push_preferences_sla_any_idx').on(t.userId).where(sql`${t.slaScope} = 'any'`),
}));
