import { pgTable, uuid, varchar, text, timestamp, boolean, jsonb, integer, index } from 'drizzle-orm/pg-core';
import { desc, sql } from 'drizzle-orm';
import { organizations } from './orgs';
import { discoveredAssets } from './discovery';
import { alertSeverityEnum } from './alerts';

export const snmpTemplates = pgTable('snmp_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => organizations.id),
  name: varchar('name', { length: 200 }).notNull(),
  description: text('description'),
  vendor: varchar('vendor', { length: 100 }),
  deviceType: varchar('device_type', { length: 100 }),
  oids: jsonb('oids').notNull(),
  // Enterprise sysObjectID prefixes this template claims, e.g.
  // {'1.3.6.1.4.1.253'} for Xerox (spec §8). Matching is component-boundary
  // aware in services/snmpTemplateSuggest.ts — '1.3.6.1.4.1.25' must never
  // match a '1.3.6.1.4.1.253…' device.
  sysObjectIdPrefixes: text('sys_object_id_prefixes').array().notNull().default(sql`'{}'::text[]`),
  isBuiltIn: boolean('is_built_in').notNull().default(false),
  createdAt: timestamp('created_at').defaultNow().notNull()
}, (table) => ({
  orgIdIdx: index('snmp_templates_org_id_idx').on(table.orgId)
}));

export const snmpDevices = pgTable('snmp_devices', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  assetId: uuid('asset_id').references(() => discoveredAssets.id),
  name: varchar('name', { length: 200 }).notNull(),
  ipAddress: varchar('ip_address', { length: 45 }).notNull(),
  snmpVersion: varchar('snmp_version', { length: 10 }).notNull(),
  port: integer('port').notNull().default(161),
  community: text('community'),
  authProtocol: varchar('auth_protocol', { length: 20 }),
  authPassword: text('auth_password'),
  privProtocol: varchar('priv_protocol', { length: 20 }),
  privPassword: text('priv_password'),
  username: varchar('username', { length: 100 }),
  pollingInterval: integer('polling_interval').notNull().default(300),
  templateId: uuid('template_id').references(() => snmpTemplates.id),
  isActive: boolean('is_active').notNull().default(true),
  lastPolled: timestamp('last_polled'),
  // Stamped at dispatch regardless of outcome; the scheduler's due-check runs
  // off this so never-succeeding devices still honour pollingInterval (#3217).
  lastPollAttemptedAt: timestamp('last_poll_attempted_at'),
  // Incremented at dispatch, cleared only when results are persisted. Drives
  // exponential backoff of the effective polling interval (#3217).
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  lastStatus: varchar('last_status', { length: 20 }),
  lastError: text('last_error'),
  lastErrorAt: timestamp('last_error_at', { withTimezone: true }),
  // W01 (spec §7.1) — monotonic dispatch counter. W02 gates `cadence: 'slow'`
  // OID specs on `poll_seq % SLOW_CADENCE_EVERY === 0`. Unused in W01.
  pollSeq: integer('poll_seq').notNull().default(0),
  createdAt: timestamp('created_at').defaultNow().notNull()
});

export const snmpMetrics = pgTable('snmp_metrics', {
  id: uuid('id').primaryKey().defaultRandom(),
  deviceId: uuid('device_id').notNull().references(() => snmpDevices.id),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  oid: varchar('oid', { length: 200 }).notNull(),
  // W01 (spec §7.2/§7.3) — for a walked table column, `oid` is the fully
  // qualified instance OID and `base_oid` is the column it belongs to.
  // NULL on every legacy-agent row; readers COALESCE(base_oid, oid).
  baseOid: varchar('base_oid', { length: 200 }),
  instance: varchar('instance', { length: 64 }),
  name: varchar('name', { length: 100 }).notNull(),
  value: text('value'),
  // 'null' | 'number' | 'string' | 'object' | 'error'. An 'error' row carries
  // value = NULL and a code in `error`.
  valueType: varchar('value_type', { length: 20 }),
  // noSuchObject | noSuchInstance | endOfMib | timeout | truncated
  error: varchar('error', { length: 32 }),
  timestamp: timestamp('timestamp').notNull().defaultNow()
}, (table) => ({
  deviceIdIdx: index('snmp_metrics_device_id_idx').on(table.deviceId),
  oidIdx: index('snmp_metrics_oid_idx').on(table.oid),
  timestampIdx: index('snmp_metrics_timestamp_idx').on(table.timestamp),
  // W01 (spec §7.5) — serves GET /monitoring/assets/:id/metrics.
  deviceOidTsIdx: index('snmp_metrics_device_oid_ts_idx').on(table.deviceId, table.oid, desc(table.timestamp))
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
