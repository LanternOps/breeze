import { sql } from 'drizzle-orm';
import {
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import type { EpisodeAttribution } from '@breeze/shared';
import { alerts } from './alerts';
import { devices } from './devices';
import { organizations } from './orgs';
import { users } from './users';

/**
 * Metric anomaly episodes (spec 2026-09-21-metric-anomaly-episodes-design.md).
 *
 * One row per contiguous run of anomalous 5-minute buckets for a
 * (device, episode_key), where episode_key = `source_table:anomaly_type:metric_family`
 * (services/metricAnomalyEpisodeKeys.ts). Assembled and auto-closed by the
 * `episodes` / `episode-resolve` stages in services/metricAnomalies.ts.
 *
 * THREE GROUPING GRAINS — do not conflate them:
 *  - metric_anomalies: one row per bucket per metric; the evidence. Members of
 *    an episode point here via metric_anomalies.episode_id.
 *  - metric_anomaly_incidents: the AI pilot's dispatch OUTBOX, one row per
 *    bucket per anomaly type (metric_name folded). Its grain is unchanged; W02
 *    adds episode_id so the publisher dispatches once per episode.
 *  - metric_anomaly_episodes (this table): the lifecycle a technician sees.
 * The agent's incident count and the tech's episode count differ BY DESIGN.
 *
 * Status is open | resolved | dismissed; `close_reason` says why it closed.
 * Promotion is a link (`linked_alert_id`), not a status. At most one OPEN
 * episode per (device_id, episode_key) — the partial unique index is what makes
 * attach-or-create race-proof between the cron and a backfill.
 *
 * `attribution` is jsonb → excludedOpen in the tenant export policy: visible in
 * the UI, absent from the GDPR export.
 */
export const metricAnomalyEpisodes = pgTable('metric_anomaly_episodes', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  deviceId: uuid('device_id').notNull().references(() => devices.id, { onDelete: 'cascade' }),
  episodeKey: varchar('episode_key', { length: 200 }).notNull(),
  sourceTable: varchar('source_table', { length: 40 }).notNull(),
  anomalyType: varchar('anomaly_type', { length: 40 }).notNull(),
  metricFamily: varchar('metric_family', { length: 120 }).notNull(),
  metricNames: text('metric_names').array().notNull(),
  status: varchar('status', { length: 20 }).notNull().default('open'),
  closeReason: varchar('close_reason', { length: 30 }),
  firstSeenAt: timestamp('first_seen_at').notNull(),
  lastSeenAt: timestamp('last_seen_at').notNull(),
  bucketCount: integer('bucket_count').notNull(),
  peakValue: doublePrecision('peak_value').notNull(),
  peakMetricName: varchar('peak_metric_name', { length: 120 }).notNull(),
  peakBaselineValue: doublePrecision('peak_baseline_value'),
  peakScore: doublePrecision('peak_score').notNull(),
  peakAt: timestamp('peak_at').notNull(),
  recurrenceCount: integer('recurrence_count').notNull().default(0),
  attribution: jsonb('attribution').$type<EpisodeAttribution>(),
  linkedAlertId: uuid('linked_alert_id').references(() => alerts.id, { onDelete: 'set null' }),
  snoozedUntil: timestamp('snoozed_until'),
  resolvedAt: timestamp('resolved_at'),
  resolvedByUserId: uuid('resolved_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  note: varchar('note', { length: 500 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  openKeyUniq: uniqueIndex('metric_anomaly_episodes_open_key_uq')
    .on(table.deviceId, table.episodeKey)
    .where(sql`${table.status} = 'open'`),
  orgStatusLastSeenIdx: index('metric_anomaly_episodes_org_status_last_seen_idx')
    .on(table.orgId, table.status, table.lastSeenAt),
  deviceKeyResolvedIdx: index('metric_anomaly_episodes_device_key_resolved_idx')
    .on(table.deviceId, table.episodeKey, table.resolvedAt.desc()),
  deviceStatusLastSeenIdx: index('metric_anomaly_episodes_device_status_last_seen_idx')
    .on(table.deviceId, table.status, table.lastSeenAt.desc()),
  linkedAlertIdx: index('metric_anomaly_episodes_linked_alert_idx').on(table.linkedAlertId),
}));

export type MetricAnomalyEpisodeRow = typeof metricAnomalyEpisodes.$inferSelect;
