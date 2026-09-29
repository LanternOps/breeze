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
