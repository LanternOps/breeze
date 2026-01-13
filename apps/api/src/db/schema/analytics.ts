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
  index
} from 'drizzle-orm/pg-core';
import { organizations } from './orgs';
import { devices } from './devices';
import { users } from './users';

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
