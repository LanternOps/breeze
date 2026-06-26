import { pgTable, uuid, varchar, text, integer, boolean, timestamp, index } from 'drizzle-orm/pg-core';
import { partners } from './orgs';
import { users } from './users';

/** Partner-wide library of reusable ticket reply templates (canned responses).
 *  RLS shape #3 (partner-axis). `createdBy` is audit-only — NOT a scope axis;
 *  it leaves room for personal snippets later via an isPersonal flag. */
export const ticketResponseTemplates = pgTable('ticket_response_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  name: varchar('name', { length: 200 }).notNull(),
  body: text('body').notNull(),
  category: varchar('category', { length: 100 }),
  sortOrder: integer('sort_order').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => [index('ticket_response_templates_partner_idx').on(t.partnerId)]);
