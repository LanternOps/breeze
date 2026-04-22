import { pgTable, uuid, text, timestamp } from 'drizzle-orm/pg-core';
import { partners } from './orgs';

export const partnerActivations = pgTable('partner_activations', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id')
    .notNull()
    .references(() => partners.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type PartnerActivation = typeof partnerActivations.$inferSelect;
export type NewPartnerActivation = typeof partnerActivations.$inferInsert;
