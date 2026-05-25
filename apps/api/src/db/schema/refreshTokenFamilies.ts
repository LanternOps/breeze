import { pgTable, uuid, varchar, timestamp, index } from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * Refresh-token families — OAuth 2.1 token-reuse detection (RFC 9700).
 *
 * Each /login mints a fresh familyId and embeds it in the refresh token's
 * `fam` claim. Every subsequent /refresh inherits the same family on the
 * newly-minted refresh token, forming a chain rooted at the original login.
 *
 * If a revoked refresh-token JTI is presented again (token reuse), the
 * entire family is revoked: a `revoked_at` timestamp is set on the DB row
 * AND a Redis sentinel is flipped (`refresh-fam-revoked:<familyId>`). Every
 * subsequent /refresh against ANY descendant of that family returns 401
 * regardless of which side of the race held the most-recent valid token.
 *
 * Without this, an attacker who steals a refresh cookie and races the
 * legitimate user wins the race outright: rotation only invalidates the
 * *previous* jti, so whichever side refreshes second gets one rejection
 * while the other holds a fully-valid parallel session.
 *
 * RLS: Shape 6 (user-id scoped) — see migration
 * `2026-05-25-e-refresh-token-families.sql`. Policy predicate is
 * `user_id = breeze_current_user_id()`. System-initiated revocation paths
 * (the reuse-detection branch in `/refresh`) use `withSystemDbAccessContext`
 * to bypass; user-driven rotation paths already pass under the user scope.
 */
export const refreshTokenFamilies = pgTable(
  'refresh_token_families',
  {
    familyId: uuid('family_id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedReason: varchar('revoked_reason', { length: 64 }),
  },
  (t) => ({
    userIdx: index('refresh_token_families_user_idx').on(t.userId),
  })
);

export type RefreshTokenFamily = typeof refreshTokenFamilies.$inferSelect;
export type NewRefreshTokenFamily = typeof refreshTokenFamilies.$inferInsert;
