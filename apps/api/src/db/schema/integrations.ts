import { pgTable, uuid, varchar, text, timestamp, boolean, jsonb, pgEnum, integer, index, uniqueIndex, smallint, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations, partners } from './orgs';
import { users } from './users';
import { alerts } from './alerts';
import { devices } from './devices';

export const pluginStatusEnum = pgEnum('plugin_status', ['active', 'disabled', 'error', 'installing']);
export const webhookStatusEnum = pgEnum('webhook_status', ['active', 'disabled', 'error']);
export const webhookDeliveryStatusEnum = pgEnum('webhook_delivery_status', ['pending', 'delivered', 'failed', 'retrying', 'scheduled']);
// The DB enum is intentionally WIDER than the implemented provider list
// (PSA_PROVIDERS in @breeze/shared): 'halo', 'syncro', 'kaseya' and 'other'
// are DEAD values — no adapter exists and the route-level zod gate
// (psaProviderIdSchema) predates any data, so no real rows can carry them.
// Postgres enum values can't be dropped without a type rebuild, so they stay;
// do NOT treat their presence here as a feature list.
export const psaProviderEnum = pgEnum('psa_provider', [
  'connectwise',
  'autotask',
  'halo',
  'syncro',
  'kaseya',
  'jira',
  'servicenow',
  'freshservice',
  'zendesk',
  'other'
]);

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
  orgId: uuid('org_id').references(() => organizations.id),
  partnerId: uuid('partner_id').references(() => partners.id),
  name: varchar('name', { length: 255 }).notNull(),
  url: text('url').notNull(),
  secret: text('secret'),
  events: text('events').array().notNull().default([]),
  payloadVersion: smallint('payload_version').notNull().default(2),
  headers: jsonb('headers'),
  status: webhookStatusEnum('status').notNull().default('active'),
  retryPolicy: jsonb('retry_policy'),
  successCount: integer('success_count').notNull().default(0),
  failureCount: integer('failure_count').notNull().default(0),
  lastDeliveryAt: timestamp('last_delivery_at'),
  lastSuccessAt: timestamp('last_success_at'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  /**
   * Bumped on every edit that changes delivery behavior (PATCH; site-ceiling
   * gate contract §3). The delivery worker compares this against the
   * generation carried on the job at enqueue time and drops the delivery
   * (superseded) on mismatch, so an in-flight delivery never fires against a
   * config that was edited (or disabled) after it was queued.
   */
  approvalGeneration: integer('approval_generation').notNull().default(1)
}, (table) => ({
  oneOwnerCheck: check('webhooks_one_owner_chk', sql`(${table.orgId} IS NULL) <> (${table.partnerId} IS NULL)`),
  partnerActiveIdx: index('webhooks_partner_active_idx').on(table.partnerId).where(sql`${table.status} = 'active'`),
  payloadVersionCheck: check('webhooks_payload_version_chk', sql`${table.payloadVersion} IN (1, 2)`)
}));

