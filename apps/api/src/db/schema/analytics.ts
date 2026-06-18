import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  boolean,
  jsonb,
  integer,
  doublePrecision,
  index,
  uniqueIndex
} from 'drizzle-orm/pg-core';
import { organizations } from './orgs';
import { devices } from './devices';
import { users } from './users';
import { alerts, alertCorrelationGroups } from './alerts';

export const timeSeriesMetrics = pgTable('time_series_metrics', {
  timestamp: timestamp('timestamp').notNull(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  deviceId: uuid('device_id').notNull().references(() => devices.id),
  metricType: varchar('metric_type', { length: 100 }).notNull(),
  metricName: varchar('metric_name', { length: 255 }).notNull(),
  value: doublePrecision('value').notNull(),
  unit: varchar('unit', { length: 50 }),
  tags: jsonb('tags').notNull().default({})
}, (table) => ({
  deviceTimestampIdx: index('time_series_metrics_device_timestamp_idx').on(table.timestamp, table.deviceId),
  orgTimestampIdx: index('time_series_metrics_org_timestamp_idx').on(table.orgId, table.timestamp)
}));

export const metricRollups = pgTable('metric_rollups', {
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  sourceTable: varchar('source_table', { length: 80 }).notNull(),
  deviceId: uuid('device_id').notNull().references(() => devices.id, { onDelete: 'cascade' }),
  metricType: varchar('metric_type', { length: 80 }).notNull(),
  metricName: varchar('metric_name', { length: 120 }).notNull(),
  bucketStart: timestamp('bucket_start').notNull(),
  bucketSeconds: integer('bucket_seconds').notNull(),
  avgValue: doublePrecision('avg_value'),
  minValue: doublePrecision('min_value'),
  maxValue: doublePrecision('max_value'),
  p95Value: doublePrecision('p95_value'),
  sumValue: doublePrecision('sum_value'),
  sampleCount: integer('sample_count').notNull().default(0),
  gapSeconds: integer('gap_seconds').notNull().default(0),
  metadata: jsonb('metadata').notNull().default({}),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (table) => ({
  keyUniq: uniqueIndex('metric_rollups_key_uq').on(
    table.orgId,
    table.sourceTable,
    table.deviceId,
    table.metricType,
    table.metricName,
    table.bucketSeconds,
    table.bucketStart
  ),
  orgBucketIdx: index('metric_rollups_org_bucket_idx').on(table.orgId, table.bucketSeconds, table.bucketStart),
  deviceMetricIdx: index('metric_rollups_device_metric_idx').on(table.deviceId, table.metricName, table.bucketSeconds, table.bucketStart)
}));

export const metricAnomalies = pgTable('metric_anomalies', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  deviceId: uuid('device_id').notNull().references(() => devices.id, { onDelete: 'cascade' }),
  sourceTable: varchar('source_table', { length: 80 }).notNull().default('device_metrics'),
  metricType: varchar('metric_type', { length: 80 }).notNull(),
  metricName: varchar('metric_name', { length: 120 }).notNull(),
  anomalyType: varchar('anomaly_type', { length: 40 }).notNull(),
  status: varchar('status', { length: 40 }).notNull().default('open'),
  windowStart: timestamp('window_start').notNull(),
  windowEnd: timestamp('window_end').notNull(),
  bucketSeconds: integer('bucket_seconds').notNull().default(300),
  observedValue: doublePrecision('observed_value').notNull(),
  baselineValue: doublePrecision('baseline_value'),
  baselineMin: doublePrecision('baseline_min'),
  baselineMax: doublePrecision('baseline_max'),
  score: doublePrecision('score').notNull(),
  confidence: doublePrecision('confidence').notNull(),
  sampleCount: integer('sample_count').notNull().default(0),
  baselineSummary: jsonb('baseline_summary').notNull().default({}),
  evidence: jsonb('evidence').notNull().default({}),
  linkedAlertId: uuid('linked_alert_id').references(() => alerts.id, { onDelete: 'set null' }),
  linkedCorrelationGroupId: uuid('linked_correlation_group_id').references(() => alertCorrelationGroups.id, { onDelete: 'set null' }),
  detectedAt: timestamp('detected_at').defaultNow().notNull(),
  resolvedAt: timestamp('resolved_at'),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (table) => ({
  keyUniq: uniqueIndex('metric_anomalies_key_uq').on(
    table.orgId,
    table.deviceId,
    table.metricName,
    table.anomalyType,
    table.bucketSeconds,
    table.windowStart
  ),
  orgStatusDetectedIdx: index('metric_anomalies_org_status_detected_idx').on(table.orgId, table.status, table.detectedAt),
  deviceStatusDetectedIdx: index('metric_anomalies_device_status_detected_idx').on(table.deviceId, table.status, table.detectedAt),
  linkedAlertIdx: index('metric_anomalies_linked_alert_idx').on(table.linkedAlertId),
  linkedCorrelationIdx: index('metric_anomalies_linked_correlation_idx').on(table.linkedCorrelationGroupId)
}));

export const analyticsDashboards = pgTable('analytics_dashboards', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  isDefault: boolean('is_default').notNull().default(false),
  isSystem: boolean('is_system').notNull().default(false),
  layout: jsonb('layout').notNull().default({}),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
});

export const dashboardWidgets = pgTable('dashboard_widgets', {
  id: uuid('id').primaryKey().defaultRandom(),
  dashboardId: uuid('dashboard_id').notNull().references(() => analyticsDashboards.id),
  widgetType: varchar('widget_type', { length: 100 }).notNull(),
  title: varchar('title', { length: 255 }).notNull(),
  dataSource: jsonb('data_source').notNull().default({}),
  chartType: varchar('chart_type', { length: 100 }),
  visualization: jsonb('visualization').notNull().default({}),
  position: jsonb('position').notNull().default({}),
  refreshInterval: integer('refresh_interval'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
});

export const savedQueries = pgTable('saved_queries', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  metricTypes: text('metric_types').array().default([]),
  metricNames: text('metric_names').array().default([]),
  aggregation: varchar('aggregation', { length: 50 }),
  groupBy: text('group_by').array().default([]),
  filters: jsonb('filters').notNull().default({}),
  timeRange: jsonb('time_range').notNull().default({}),
  isShared: boolean('is_shared').notNull().default(false),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
});

export const capacityThresholds = pgTable('capacity_thresholds', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  name: varchar('name', { length: 255 }).notNull(),
  metricType: varchar('metric_type', { length: 100 }).notNull(),
  metricName: varchar('metric_name', { length: 255 }).notNull(),
  warningThreshold: doublePrecision('warning_threshold'),
  criticalThreshold: doublePrecision('critical_threshold'),
  predictionWindow: integer('prediction_window'),
  growthRateThreshold: doublePrecision('growth_rate_threshold'),
  targetType: varchar('target_type', { length: 50 }),
  targetIds: uuid('target_ids').array(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
});

export const capacityPredictions = pgTable('capacity_predictions', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  deviceId: uuid('device_id').references(() => devices.id),
  metricType: varchar('metric_type', { length: 100 }).notNull(),
  metricName: varchar('metric_name', { length: 255 }).notNull(),
  currentValue: doublePrecision('current_value').notNull(),
  predictedValue: doublePrecision('predicted_value').notNull(),
  predictionDate: timestamp('prediction_date').notNull(),
  confidence: doublePrecision('confidence'),
  growthRate: doublePrecision('growth_rate'),
  daysToThreshold: integer('days_to_threshold'),
  thresholdType: varchar('threshold_type', { length: 50 }),
  modelType: varchar('model_type', { length: 100 }),
  trainingDataDays: integer('training_data_days'),
  calculatedAt: timestamp('calculated_at').defaultNow().notNull()
});

