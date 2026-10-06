import { sql } from 'drizzle-orm';
import { index, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { partners } from './orgs';
import { users } from './users';

/**
 * AI Suggested Fixes W2 — reviewed generic manual steps (partner-axis, RLS
 * shape 3). The ONLY source of manual-steps fix identities that can aggregate
 * into shareable fix memory. Written only by services/fixMemory/instructions.ts.
 */
export const fixInstructions = pgTable('fix_instructions', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id, { onDelete: 'cascade' }),
  title: varchar('title', { length: 160 }).notNull(),
  steps: text('steps').array().notNull(),
  osType: varchar('os_type', { length: 20 }).$type<'windows' | 'macos' | 'linux'>(),
  reviewedBy: uuid('reviewed_by').references(() => users.id, { onDelete: 'set null' }),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }).defaultNow().notNull(),
  retiredAt: timestamp('retired_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  partnerIdx: index('fix_instructions_partner_idx').on(t.partnerId).where(sql`retired_at IS NULL`),
}));
export type FixInstructionsRow = typeof fixInstructions.$inferSelect;
