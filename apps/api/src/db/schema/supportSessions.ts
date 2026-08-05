import { pgTable, uuid, varchar, text, timestamp, pgEnum, index } from 'drizzle-orm/pg-core';
import { organizations } from './orgs';
import { users } from './users';
import { devices } from './devices';

/**
 * Quick Support — one-time code ad-hoc remote sessions (RLS Shape 1, direct org_id).
 *
 * `active` is deliberately NOT a stored status: it is derived at read time from
 * live remote_sessions rows for the linked device, so nothing has to hook the
 * remote-session create/end paths.
 */
export const supportSessionStatusEnum = pgEnum('support_session_status', [
  'pending',
  'claimed',
  'ready',
  'ended',
  'expired',
]);

export const supportSessions = pgTable('support_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** Always the partner's hidden 'quick_support' org — never a real customer org. */
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  createdByUserId: uuid('created_by_user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  /** SHA-256 hex of the one-time code. Never returned by any route. */
  codeHash: varchar('code_hash', { length: 64 }).notNull().unique(),
  codeExpiresAt: timestamp('code_expires_at', { withTimezone: true }).notNull(),
  status: supportSessionStatusEnum('status').notNull().default('pending'),
  hardExpiresAt: timestamp('hard_expires_at', { withTimezone: true }).notNull(),
  /** SET NULL on device delete — the session row outlives the purged ephemeral device. */
  deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'set null' }),
  /** Reporting attribution only; carries no tenancy effect. */
  attributedOrgId: uuid('attributed_org_id').references(() => organizations.id, { onDelete: 'set null' }),
  attributionLabel: text('attribution_label'),
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
  claimedFromIp: text('claimed_from_ip'),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  endedReason: text('ended_reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  reaperIdx: index('idx_support_sessions_reaper').on(t.status, t.hardExpiresAt),
  deviceIdx: index('idx_support_sessions_device').on(t.deviceId),
}));
