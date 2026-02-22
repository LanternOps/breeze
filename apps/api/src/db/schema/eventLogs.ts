import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  jsonb,
  pgEnum,
  index,
  uniqueIndex,
  boolean,
  integer
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { devices } from './devices';
import { organizations } from './orgs';
import { users } from './users';
import { alerts } from './alerts';

export const eventLogLevelEnum = pgEnum('event_log_level',
  ['info', 'warning', 'error', 'critical']);

export const eventLogCategoryEnum = pgEnum('event_log_category',
  ['security', 'hardware', 'application', 'system']);

export const deviceEventLogs = pgTable('device_event_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  deviceId: uuid('device_id').notNull().references(() => devices.id),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  timestamp: timestamp('timestamp', { withTimezone: true }).notNull(),
  level: eventLogLevelEnum('level').notNull(),
  category: eventLogCategoryEnum('category').notNull(),
  source: varchar('source', { length: 255 }).notNull(),
  eventId: varchar('event_id', { length: 100 }),
  message: text('message').notNull(),
  details: jsonb('details').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  deviceIdx: index('device_event_logs_device_idx').on(table.deviceId),
  orgTimestampIdx: index('device_event_logs_org_ts_idx').on(table.orgId, table.timestamp),
  categoryLevelIdx: index('device_event_logs_cat_level_idx').on(table.category, table.level),
  searchVectorIdx: index('device_event_logs_search_vector_idx').using('gin', sql`search_vector`),
  messageTrgmIdx: index('device_event_logs_message_trgm_idx').using('gin', sql`message gin_trgm_ops`),
  sourceTrgmIdx: index('device_event_logs_source_trgm_idx').using('gin', sql`source gin_trgm_ops`),
  deviceSourceEventIdx: uniqueIndex('device_event_logs_dedup_idx').on(table.deviceId, table.source, table.eventId),
}));

export interface SavedLogSearchFilters {
  timeRange?: { start?: string; end?: string };
  level?: Array<typeof eventLogLevelEnum.enumValues[number]>;
  category?: Array<typeof eventLogCategoryEnum.enumValues[number]>;
  query?: string;
  search?: string;
  source?: string;
  deviceIds?: string[];
  siteIds?: string[];
  limit?: number;
  offset?: number;
  sortBy?: 'timestamp' | 'level' | 'device';
  sortOrder?: 'asc' | 'desc';
  countMode?: 'exact' | 'estimated' | 'none';
}

export const logSearchQueries = pgTable('log_search_queries', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  name: varchar('name', { length: 200 }).notNull(),
  description: text('description'),
  filters: jsonb('filters').$type<SavedLogSearchFilters>().notNull(),
  createdBy: uuid('created_by').references(() => users.id),
  isShared: boolean('is_shared').notNull().default(false),
  runCount: integer('run_count').notNull().default(0),
  lastRunAt: timestamp('last_run_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  orgIdIdx: index('log_search_queries_org_id_idx').on(table.orgId),
  createdByIdx: index('log_search_queries_created_by_idx').on(table.createdBy),
}));

export const logCorrelationSeverityEnum = pgEnum('log_correlation_severity', ['info', 'warning', 'error', 'critical']);
export const logCorrelationStatusEnum = pgEnum('log_correlation_status', ['active', 'resolved', 'ignored']);

export const logCorrelationRules = pgTable('log_correlation_rules', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  name: varchar('name', { length: 200 }).notNull(),
  description: text('description'),
  pattern: text('pattern').notNull(),
  isRegex: boolean('is_regex').notNull().default(false),
  minOccurrences: integer('min_occurrences').notNull().default(3),
  minDevices: integer('min_devices').notNull().default(2),
  timeWindow: integer('time_window').notNull().default(300),
  severity: logCorrelationSeverityEnum('severity').notNull().default('warning'),
  alertOnMatch: boolean('alert_on_match').notNull().default(true),
  isActive: boolean('is_active').notNull().default(true),
  lastMatchedAt: timestamp('last_matched_at'),
  createdAt: timestamp('created_at').defaultNow().notNull()
}, (table) => ({
  orgIdIdx: index('log_correlation_rules_org_id_idx').on(table.orgId),
  activeIdx: index('log_correlation_rules_active_idx').on(table.isActive),
}));

export interface LogCorrelationAffectedDevice {
  deviceId: string;
  hostname: string | null;
  count: number;
}

export interface LogCorrelationSampleLog {
  id: string;
  deviceId: string;
  timestamp: string;
  level: typeof eventLogLevelEnum.enumValues[number];
  source: string;
  message: string;
}

export const logCorrelations = pgTable('log_correlations', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  ruleId: uuid('rule_id').notNull().references(() => logCorrelationRules.id),
  pattern: text('pattern').notNull(),
  firstSeen: timestamp('first_seen').notNull(),
  lastSeen: timestamp('last_seen').notNull(),
  occurrences: integer('occurrences').notNull(),
  affectedDevices: jsonb('affected_devices').$type<LogCorrelationAffectedDevice[]>().notNull(),
  sampleLogs: jsonb('sample_logs').$type<LogCorrelationSampleLog[]>(),
  alertId: uuid('alert_id').references(() => alerts.id),
  status: logCorrelationStatusEnum('status').notNull().default('active'),
  resolvedAt: timestamp('resolved_at'),
  resolvedBy: uuid('resolved_by').references(() => users.id),
  notes: text('notes'),
  createdAt: timestamp('created_at').defaultNow().notNull()
}, (table) => ({
  orgIdIdx: index('log_correlations_org_id_idx').on(table.orgId),
  ruleIdIdx: index('log_correlations_rule_id_idx').on(table.ruleId),
  statusIdx: index('log_correlations_status_idx').on(table.status),
}));
