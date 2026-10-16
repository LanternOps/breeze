import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { devices } from './devices';
import { organizations } from './orgs';
import { users } from './users';

/**
 * Endpoint messaging persistence (#8742 W02). Migration:
 * 2026-12-29-160000-endpoint-messaging-tables.sql.
 *
 * Tenancy (docs/agents/tenancy-rls.md):
 * - endpoint_messages: shape 1, direct org_id. One row per send PER ORG; a
 *   cross-org send by a selected-access partner user writes one row per org
 *   sharing `batchId`. No partner-owned row exists (v1 is org-scoped only).
 * - endpoint_message_deliveries / endpoint_message_receipts: shape 5 hot
 *   agent-write tables with a denormalized org_id and a direct
 *   breeze_has_org_access(org_id) policy.
 *
 * Composite tenant FKs prove a referenced device/delivery/message belongs to
 * the row's own org (RLS alone only proves the caller may write that org).
 * A device move detaches `endpointMessageId` (moveDeviceOrgInTransaction.ts):
 * delivery history follows the device, the message and its body stay with the
 * source org.
 */

export const ENDPOINT_MESSAGE_SEVERITIES = ['info', 'warning', 'critical'] as const;
export type EndpointMessageSeverity = (typeof ENDPOINT_MESSAGE_SEVERITIES)[number];

export const ENDPOINT_MESSAGE_DELIVERY_STATUSES = [
  'queued',
  'delivered',
  'displayed',
  'acknowledged',
  'dismissed',
  'expired',
  'retracted',
  'failed',
  'superseded',
] as const;
export type EndpointMessageDeliveryStatus = (typeof ENDPOINT_MESSAGE_DELIVERY_STATUSES)[number];

export const ENDPOINT_MESSAGE_RECEIPT_EVENTS = ['displayed', 'acknowledged', 'dismissed', 'expired'] as const;
export type EndpointMessageReceiptEvent = (typeof ENDPOINT_MESSAGE_RECEIPT_EVENTS)[number];

export const endpointMessages = pgTable('endpoint_messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  /** The send-level id returned to the caller and carried in the agent payload. */
  batchId: uuid('batch_id').notNull(),
  /** The client-generated idempotency id (W01 `messageId`). */
  clientMessageId: uuid('client_message_id').notNull(),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  targetMode: text('target_mode').notNull(),
  targetSpec: jsonb('target_spec').$type<Record<string, unknown>>().notNull().default({}),
  /** Nullable: the retention job nulls title/body after 90 days. */
  title: text('title'),
  body: text('body'),
  severity: text('severity').$type<EndpointMessageSeverity>().notNull(),
  requiresAck: boolean('requires_ack').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  branding: jsonb('branding').$type<Record<string, unknown>>().notNull().default({}),
  aiInitiatorKind: text('ai_initiator_kind'),
  aiSessionId: uuid('ai_session_id'),
  aiAgentRunId: uuid('ai_agent_run_id'),
  bodySha256: text('body_sha256').notNull(),
  bodyLength: integer('body_length').notNull(),
  bodyPurgedAt: timestamp('body_purged_at', { withTimezone: true }),
  /** Set when the message was resent; points at the replacement row. */
  resendOfId: uuid('resend_of_id'),
  retractedAt: timestamp('retracted_at', { withTimezone: true }),
  retractedBy: uuid('retracted_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique('endpoint_messages_id_org_id_key').on(table.id, table.orgId),
  // Not unique per (org, batch): an org merge repoints a cross-org send's rows together.
  index('endpoint_messages_batch_idx').on(table.batchId),
  index('endpoint_messages_org_created_idx').on(table.orgId, table.createdAt),
  index('endpoint_messages_created_unpurged_idx').on(table.createdAt).where(sql`body_purged_at IS NULL`),
  check('endpoint_messages_severity_chk', sql`${table.severity} IN ('info', 'warning', 'critical')`),
  check('endpoint_messages_purge_chk', sql`${table.bodyPurgedAt} IS NOT NULL OR (${table.title} IS NOT NULL AND ${table.body} IS NOT NULL)`),
]);

