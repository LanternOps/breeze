import { pgTable, pgEnum, uuid, varchar, text, timestamp, boolean, jsonb, integer, index, real } from 'drizzle-orm/pg-core';
import { organizations } from './orgs';
import { discoveredAssets } from './discovery';
import { alertSeverityEnum } from './alerts';

export const monitorTypeEnum = pgEnum('monitor_type', ['icmp_ping', 'tcp_port', 'http_check', 'dns_check']);
export const monitorStatusEnum = pgEnum('monitor_status', ['online', 'offline', 'degraded', 'unknown']);

export const networkMonitors = pgTable('network_monitors', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  assetId: uuid('asset_id').references(() => discoveredAssets.id),
  name: varchar('name', { length: 200 }).notNull(),
  monitorType: monitorTypeEnum('monitor_type').notNull(),
  target: varchar('target', { length: 500 }).notNull(),
  config: jsonb('config').notNull().default({}),
  pollingInterval: integer('polling_interval').notNull().default(60),
  timeout: integer('timeout').notNull().default(5),
  isActive: boolean('is_active').notNull().default(true),
  lastChecked: timestamp('last_checked'),
  lastStatus: monitorStatusEnum('last_status').notNull().default('unknown'),
  lastResponseMs: real('last_response_ms'),
  lastError: text('last_error'),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (table) => ({
  orgIdIdx: index('network_monitors_org_id_idx').on(table.orgId),
  monitorTypeIdx: index('network_monitors_monitor_type_idx').on(table.monitorType),
  isActiveIdx: index('network_monitors_is_active_idx').on(table.isActive)
}));

export const networkMonitorResults = pgTable('network_monitor_results', {
  id: uuid('id').primaryKey().defaultRandom(),
  monitorId: uuid('monitor_id').notNull().references(() => networkMonitors.id, { onDelete: 'cascade' }),
  status: monitorStatusEnum('status').notNull(),
  responseMs: real('response_ms'),
  statusCode: integer('status_code'),
  error: text('error'),
  details: jsonb('details'),
  timestamp: timestamp('timestamp').notNull().defaultNow()
}, (table) => ({
  monitorIdIdx: index('network_monitor_results_monitor_id_idx').on(table.monitorId),
  timestampIdx: index('network_monitor_results_timestamp_idx').on(table.timestamp)
}));

export const networkMonitorAlertRules = pgTable('network_monitor_alert_rules', {
  id: uuid('id').primaryKey().defaultRandom(),
  monitorId: uuid('monitor_id').notNull().references(() => networkMonitors.id, { onDelete: 'cascade' }),
  condition: varchar('condition', { length: 50 }).notNull(),
  threshold: varchar('threshold', { length: 100 }),
  severity: alertSeverityEnum('severity').notNull(),
  message: text('message'),
  isActive: boolean('is_active').notNull().default(true)
});
