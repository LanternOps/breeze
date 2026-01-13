import { pgTable, uuid, varchar, text, timestamp, boolean, jsonb, pgEnum, integer } from 'drizzle-orm/pg-core';
import { organizations } from './orgs';
import { users } from './users';
import { alerts } from './alerts';
import { devices } from './devices';

export const pluginStatusEnum = pgEnum('plugin_status', ['active', 'disabled', 'error', 'installing']);
export const webhookStatusEnum = pgEnum('webhook_status', ['active', 'disabled', 'error']);
export const webhookDeliveryStatusEnum = pgEnum('webhook_delivery_status', ['pending', 'delivered', 'failed', 'retrying']);
export const eventBusPriorityEnum = pgEnum('event_bus_priority', ['low', 'normal', 'high', 'critical']);
export const psaProviderEnum = pgEnum('psa_provider', ['connectwise', 'autotask', 'halo', 'syncro', 'kaseya', 'other']);

export const plugins = pgTable('plugins', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  name: varchar('name', { length: 255 }).notNull(),
  slug: varchar('slug', { length: 100 }).notNull(),
  version: varchar('version', { length: 50 }).notNull(),
  description: text('description'),
  author: varchar('author', { length: 255 }),
  homepage: text('homepage'),
  manifestUrl: text('manifest_url'),
  entryPoint: text('entry_point'),
  permissions: jsonb('permissions'),
  hooks: jsonb('hooks'),
  settings: jsonb('settings'),
  status: pluginStatusEnum('status').notNull().default('active'),
  isSystem: boolean('is_system').notNull().default(false),
  installedAt: timestamp('installed_at'),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  errorMessage: text('error_message'),
  lastActiveAt: timestamp('last_active_at')
});

export const pluginInstances = pgTable('plugin_instances', {
  id: uuid('id').primaryKey().defaultRandom(),
  pluginId: uuid('plugin_id').notNull().references(() => plugins.id),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  config: jsonb('config').notNull().default({}),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
});

export const webhooks = pgTable('webhooks', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  name: varchar('name', { length: 255 }).notNull(),
  url: text('url').notNull(),
  secret: text('secret'),
  events: text('events').array().notNull().default([]),
  headers: jsonb('headers'),
  status: webhookStatusEnum('status').notNull().default('active'),
  retryPolicy: jsonb('retry_policy'),
  successCount: integer('success_count').notNull().default(0),
  failureCount: integer('failure_count').notNull().default(0),
  lastDeliveryAt: timestamp('last_delivery_at'),
  lastSuccessAt: timestamp('last_success_at'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
});

export const webhookDeliveries = pgTable('webhook_deliveries', {
  id: uuid('id').primaryKey().defaultRandom(),
  webhookId: uuid('webhook_id').notNull().references(() => webhooks.id),
  eventType: varchar('event_type', { length: 100 }).notNull(),
  eventId: varchar('event_id', { length: 100 }).notNull(),
  payload: jsonb('payload').notNull(),
  status: webhookDeliveryStatusEnum('status').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  nextRetryAt: timestamp('next_retry_at'),
  responseStatus: integer('response_status'),
  responseBody: text('response_body'),
  responseTimeMs: integer('response_time_ms'),
  errorMessage: text('error_message'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  deliveredAt: timestamp('delivered_at')
});

export const eventBusEvents = pgTable('event_bus_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  eventType: varchar('event_type', { length: 100 }).notNull(),
  source: varchar('source', { length: 100 }).notNull(),
  priority: eventBusPriorityEnum('priority').notNull().default('normal'),
  payload: jsonb('payload').notNull(),
  metadata: jsonb('metadata'),
  processedAt: timestamp('processed_at'),
  createdAt: timestamp('created_at').defaultNow().notNull()
});

export const psaConnections = pgTable('psa_connections', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  provider: psaProviderEnum('provider').notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  credentials: jsonb('credentials').notNull(),
  settings: jsonb('settings').default({}),
  syncSettings: jsonb('sync_settings').default({}),
  enabled: boolean('enabled').notNull().default(true),
  lastSyncAt: timestamp('last_sync_at'),
  lastSyncStatus: varchar('last_sync_status', { length: 50 }),
  lastSyncError: text('last_sync_error'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
});

export const psaTicketMappings = pgTable('psa_ticket_mappings', {
  id: uuid('id').primaryKey().defaultRandom(),
  connectionId: uuid('connection_id').notNull().references(() => psaConnections.id),
  alertId: uuid('alert_id').references(() => alerts.id),
  deviceId: uuid('device_id').references(() => devices.id),
  externalTicketId: varchar('external_ticket_id', { length: 100 }),
  externalTicketUrl: text('external_ticket_url'),
  status: varchar('status', { length: 50 }),
  lastSyncAt: timestamp('last_sync_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
});
