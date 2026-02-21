import { pgTable, uuid, timestamp, bigint, jsonb, index, integer, real, pgEnum } from 'drizzle-orm/pg-core';
import { devices } from './devices';
import { organizations } from './orgs';

export type ReliabilityCrashEvent = {
  type: 'bsod' | 'kernel_panic' | 'system_crash' | 'oom_kill' | 'unknown';
  timestamp: string;
  details?: Record<string, unknown>;
};

export type ReliabilityAppHang = {
  processName: string;
  timestamp: string;
  duration: number;
  resolved: boolean;
};

export type ReliabilityServiceFailure = {
  serviceName: string;
  timestamp: string;
  errorCode?: string;
  recovered: boolean;
};

export type ReliabilityHardwareError = {
  type: 'mce' | 'disk' | 'memory' | 'unknown';
  severity: 'critical' | 'error' | 'warning';
  timestamp: string;
  source: string;
  eventId?: string;
};

export type ReliabilityTopIssue = {
  type: 'crashes' | 'hangs' | 'services' | 'hardware' | 'uptime';
  count: number;
  severity: 'critical' | 'error' | 'warning' | 'info';
  lastOccurrence?: string;
};

export const trendDirectionEnum = pgEnum('trend_direction', ['improving', 'stable', 'degrading']);

export const deviceReliabilityHistory = pgTable('device_reliability_history', {
  id: uuid('id').primaryKey().defaultRandom(),
  deviceId: uuid('device_id').notNull().references(() => devices.id),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  collectedAt: timestamp('collected_at').defaultNow().notNull(),
  uptimeSeconds: bigint('uptime_seconds', { mode: 'number' }).notNull(),
  bootTime: timestamp('boot_time').notNull(),
  crashEvents: jsonb('crash_events').$type<ReliabilityCrashEvent[]>().notNull().default([]),
  appHangs: jsonb('app_hangs').$type<ReliabilityAppHang[]>().notNull().default([]),
  serviceFailures: jsonb('service_failures').$type<ReliabilityServiceFailure[]>().notNull().default([]),
  hardwareErrors: jsonb('hardware_errors').$type<ReliabilityHardwareError[]>().notNull().default([]),
  rawMetrics: jsonb('raw_metrics').$type<Record<string, unknown>>().notNull().default({})
}, (table) => ({
  deviceCollectedIdx: index('reliability_history_device_collected_idx').on(table.deviceId, table.collectedAt),
  orgCollectedIdx: index('reliability_history_org_collected_idx').on(table.orgId, table.collectedAt)
}));

export const deviceReliability = pgTable('device_reliability', {
  deviceId: uuid('device_id').primaryKey().references(() => devices.id),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  computedAt: timestamp('computed_at').defaultNow().notNull(),

  reliabilityScore: integer('reliability_score').notNull(),

  uptimeScore: integer('uptime_score').notNull(),
  crashScore: integer('crash_score').notNull(),
  hangScore: integer('hang_score').notNull(),
  serviceFailureScore: integer('service_failure_score').notNull(),
  hardwareErrorScore: integer('hardware_error_score').notNull(),

  uptime7d: real('uptime_7d').notNull(),
  uptime30d: real('uptime_30d').notNull(),
  uptime90d: real('uptime_90d').notNull(),

  crashCount7d: integer('crash_count_7d').notNull().default(0),
  crashCount30d: integer('crash_count_30d').notNull().default(0),
  crashCount90d: integer('crash_count_90d').notNull().default(0),

  hangCount7d: integer('hang_count_7d').notNull().default(0),
  hangCount30d: integer('hang_count_30d').notNull().default(0),

  serviceFailureCount7d: integer('service_failure_count_7d').notNull().default(0),
  serviceFailureCount30d: integer('service_failure_count_30d').notNull().default(0),

  hardwareErrorCount7d: integer('hardware_error_count_7d').notNull().default(0),
  hardwareErrorCount30d: integer('hardware_error_count_30d').notNull().default(0),

  mtbfHours: real('mtbf_hours'),

  trendDirection: trendDirectionEnum('trend_direction').notNull(),
  trendConfidence: real('trend_confidence').notNull().default(0),

  topIssues: jsonb('top_issues').$type<ReliabilityTopIssue[]>().notNull().default([]),
  details: jsonb('details').$type<Record<string, unknown>>().notNull().default({})
}, (table) => ({
  orgScoreIdx: index('reliability_org_score_idx').on(table.orgId, table.reliabilityScore),
  scoreIdx: index('reliability_score_idx').on(table.reliabilityScore),
  trendIdx: index('reliability_trend_idx').on(table.trendDirection)
}));
