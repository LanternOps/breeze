import {
  pgEnum,
  pgTable,
  uuid,
  integer,
  boolean,
  timestamp,
  primaryKey,
  index,
  uniqueIndex,
  foreignKey,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { devices } from './devices';
import { users } from './users';
import { monitorDefinitions } from './monitorDefinitions';

/**
 * Monitoring & Automation unification, W03 (#5287 / #5290).
 *
 * `monitor_episodes` is the breach history for a (monitor, device) pair;
 * `monitor_device_state` is the one-row-per-pair operational state that carries
 * the recurrence window counter and the escalation latch.
 *
 * Tenancy shape 1: `org_id` is DENORMALISED FROM THE DEVICE, never from the
 * monitor definition — a partner-wide monitor produces org-scoped episodes.
 */
export const monitorDeviceLastStateEnum = pgEnum('monitor_device_last_state', [
  'ok',
  'breach',
  'unknown',
]);

export const monitorEpisodeEndReasonEnum = pgEnum('monitor_episode_end_reason', [
  'recovered',
  'device_deleted',
  'monitor_detached',
]);

export const monitorResponseOutcomeEnum = pgEnum('monitor_response_outcome', [
  'queued',
  'completed',
  'failed',
  'skipped_paused',
  'skipped_no_response',
]);

export const monitorEpisodes = pgTable(
  'monitor_episodes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    monitorId: uuid('monitor_id')
      .notNull()
      .references(() => monitorDefinitions.id, { onDelete: 'cascade' }),
    deviceId: uuid('device_id').notNull(),
    orgId: uuid('org_id').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    endReason: monitorEpisodeEndReasonEnum('end_reason'),
    alertId: uuid('alert_id'),
    responseRunId: uuid('response_run_id'),
    responseOutcome: monitorResponseOutcomeEnum('response_outcome'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.deviceId, table.orgId],
      foreignColumns: [devices.id, devices.orgId],
      name: 'monitor_episodes_device_org_fkey',
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    check(
      'monitor_episodes_end_chk',
      sql`(${table.endedAt} IS NULL) = (${table.endReason} IS NULL)`,
    ),
    uniqueIndex('monitor_episodes_open_uidx')
      .on(table.monitorId, table.deviceId)
      .where(sql`${table.endedAt} IS NULL`),
    index('monitor_episodes_org_idx').on(table.orgId),
    index('monitor_episodes_device_idx').on(table.deviceId),
    index('monitor_episodes_window_idx').on(table.monitorId, table.deviceId, table.startedAt),
  ],
);

export const monitorDeviceState = pgTable(
  'monitor_device_state',
  {
    monitorId: uuid('monitor_id')
      .notNull()
      .references(() => monitorDefinitions.id, { onDelete: 'cascade' }),
    deviceId: uuid('device_id').notNull(),
    orgId: uuid('org_id').notNull(),
    currentEpisodeId: uuid('current_episode_id').references(() => monitorEpisodes.id, {
      onDelete: 'set null',
    }),
    episodesInWindow: integer('episodes_in_window').notNull().default(0),
    windowStartedAt: timestamp('window_started_at', { withTimezone: true }),
    escalatedAt: timestamp('escalated_at', { withTimezone: true }),
    // Deliberately NO FK to alerts: the escalation alert outlives the monitor.
    escalationAlertId: uuid('escalation_alert_id'),
    responsesPaused: boolean('responses_paused').notNull().default(false),
    resetAt: timestamp('reset_at', { withTimezone: true }),
    resetBy: uuid('reset_by').references(() => users.id, { onDelete: 'set null' }),
    lastEvaluatedAt: timestamp('last_evaluated_at', { withTimezone: true }),
    lastState: monitorDeviceLastStateEnum('last_state').notNull().default('unknown'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.monitorId, table.deviceId], name: 'monitor_device_state_pkey' }),
    foreignKey({
      columns: [table.deviceId, table.orgId],
      foreignColumns: [devices.id, devices.orgId],
      name: 'monitor_device_state_device_org_fkey',
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    check('monitor_device_state_window_chk', sql`${table.episodesInWindow} >= 0`),
    index('monitor_device_state_org_idx').on(table.orgId),
    index('monitor_device_state_device_idx').on(table.deviceId),
  ],
);

export type MonitorEpisodeRow = typeof monitorEpisodes.$inferSelect;
export type MonitorDeviceStateRow = typeof monitorDeviceState.$inferSelect;
export type MonitorEpisodeEndReason = (typeof monitorEpisodeEndReasonEnum.enumValues)[number];
export type MonitorResponseOutcome = (typeof monitorResponseOutcomeEnum.enumValues)[number];
export type MonitorDeviceLastState = (typeof monitorDeviceLastStateEnum.enumValues)[number];