export const webhookDeliveries = pgTable('webhook_deliveries', {
  id: uuid('id').primaryKey().defaultRandom(),
  webhookId: uuid('webhook_id').notNull().references(() => webhooks.id, { onDelete: 'cascade' }),
  // Event org for erasure/merge/export; read authority remains the webhook owner.
  orgId: uuid('org_id').references(() => organizations.id),
  eventType: varchar('event_type', { length: 100 }).notNull(),
  eventId: varchar('event_id', { length: 100 }).notNull(),
  payload: jsonb('payload').notNull(),
  // Pinned wire version; legacy deliveries retain version 1.
  payloadVersion: smallint('payload_version').notNull().default(1),
  // Approval generation at recording time; NULL legacy rows use the current generation.
  webhookGeneration: integer('webhook_generation'),
  // Original envelope timestamp, preserved when recovery requeues a delivery.
  eventTimestamp: timestamp('event_timestamp', { withTimezone: true }),
  // Original event ID shared by every manual replay in a chain.
  replayRootEventId: varchar('replay_root_event_id', { length: 100 }),
  status: webhookDeliveryStatusEnum('status').notNull().default('pending'),
  /** HTTP delivery attempts. Written by the delivery callback, shown in the UI. */
  attempts: integer('attempts').notNull().default(0),
  /**
   * Times the pending/retrying recovery arm has re-queued this row (#4095). NOT
   * `attempts`: that column is overwritten by the delivery callback, so a
   * counter kept there would reset on the first completed attempt and would
   * misreport enqueue recoveries as HTTP attempts in the UI.
   */
  recoveryAttempts: integer('recovery_attempts').notNull().default(0),
  // Scheduled due time, retrying execution lease, or a re-driven pending row's 15-minute lease.
  nextRetryAt: timestamp('next_retry_at'),
  // Terminal time drives health windows: retries can finish many hours after creation.
  // UTC wall clock (no timezone), matching nextRetryAt; legacy failed rows stay NULL.
  failedAt: timestamp('failed_at'),
  responseStatus: integer('response_status'),
  responseBody: text('response_body'),
  responseTimeMs: integer('response_time_ms'),
  errorMessage: text('error_message'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  deliveredAt: timestamp('delivered_at')
}, (table) => ({
  orgIdCheck: check('webhook_deliveries_org_id_chk', sql`${table.orgId} IS NOT NULL OR ${table.eventId} LIKE 'test-%'`),
  orgIdx: index('webhook_deliveries_org_idx').on(table.orgId),
  payloadVersionCheck: check('webhook_deliveries_payload_version_chk', sql`${table.payloadVersion} IN (1, 2)`),
  // One delivery per (webhook, event). The '*' subscriber creates a row and
  // queues an outbound POST per matching webhook, so without this a redelivered
  // event POSTs to the customer's endpoint twice (2026-09-11-a migration).
  webhookEventUq: uniqueIndex('webhook_deliveries_webhook_event_uq')
    .on(table.webhookId, table.eventId),
  // Partial, over the pending/retrying recovery lease arm (2026-09-11-d).
  // Retention removes terminal rows; scheduled rows use their own due-time
  // index below. This scan stays small while pending/retrying rows are transient.
  unresolvedIdx: index('webhook_deliveries_unresolved_idx')
    .on(table.createdAt)
    .where(sql`${table.status} IN ('pending', 'retrying')`),
  // Scheduled retries live for about 21 hours, so keep their due-time scan
  // separate from the short-lived pending/retrying created-at index.
  scheduledDueIdx: index('webhook_deliveries_scheduled_due_idx')
    .on(table.nextRetryAt)
    .where(sql`${table.status} = 'scheduled'`),
  // Connection health W4 webhook source (2026-12-30-120100): failed rows only,
  // so both grow with failures, not with traffic.
  failedAtRecentIdx: index('webhook_deliveries_failed_at_recent_idx')
    .on(table.failedAt)
    .where(sql`${table.status} = 'failed'`),
  failedWebhookIdx: index('webhook_deliveries_failed_webhook_idx')
    .on(table.webhookId, table.createdAt)
    .where(sql`${table.status} = 'failed' AND ${table.attempts} > 0`)
}));

// Dual ownership (epic #2135): a connection is owned by EITHER an org
// (org_id set, partner_id NULL — a customer's own Jira/Zendesk in a co-managed
// engagement) OR a partner (partner_id set, org_id NULL — the MSP's own PSA,
// shared across all orgs). Exactly one axis is set, enforced in Postgres by
// psa_connections_one_owner_chk (2026-08-17-psa-connections-partner-ownership).
export const psaConnections = pgTable('psa_connections', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => organizations.id),
  partnerId: uuid('partner_id').references(() => partners.id),
  provider: psaProviderEnum('provider').notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  credentials: jsonb('credentials').notNull(),
  settings: jsonb('settings').default({}),
  syncSettings: jsonb('sync_settings').default({}),
  // Dormant — reserved for future ticket-sync. No worker consumes these today
  // (POST /psa/connections/:id/sync returns 501); nothing reads `enabled` or
  // writes `lastSyncError`.
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
