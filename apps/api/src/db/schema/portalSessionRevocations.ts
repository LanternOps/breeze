import { sql } from 'drizzle-orm';
import { check, index, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { portalUsers } from './portal';

/**
 * Customer-portal sessions ended at logout (migration
 * `2026-11-10-140000-portal-session-revocations.sql`).
 *
 * The portal session itself is an opaque token cached in Redis; this row is
 * the durable record that the token was signed out, so a failed cache delete
 * or a Redis restore cannot bring it back. Keyed by the SHA-256 digest of the
 * token — the token is never stored.
 *
 * RLS: system-only (forced; one `breeze.scope = 'system'` policy). No org_id:
 * rows follow their portal user through the ON DELETE CASCADE foreign key.
 */
export const portalSessionRevocations = pgTable(
  'portal_session_revocations',
  {
    tokenDigest: varchar('token_digest', { length: 64 }).primaryKey(),
    portalUserId: uuid('portal_user_id')
      .notNull()
      .references(() => portalUsers.id, { onDelete: 'cascade' }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => ({
    portalUserIdx: index('portal_session_revocations_portal_user_idx').on(t.portalUserId),
    expiresIdx: index('portal_session_revocations_expires_idx').on(t.expiresAt),
    tokenDigestCheck: check(
      'portal_session_revocations_token_digest_chk',
      sql`${t.tokenDigest} ~ '^[0-9a-f]{64}$'`,
    ),
  }),
);

export type PortalSessionRevocation = typeof portalSessionRevocations.$inferSelect;
