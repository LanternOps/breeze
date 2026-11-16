import { sql } from 'drizzle-orm';
import { pgTable, uuid, varchar, text, timestamp, pgEnum, index, check } from 'drizzle-orm/pg-core';
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
  /** SHA-256 hex of the one-time code — the redeem lookup key. Never returned by any route. */
  codeHash: varchar('code_hash', { length: 64 }).notNull().unique(),
  /**
   * The same one-time code, sealed with the secret-encryption key and bound to
   * this row's id (encryptedColumnRegistry, `aadBinding: 'row'`), so the
   * technician can read it back while the customer has not used it yet
   * (#11836). Only ever non-null while `status = 'pending'`: every transition
   * out of pending sets it to NULL in the same statement, and the CHECK
   * constraint `support_sessions_code_encrypted_pending_chk` refuses a status
   * change that would leave it behind. Never logged, never exported.
   */
  codeEncrypted: text('code_encrypted'),
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
  codeEncryptedPendingChk: check(
    'support_sessions_code_encrypted_pending_chk',
    sql`${t.codeEncrypted} IS NULL OR ${t.status} = 'pending'`,
  ),
}));
