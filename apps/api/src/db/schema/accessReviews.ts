import { pgTable, uuid, varchar, text, timestamp, pgEnum } from 'drizzle-orm/pg-core';
import { partners, organizations } from './orgs';
import { users, roles } from './users';

export const accessReviewStatusEnum = pgEnum('access_review_status', ['pending', 'in_progress', 'completed']);
export const accessReviewDecisionEnum = pgEnum('access_review_decision', ['pending', 'approved', 'revoked']);

export const accessReviews = pgTable('access_reviews', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').references(() => partners.id),
  orgId: uuid('org_id').references(() => organizations.id),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  status: accessReviewStatusEnum('status').notNull().default('pending'),
  reviewerId: uuid('reviewer_id').references(() => users.id),
  dueDate: timestamp('due_date'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  completedAt: timestamp('completed_at')
});

export const accessReviewItems = pgTable('access_review_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  reviewId: uuid('review_id').notNull().references(() => accessReviews.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id),
  roleId: uuid('role_id').notNull().references(() => roles.id),
  decision: accessReviewDecisionEnum('decision').notNull().default('pending'),
  notes: text('notes'),
  reviewedAt: timestamp('reviewed_at'),
  reviewedBy: uuid('reviewed_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull()
});
