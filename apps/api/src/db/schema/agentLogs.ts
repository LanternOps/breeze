import { pgTable, uuid, varchar, text, timestamp, jsonb, pgEnum, index } from 'drizzle-orm/pg-core';
import { devices } from './devices';
import { organizations } from './orgs';

export const agentLogLevelEnum = pgEnum('agent_log_level',
  ['debug', 'info', 'warn', 'error']);

export const agentLogs = pgTable('agent_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  deviceId: uuid('device_id').notNull().references(() => devices.id),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  timestamp: timestamp('timestamp').notNull(),
  level: agentLogLevelEnum('level').notNull(),
  component: varchar('component', { length: 100 }).notNull(),
  message: text('message').notNull(),
  fields: jsonb('fields'),
  agentVersion: varchar('agent_version', { length: 50 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  deviceIdx: index('agent_logs_device_idx').on(table.deviceId),
  orgTimestampIdx: index('agent_logs_org_ts_idx').on(table.orgId, table.timestamp),
  levelComponentIdx: index('agent_logs_level_component_idx').on(table.level, table.component),
  timestampIdx: index('agent_logs_timestamp_idx').on(table.timestamp),
}));
