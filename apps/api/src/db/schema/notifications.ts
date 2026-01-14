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
  'security'
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
  read: boolean('read').notNull().default(false),
  readAt: timestamp('read_at'),
  createdAt: timestamp('created_at').defaultNow().notNull()
}, (table) => ({
  userIdIdx: index('user_notifications_user_id_idx').on(table.userId),
  userReadIdx: index('user_notifications_user_read_idx').on(table.userId, table.read),
  createdAtIdx: index('user_notifications_created_at_idx').on(table.createdAt)
}));