export const endpointMessageDeliveries = pgTable('endpoint_message_deliveries', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** NULL after a device moved orgs: history follows the device, the message does not. */
  endpointMessageId: uuid('endpoint_message_id'),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  deviceId: uuid('device_id').notNull(),
  /** device_commands.id of the notify_user command; no FK (commands are system-scoped and pruned). */
  commandId: uuid('command_id'),
  status: text('status').$type<EndpointMessageDeliveryStatus>().notNull(),
  surface: text('surface'),
  errorCode: text('error_code'),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  displayedAt: timestamp('displayed_at', { withTimezone: true }),
  acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
  dismissedAt: timestamp('dismissed_at', { withTimezone: true }),
  retractedAt: timestamp('retracted_at', { withTimezone: true }),
  retractCommandId: uuid('retract_command_id'),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  foreignKey({
    columns: [table.endpointMessageId, table.orgId],
    foreignColumns: [endpointMessages.id, endpointMessages.orgId],
    name: 'endpoint_message_deliveries_message_org_fk',
  }).onDelete('cascade'),
  foreignKey({
    columns: [table.deviceId, table.orgId],
    foreignColumns: [devices.id, devices.orgId],
    name: 'endpoint_message_deliveries_device_org_fk',
  }).onDelete('cascade'),
  unique('endpoint_message_deliveries_id_org_id_key').on(table.id, table.orgId),
  unique('endpoint_message_deliveries_message_device_key').on(table.endpointMessageId, table.deviceId),
  index('endpoint_message_deliveries_message_status_idx').on(table.endpointMessageId, table.status),
  index('endpoint_message_deliveries_device_created_idx').on(table.deviceId, table.createdAt),
  index('endpoint_message_deliveries_command_idx').on(table.commandId),
  index('endpoint_message_deliveries_org_created_idx').on(table.orgId, table.createdAt),
  check(
    'endpoint_message_deliveries_status_chk',
    sql`${table.status} IN ('queued', 'delivered', 'displayed', 'acknowledged', 'dismissed', 'expired', 'retracted', 'failed', 'superseded')`,
  ),
]);

export const endpointMessageReceipts = pgTable('endpoint_message_receipts', {
  id: uuid('id').primaryKey().defaultRandom(),
  deliveryId: uuid('delivery_id').notNull(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  deviceId: uuid('device_id').notNull(),
  /** Agent-attested session identity: SID, else Windows session id, else username. */
  sessionKey: text('session_key').notNull(),
  sessionUsername: text('session_username'),
  eventType: text('event_type').$type<EndpointMessageReceiptEvent>().notNull(),
  /** When the agent says the event happened. */
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  foreignKey({
    columns: [table.deliveryId, table.orgId],
    foreignColumns: [endpointMessageDeliveries.id, endpointMessageDeliveries.orgId],
    name: 'endpoint_message_receipts_delivery_org_fk',
  }).onDelete('cascade'),
  foreignKey({
    columns: [table.deviceId, table.orgId],
    foreignColumns: [devices.id, devices.orgId],
    name: 'endpoint_message_receipts_device_org_fk',
  }).onDelete('cascade'),
  uniqueIndex('endpoint_message_receipts_dedup_uq').on(table.deliveryId, table.sessionKey, table.eventType),
  index('endpoint_message_receipts_device_idx').on(table.deviceId, table.createdAt),
  index('endpoint_message_receipts_org_created_idx').on(table.orgId, table.createdAt),
  check(
    'endpoint_message_receipts_event_chk',
    sql`${table.eventType} IN ('displayed', 'acknowledged', 'dismissed', 'expired')`,
  ),
]);

export type EndpointMessageRow = typeof endpointMessages.$inferSelect;
export type EndpointMessageDeliveryRow = typeof endpointMessageDeliveries.$inferSelect;
export type EndpointMessageReceiptRow = typeof endpointMessageReceipts.$inferSelect;
