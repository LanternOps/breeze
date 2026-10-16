import { pgTable, uuid, timestamp, bigint, jsonb, index, integer, real, pgEnum, text, foreignKey, check, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { devices } from './devices';
import { organizations } from './orgs';
import { users } from './users';

export type ReliabilityCrashEvent = {
  // app_crash = a per-app crash report (macOS), counted toward the crash factor
  // at reduced weight vs. a whole-device crash (bsod / kernel_panic).
  type: 'bsod' | 'kernel_panic' | 'system_crash' | 'oom_kill' | 'app_crash' | 'unknown';
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
  type: 'mce' | 'disk' | 'memory' | 'thermal' | 'unknown';
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
  deviceId: uuid('device_id').notNull().references(() => devices.id, { onDelete: 'cascade' }),
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
  deviceId: uuid('device_id').primaryKey().references(() => devices.id, { onDelete: 'cascade' }),
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
  hangCount90d: integer('hang_count_90d').notNull().default(0),

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

export const RELIABILITY_BASELINE_REASON_VALUES = ['reimaged', 'remediated', 'hardware_replaced'] as const;
export const RELIABILITY_BASELINE_SOURCE_VALUES = ['manual', 'bare_metal_recovery'] as const;

// #5876 baseline markers. SQL migration is authoritative for DEFERRABLE INITIALLY
// IMMEDIATE (Drizzle has no deferrability builder — same as device_time_daily).
export const deviceReliabilityBaselines = pgTable(
  'device_reliability_baselines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    deviceId: uuid('device_id').notNull(),
    baselineAt: timestamp('baseline_at', { withTimezone: true }).notNull(),
    reason: text('reason').$type<(typeof RELIABILITY_BASELINE_REASON_VALUES)[number]>().notNull(),
    source: text('source').$type<(typeof RELIABILITY_BASELINE_SOURCE_VALUES)[number]>().notNull().default('manual'),
    sourceRef: uuid('source_ref'),
    note: text('note'),
    beforeSnapshot: jsonb('before_snapshot').$type<Record<string, unknown>>(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    clearedAt: timestamp('cleared_at', { withTimezone: true }),
    clearedBy: uuid('cleared_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [
    foreignKey({
      columns: [t.deviceId, t.orgId],
      foreignColumns: [devices.id, devices.orgId],
      name: 'device_reliability_baselines_device_org_fkey',
    }).onUpdate('cascade').onDelete('cascade'),
    index('device_reliability_baselines_active_idx')
      .on(t.deviceId, t.baselineAt.desc(), t.createdAt.desc())
      .where(sql`${t.clearedAt} IS NULL`),
    index('device_reliability_baselines_org_idx').on(t.orgId),
    uniqueIndex('device_reliability_baselines_source_ref_uq')
      .on(t.deviceId, t.sourceRef)
      .where(sql`${t.sourceRef} IS NOT NULL`),
    check('device_reliability_baselines_reason_check', sql`${t.reason} IN ('reimaged', 'remediated', 'hardware_replaced')`),
    check('device_reliability_baselines_source_check', sql`${t.source} IN ('manual', 'bare_metal_recovery')`),
    check(
      'device_reliability_baselines_note_check',
      sql`NOT (${t.reason} = 'remediated' AND ${t.source} = 'manual') OR (${t.note} IS NOT NULL AND length(btrim(${t.note})) > 0)`,
    ),
  ],
);

export type DeviceReliabilityBaselineRow = typeof deviceReliabilityBaselines.$inferSelect;
