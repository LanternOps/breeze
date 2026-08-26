import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  boolean,
  jsonb,
  pgEnum,
  index,
  uniqueIndex
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { NOTIFICATION_TYPES } from '@breeze/shared';
import { users } from './users';
import { organizations } from './orgs';

// Single-sourced from @breeze/shared (same pattern as alerts.ts /
// NOTIFICATION_CHANNEL_TYPES) so API validation, web rendering, and this
// column type can never drift. Wave 2 (#3823) added 'approval' (= a four-eyes
// decision is waiting on this user) and 'ai' (= an agent produced something
// worth a human's attention). Note the DB enum's actual value order comes
// from the migrations — this array only types the TS side.
export const notificationTypeEnum = pgEnum('notification_type', NOTIFICATION_TYPES);

export const notificationPriorityEnum = pgEnum('notification_priority', [
  'low',
  'normal',
  'high',
  'urgent'
]);

export const userNotifications = pgTable('user_notifications', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }),
  type: notificationTypeEnum('type').notNull(),
  priority: notificationPriorityEnum('priority').notNull().default('normal'),
  title: varchar('title', { length: 255 }).notNull(),
  message: text('message'),
  link: varchar('link', { length: 500 }),
  metadata: jsonb('metadata'),
  /**
   * Idempotency key for producers that can redeliver. The outbox publisher
   * marks a row published on ENQUEUE rather than on completion, and BullMQ
   * retries, so one intent can otherwise notify the same approver repeatedly.
   * NULL (the default, and what every pre-wave-2 producer writes) opts out —
   * the unique index is partial.
   */
  dedupeKey: text('dedupe_key'),
  read: boolean('read').notNull().default(false),
  readAt: timestamp('read_at'),
  createdAt: timestamp('created_at').defaultNow().notNull()
}, (table) => ({
  userIdIdx: index('user_notifications_user_id_idx').on(table.userId),
  userReadIdx: index('user_notifications_user_read_idx').on(table.userId, table.read),
  createdAtIdx: index('user_notifications_created_at_idx').on(table.createdAt),
  // Declared here to match what the database actually has. The index shipped in
  // 2026-09-04-ai-agent-notifications.sql but was never mirrored into this
  // definition, and db:check-drift does not compare the model against a live
  // database — so the omission stayed invisible. This declaration DOCUMENTS the
  // database object; it does not create it (drizzle-kit generate/push are not
  // used here). The migration's index is what makes `dedupeKey` enforceable.
  userDedupeKeyUq: uniqueIndex('user_notifications_user_dedupe_key_uq')
    .on(table.userId, table.dedupeKey)
    .where(sql`${table.dedupeKey} IS NOT NULL`)
}));
