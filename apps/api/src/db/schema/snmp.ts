import { pgTable, uuid, varchar, text, timestamp, boolean, jsonb, integer, index } from 'drizzle-orm/pg-core';
import { organizations } from './orgs';
import { discoveredAssets } from './discovery';
import { alertSeverityEnum } from './alerts';

export const snmpTemplates = pgTable('snmp_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 200 }).notNull(),
  description: text('description'),
  vendor: varchar('vendor', { length: 100 }),
  deviceType: varchar('device_type', { length: 100 }),
  oids: jsonb('oids').notNull(),
  isBuiltIn: boolean('is_built_in').notNull().default(false),
  createdAt: timestamp('created_at').defaultNow().notNull()
});

export const snmpDevices = pgTable('snmp_devices', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  assetId: uuid('asset_id').references(() => discoveredAssets.id),
  name: varchar('name', { length: 200 }).notNull(),
  ipAddress: varchar('ip_address', { length: 45 }).notNull(),
  snmpVersion: varchar('snmp_version', { length: 10 }).notNull(),
  port: integer('port').notNull().default(161),
  community: varchar('community', { length: 100 }),
  authProtocol: varchar('auth_protocol', { length: 20 }),
  authPassword: text('auth_password'),
  privProtocol: varchar('priv_protocol', { length: 20 }),
  privPassword: text('priv_password'),
  username: varchar('username', { length: 100 }),
  pollingInterval: integer('polling_interval').notNull().default(300),
  templateId: uuid('template_id').references(() => snmpTemplates.id),
  isActive: boolean('is_active').notNull().default(true),
  lastPolled: timestamp('last_polled'),
  lastStatus: varchar('last_status', { length: 20 }),
  createdAt: timestamp('created_at').defaultNow().notNull()
});

export const snmpMetrics = pgTable('snmp_metrics', {
  id: uuid('id').primaryKey().defaultRandom(),
  deviceId: uuid('device_id').notNull().references(() => snmpDevices.id),
  oid: varchar('oid', { length: 200 }).notNull(),
  name: varchar('name', { length: 100 }).notNull(),
  value: text('value'),
  valueType: varchar('value_type', { length: 20 }),
  timestamp: timestamp('timestamp').notNull().defaultNow()
}, (table) => ({
  deviceIdIdx: index('snmp_metrics_device_id_idx').on(table.deviceId),
  oidIdx: index('snmp_metrics_oid_idx').on(table.oid),
  timestampIdx: index('snmp_metrics_timestamp_idx').on(table.timestamp)
}));

export const snmpAlertThresholds = pgTable('snmp_alert_thresholds', {
  id: uuid('id').primaryKey().defaultRandom(),
  deviceId: uuid('device_id').notNull().references(() => snmpDevices.id),
  oid: varchar('oid', { length: 200 }).notNull(),
  operator: varchar('operator', { length: 10 }),
  threshold: varchar('threshold', { length: 100 }),
  severity: alertSeverityEnum('severity').notNull(),
  message: text('message'),
  isActive: boolean('is_active').notNull().default(true)
});
