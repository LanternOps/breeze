import { pgTable, uuid, varchar, timestamp, index } from 'drizzle-orm/pg-core';
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
