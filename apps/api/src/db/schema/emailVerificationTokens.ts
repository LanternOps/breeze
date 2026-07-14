import { pgTable, uuid, varchar, timestamp, integer, index } from 'drizzle-orm/pg-core';
import { partners } from './orgs';
import { users } from './users';

// Single-use, partner-scoped tokens emitted on signup. The verification
// endpoint runs in system scope (pre-login) and looks up the row by
// hashed token, then stamps `consumed_at` and `partners.email_verified_at`.
export const emailVerificationTokens = pgTable(
  'email_verification_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tokenHash: varchar('token_hash', { length: 64 }).notNull().unique(),
    partnerId: uuid('partner_id')
      .notNull()
      .references(() => partners.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    email: varchar('email', { length: 255 }).notNull(),
    // users.email_epoch at mint time (#2428). Consume requires it to still
    // match the live user row, so a link issued for a PRIOR address cannot be
    // redeemed after the address moves. NULL on rows minted before the
    // 2026-07-16 migration — those fall back to the exact-address match.
    emailEpoch: integer('email_epoch'),
    // 'signup' (prove the address on a new partner — the historical behaviour,
    // and the default for every pre-2026-07-18 row) or 'email_change' (prove
    // control of users.pending_email, then swap it in). consumeVerificationToken
    // branches on this; the two branches check DIFFERENT live-row columns.
    purpose: varchar('purpose', { length: 32 }).notNull().default('signup'),
    expiresAt: timestamp('expires_at').notNull(),
    consumedAt: timestamp('consumed_at'),
    // Stamped when a later resend invalidates this still-live token, so
    // the verify endpoint can return 'superseded' (a newer link was sent)
    // distinct from 'consumed' (the user already used this link).
    supersededAt: timestamp('superseded_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => ({
    partnerIdx: index('email_verification_tokens_partner_idx').on(t.partnerId),
    userIdx: index('email_verification_tokens_user_idx').on(t.userId),
  })
);
