import { pgTable, uuid, varchar, text, timestamp, jsonb, pgEnum, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { devices } from './devices';
import { organizations } from './orgs';

export const eventLogLevelEnum = pgEnum('event_log_level',
  ['info', 'warning', 'error', 'critical']);

export const eventLogCategoryEnum = pgEnum('event_log_category',
  ['security', 'hardware', 'application', 'system']);

export const deviceEventLogs = pgTable('device_event_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  deviceId: uuid('device_id').notNull().references(() => devices.id),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  timestamp: timestamp('timestamp').notNull(),
  level: eventLogLevelEnum('level').notNull(),
  category: eventLogCategoryEnum('category').notNull(),
  source: varchar('source', { length: 255 }).notNull(),
  eventId: varchar('event_id', { length: 100 }),
  message: text('message').notNull(),
  details: jsonb('details'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  deviceIdx: index('device_event_logs_device_idx').on(table.deviceId),
  orgTimestampIdx: index('device_event_logs_org_ts_idx').on(table.orgId, table.timestamp),
  categoryLevelIdx: index('device_event_logs_cat_level_idx').on(table.category, table.level),
  deviceSourceEventIdx: uniqueIndex('device_event_logs_dedup_idx').on(table.deviceId, table.source, table.eventId),
}));
