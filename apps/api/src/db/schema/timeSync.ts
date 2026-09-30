import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  bigint,
  integer,
  boolean,
  jsonb,
  timestamp,
  foreignKey,
  index,
  check,
  date,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { devices } from './devices';
import { organizations } from './orgs';
import type {
  TimeSyncHealth,
  TimeSyncFindingCode,
  TimeStatusSnapshot,
  TimeSyncType,
  TimeSyncServiceState,
  TimeSyncServiceStartType,
  TimeSyncStatusMethod,
  TimeSyncSourceKind,
  TimeSyncJoinType,
  TimeSyncDomainRole,
  TimeSyncAutoUpdate,
  TimeSyncEnforcementState,
} from '@breeze/shared';
export const deviceTimeStatus = pgTable(
  'device_time_status',
  {
    deviceId: uuid('device_id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    lastSequence: bigint('last_sequence', { mode: 'number' })
      .notNull()
      .default(0),
    collectedAt: timestamp('collected_at', { withTimezone: true }).notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    agentVersion: text('agent_version'),
    health: text('health').$type<TimeSyncHealth>().notNull().default('unknown'),
    findings: text('findings')
      .$type<TimeSyncFindingCode>()
      .array()
      .notNull()
      .default([]),
    findingDetails: jsonb('finding_details')
      .$type<
        Partial<
          Record<TimeSyncFindingCode, Record<string, string | number | null>>
        >
      >()
      .notNull()
      .default({}),
    syncType: text('sync_type').$type<TimeSyncType>(),
    ntpServer: text('ntp_server'),
    specialPollIntervalSeconds: integer('special_poll_interval_seconds'),
    policyManaged: boolean('policy_managed').notNull().default(false),
    policyManagedValues: text('policy_managed_values')
      .array()
      .notNull()
      .default([]),
    serviceState: text('service_state')
      .$type<TimeSyncServiceState>()
      .notNull()
      .default('unknown'),
    serviceStartType: text('service_start_type')
      .$type<TimeSyncServiceStartType>()
      .notNull()
      .default('unknown'),
    hostTimeProviderEnabled: boolean('host_time_provider_enabled'),
    statusMethod: text('status_method')
      .$type<TimeSyncStatusMethod>()
      .notNull()
      .default('unavailable'),
    source: text('source'),
    sourceKind: text('source_kind')
      .$type<TimeSyncSourceKind>()
      .notNull()
      .default('unknown'),
    lastSuccessfulSyncAt: timestamp('last_successful_sync_at', {
      withTimezone: true,
    }),
    lastSyncError: text('last_sync_error'),
    stratum: integer('stratum'),
    pollIntervalSeconds: integer('poll_interval_seconds'),
    joinType: text('join_type')
      .$type<TimeSyncJoinType>()
      .notNull()
      .default('unknown'),
    domainRole: text('domain_role')
      .$type<TimeSyncDomainRole>()
      .notNull()
      .default('unknown'),
    domainDns: text('domain_dns'),
    forestDns: text('forest_dns'),
    pdcName: text('pdc_name'),
    timezoneWindowsId: text('timezone_windows_id'),
    timezoneBiasMinutes: integer('timezone_bias_minutes'),
    timezoneAutoUpdate: text('timezone_auto_update')
      .$type<TimeSyncAutoUpdate>()
      .notNull()
      .default('unknown'),
    expectedTimezone: text('expected_timezone'),
    expectedTimezoneWindowsId: text('expected_timezone_windows_id'),
    expectedTimezoneSource: text('expected_timezone_source'),
    eventMarks: jsonb('event_marks')
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    recentEvents: jsonb('recent_events')
      .$type<Array<Omit<TimeStatusSnapshot['events'][number], 'properties'>>>()
      .notNull()
      .default([]),
    findingStreaks: jsonb('finding_streaks')
      .$type<
        Partial<Record<TimeSyncFindingCode, { present: number; absent: number }>>
      >()
      .notNull()
      .default({}),
    enforcement: jsonb('enforcement')
      .$type<TimeSyncEnforcementState | Record<string, never>>()
      .notNull()
      .default({}),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.deviceId, t.orgId],
      foreignColumns: [devices.id, devices.orgId],
      name: 'device_time_status_device_org_fkey',
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    check(
      'device_time_status_health_check',
      sql`${t.health} IN ('healthy','warning','critical','unknown')`,
    ),
    index('device_time_status_org_health_idx').on(t.orgId, t.health),
    index('device_time_status_org_domain_idx').on(
      t.orgId,
      t.domainDns,
      t.domainRole,
    ),
    index('device_time_status_findings_gin').using('gin', t.findings),
  ],
);

export const deviceTimeDaily = pgTable(
  'device_time_daily',
  {
    deviceId: uuid('device_id').notNull(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    day: date('day', { mode: 'string' }).notNull(),
    worstHealth: text('worst_health')
      .$type<TimeSyncHealth>()
      .notNull()
      .default('unknown'),
    findingCodes: text('finding_codes')
      .array()
      .$type<TimeSyncFindingCode[]>()
      .notNull()
      .default([]),
    source: text('source'),
    sourceKind: text('source_kind'),
    syncType: text('sync_type'),
    lastSuccessfulSyncAt: timestamp('last_successful_sync_at', {
      withTimezone: true,
    }),
    snapshotCount: integer('snapshot_count').notNull().default(0),
    expectedTimezone: text('expected_timezone'),
    timezoneWindowsId: text('timezone_windows_id'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.deviceId, t.day] }),
    // SQL is authoritative for DEFERRABLE INITIALLY IMMEDIATE; Drizzle has no
    // deferrability builder (same as device_time_status / hardwareHealth).
    foreignKey({
      columns: [t.deviceId, t.orgId],
      foreignColumns: [devices.id, devices.orgId],
      name: 'device_time_daily_device_org_fkey',
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    index('device_time_daily_org_day_idx').on(t.orgId, t.day),
    check(
      'device_time_daily_worst_health_check',
      sql`${t.worstHealth} IN ('healthy','warning','critical','unknown')`,
    ),
    check(
      'device_time_daily_snapshot_count_check',
      sql`${t.snapshotCount} >= 0`,
    ),
  ],
);
