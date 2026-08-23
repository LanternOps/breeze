import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  boolean,
  jsonb,
  pgEnum,
  index
} from 'drizzle-orm/pg-core';
import { users } from './users';
import { organizations } from './orgs';

export const notificationTypeEnum = pgEnum('notification_type', [
  'alert',
  'device',
  'script',
  'automation',
  'system',
  'user',
  'security',
  'ticket',
  // Wave 2 (#3823). 'approval' = a four-eyes decision is waiting on this user;
  // 'ai' = an agent produced something worth a human's attention.
  'approval',
  'ai'
]);

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
  createdAtIdx: index('user_notifications_created_at_idx').on(table.createdAt)
}));
