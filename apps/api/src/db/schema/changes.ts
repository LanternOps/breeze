import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  jsonb,
  pgEnum,
  index,
  uniqueIndex
} from 'drizzle-orm/pg-core';
import { devices } from './devices';
import { organizations } from './orgs';

export const changeTypeEnum = pgEnum('change_type', [
  'software',
  'service',
  'startup',
  'network',
  'scheduled_task',
  'user_account'
]);

export const changeActionEnum = pgEnum('change_action', [
  'added',
  'removed',
  'modified',
  'updated'
]);

export const deviceChangeLog = pgTable('device_change_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  deviceId: uuid('device_id').notNull().references(() => devices.id),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  fingerprint: varchar('fingerprint', { length: 64 }).notNull(),
  timestamp: timestamp('timestamp').notNull(),
  changeType: changeTypeEnum('change_type').notNull(),
  changeAction: changeActionEnum('change_action').notNull(),
  subject: varchar('subject', { length: 500 }).notNull(),
  beforeValue: jsonb('before_value'),
  afterValue: jsonb('after_value'),
  details: jsonb('details'),
  createdAt: timestamp('created_at').defaultNow().notNull()
}, (table) => ({
  deviceIdx: index('device_change_log_device_id_idx').on(table.deviceId),
  orgIdx: index('device_change_log_org_id_idx').on(table.orgId),
  timestampIdx: index('device_change_log_timestamp_idx').on(table.timestamp),
  typeIdx: index('device_change_log_type_idx').on(table.changeType),
  actionIdx: index('device_change_log_action_idx').on(table.changeAction),
  deviceTimeIdx: index('device_change_log_device_time_idx').on(table.deviceId, table.timestamp),
  orgTimeIdx: index('device_change_log_org_time_idx').on(table.orgId, table.timestamp),
  createdAtIdx: index('device_change_log_created_at_idx').on(table.createdAt),
  deviceFingerprintUniqueIdx: uniqueIndex('device_change_log_device_fingerprint_uniq').on(table.deviceId, table.fingerprint)
}));
