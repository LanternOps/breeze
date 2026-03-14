import { pgTable, pgEnum, uuid, varchar, timestamp, boolean, jsonb, integer, real, index } from 'drizzle-orm/pg-core';
import { organizations } from './orgs';
import { devices } from './devices';
import { monitoringWatchTypeEnum } from './configurationPolicies';

export const checkResultStatusEnum = pgEnum('check_result_status', ['running', 'stopped', 'not_found', 'error']);

export const serviceProcessCheckResults = pgTable('service_process_check_results', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  deviceId: uuid('device_id').notNull().references(() => devices.id),
  watchType: monitoringWatchTypeEnum('watch_type').notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  status: checkResultStatusEnum('status').notNull(),
  cpuPercent: real('cpu_percent'),
  memoryMb: real('memory_mb'),
  pid: integer('pid'),
  details: jsonb('details'),
  autoRestartAttempted: boolean('auto_restart_attempted').notNull().default(false),
  autoRestartSucceeded: boolean('auto_restart_succeeded'),
  timestamp: timestamp('timestamp').notNull().defaultNow(),
}, (table) => ({
  orgIdIdx: index('spc_results_org_id_idx').on(table.orgId),
  deviceIdIdx: index('spc_results_device_id_idx').on(table.deviceId),
  deviceNameTimestampIdx: index('spc_results_device_name_ts_idx').on(table.deviceId, table.name, table.timestamp),
}));
