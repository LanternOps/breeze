import { pgTable, uuid, text, timestamp, pgEnum, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';
import { organizations } from './orgs';

export const accountDeletionRequestStatusEnum = pgEnum('account_deletion_request_status', [
  'pending',
  'processing',
  'completed',
  'cancelled',
]);

/**
 * User-initiated account deletion requests.
 *
 * Created by users from the public /account/delete page (linked from the
 * mobile app to satisfy Apple App Store account-deletion requirements).
 * A back-office worker / admin processes the queue asynchronously — this
 * table only records the request, it does NOT delete user data.
 *
 * RLS: Shape 6 (user-id scoped) — see migration
 * `2026-05-07-account-deletion-requests.sql`. Policy predicate is
 * `user_id = breeze_current_user_id()`.
 */
export const accountDeletionRequests = pgTable(
  'account_deletion_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    // Denormalised tenant attribution; nullable because partner-level staff
    // (users.org_id IS NULL) can also request deletion.
    orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'set null' }),
    reason: text('reason'),
    status: accountDeletionRequestStatusEnum('status').notNull().default('pending'),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    processBy: timestamp('process_by', { withTimezone: true }).notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    processedBy: uuid('processed_by').references(() => users.id, { onDelete: 'set null' }),
    adminNote: text('admin_note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userPendingUniq: uniqueIndex('account_deletion_requests_user_pending_uniq')
      .on(t.userId)
      .where(sql`status = 'pending'`),
    statusIdx: index('account_deletion_requests_status_idx').on(t.status, t.processBy),
    orgIdx: index('account_deletion_requests_org_idx')
      .on(t.orgId)
      .where(sql`org_id IS NOT NULL`),
  })
);

export type AccountDeletionRequest = typeof accountDeletionRequests.$inferSelect;
export type NewAccountDeletionRequest = typeof accountDeletionRequests.$inferInsert;