export const slaDefinitions = pgTable('sla_definitions', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  uptimeTarget: doublePrecision('uptime_target'),
  responseTimeTarget: doublePrecision('response_time_target'),
  resolutionTimeTarget: doublePrecision('resolution_time_target'),
  measurementWindow: varchar('measurement_window', { length: 50 }),
  excludeMaintenanceWindows: boolean('exclude_maintenance_windows').notNull().default(false),
  excludeWeekends: boolean('exclude_weekends').notNull().default(false),
  targetType: varchar('target_type', { length: 50 }),
  targetIds: uuid('target_ids').array(),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
});

export const slaCompliance = pgTable('sla_compliance', {
  id: uuid('id').primaryKey().defaultRandom(),
  slaId: uuid('sla_id').notNull().references(() => slaDefinitions.id),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  periodStart: timestamp('period_start').notNull(),
  periodEnd: timestamp('period_end').notNull(),
  uptimeActual: doublePrecision('uptime_actual'),
  responseTimeActual: doublePrecision('response_time_actual'),
  resolutionTimeActual: doublePrecision('resolution_time_actual'),
  uptimeCompliant: boolean('uptime_compliant'),
  responseTimeCompliant: boolean('response_time_compliant'),
  resolutionTimeCompliant: boolean('resolution_time_compliant'),
  overallCompliant: boolean('overall_compliant'),
  totalDowntimeMinutes: integer('total_downtime_minutes'),
  incidentCount: integer('incident_count'),
  excludedMinutes: integer('excluded_minutes'),
  details: jsonb('details').notNull().default({}),
  calculatedAt: timestamp('calculated_at').defaultNow().notNull()
});

export const executiveSummaries = pgTable('executive_summaries', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  periodType: varchar('period_type', { length: 50 }).notNull(),
  periodStart: timestamp('period_start').notNull(),
  periodEnd: timestamp('period_end').notNull(),
  deviceStats: jsonb('device_stats').notNull().default({}),
  alertStats: jsonb('alert_stats').notNull().default({}),
  patchStats: jsonb('patch_stats').notNull().default({}),
  slaStats: jsonb('sla_stats').notNull().default({}),
  trends: jsonb('trends').notNull().default({}),
  highlights: jsonb('highlights').notNull().default({}),
  generatedAt: timestamp('generated_at').defaultNow().notNull()
});
