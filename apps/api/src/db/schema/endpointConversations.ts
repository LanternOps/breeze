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
 * Endpoint live chat (#8743, W03 of #8740). Migration:
 * 2026-12-29-220000-endpoint-conversations.sql.
 *
 * Tenancy (docs/agents/tenancy-rls.md): both tables are shape 5 — device-scoped
 * with a denormalized org_id and a direct breeze_has_org_access(org_id) policy.
 * Composite tenant FKs (DEFERRABLE INITIALLY DEFERRED in SQL) prove the device
 * and conversation belong to the row's org. History follows the device on an
 * org move; the move closes a live conversation first (close_reason
 * 'device_moved'). No ticket binding: there is deliberately no ticket_id.
 */

export const ENDPOINT_CONVERSATION_STATUSES = ['opening', 'open', 'closed', 'expired', 'failed'] as const;
export type EndpointConversationStatusValue = (typeof ENDPOINT_CONVERSATION_STATUSES)[number];
export const ENDPOINT_CONVERSATION_CLOSE_REASONS = ['technician', 'idle', 'device_moved', 'agent'] as const;
export type EndpointConversationCloseReason = (typeof ENDPOINT_CONVERSATION_CLOSE_REASONS)[number];
export type EndpointConversationDirection = 'to_user' | 'from_user';

/** Agent-attested OS session of a user reply. */
export interface EndpointChatSenderSession {
  username: string;
  sid?: string;
  winSessionId?: number;
}

export const endpointConversations = pgTable('endpoint_conversations', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  deviceId: uuid('device_id').notNull(),
  channel: text('channel').notNull().default('endpoint_helper'),
  status: text('status').$type<EndpointConversationStatusValue>().notNull(),
  /** Snapshot of the device's resolved `endpointMessaging.allowUserReply` at open. */
  allowUserReply: boolean('allow_user_reply').notNull(),
  openedBy: uuid('opened_by').references(() => users.id, { onDelete: 'set null' }),
  /** device_commands.id of the chat_open command; no FK (commands are system-scoped and pruned). */
  openCommandId: uuid('open_command_id'),
  /** Agent-attested console user the chat window opened for. */
  targetUsername: text('target_username'),
  winSessionId: integer('win_session_id'),
  errorCode: text('error_code'),
  closeReason: text('close_reason').$type<EndpointConversationCloseReason>(),
  closedBy: uuid('closed_by').references(() => users.id, { onDelete: 'set null' }),
  lastActivityAt: timestamp('last_activity_at', { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  foreignKey({
    columns: [table.deviceId, table.orgId],
    foreignColumns: [devices.id, devices.orgId],
    name: 'endpoint_conversations_device_org_fk',
  }).onDelete('cascade'),
  unique('endpoint_conversations_id_org_id_key').on(table.id, table.orgId),
  uniqueIndex('endpoint_conversations_device_active_uq').on(table.deviceId).where(sql`status IN ('opening', 'open')`),
  index('endpoint_conversations_device_created_idx').on(table.deviceId, table.createdAt),
  index('endpoint_conversations_org_created_idx').on(table.orgId, table.createdAt),
  index('endpoint_conversations_live_activity_idx').on(table.lastActivityAt).where(sql`status IN ('opening', 'open')`),
  index('endpoint_conversations_open_command_idx').on(table.openCommandId),
  check('endpoint_conversations_status_chk', sql`${table.status} IN ('opening', 'open', 'closed', 'expired', 'failed')`),
  check('endpoint_conversations_channel_chk', sql`${table.channel} IN ('endpoint_helper')`),
  check(
    'endpoint_conversations_close_reason_chk',
    sql`${table.closeReason} IS NULL OR ${table.closeReason} IN ('technician', 'idle', 'device_moved', 'agent')`,
  ),
]);

export const endpointConversationMessages = pgTable('endpoint_conversation_messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  conversationId: uuid('conversation_id').notNull(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  deviceId: uuid('device_id').notNull(),
  direction: text('direction').$type<EndpointConversationDirection>().notNull(),
  /** Nullable: the retention job nulls bodies after 90 days. */
  body: text('body'),
  bodyLength: integer('body_length').notNull(),
  bodyPurgedAt: timestamp('body_purged_at', { withTimezone: true }),
  /** to_user: the technician client's message id; from_user: the helper's reply nonce. */
  clientNonce: uuid('client_nonce').notNull(),
  senderUserId: uuid('sender_user_id').references(() => users.id, { onDelete: 'set null' }),
  senderSession: jsonb('sender_session').$type<EndpointChatSenderSession>(),
  /** device_commands.id of the chat_open / chat_message command (to_user). */
  commandId: uuid('command_id'),
  errorCode: text('error_code'),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  foreignKey({
    columns: [table.conversationId, table.orgId],
    foreignColumns: [endpointConversations.id, endpointConversations.orgId],
    name: 'endpoint_conversation_messages_conversation_org_fk',
  }).onDelete('cascade'),
  foreignKey({
    columns: [table.deviceId, table.orgId],
    foreignColumns: [devices.id, devices.orgId],
    name: 'endpoint_conversation_messages_device_org_fk',
  }).onDelete('cascade'),
  uniqueIndex('endpoint_conversation_messages_nonce_uq').on(table.conversationId, table.clientNonce),
  index('endpoint_conversation_messages_conversation_created_idx').on(table.conversationId, table.createdAt),
  index('endpoint_conversation_messages_device_created_idx').on(table.deviceId, table.createdAt),
  index('endpoint_conversation_messages_org_created_idx').on(table.orgId, table.createdAt),
  index('endpoint_conversation_messages_command_idx').on(table.commandId),
  index('endpoint_conversation_messages_created_unpurged_idx').on(table.createdAt).where(sql`body_purged_at IS NULL`),
  check('endpoint_conversation_messages_direction_chk', sql`${table.direction} IN ('to_user', 'from_user')`),
  check('endpoint_conversation_messages_purge_chk', sql`${table.body} IS NOT NULL OR ${table.bodyPurgedAt} IS NOT NULL`),
  check(
    'endpoint_conversation_messages_sender_chk',
    sql`(${table.direction} = 'to_user' AND ${table.senderSession} IS NULL) OR (${table.direction} = 'from_user' AND ${table.senderUserId} IS NULL)`,
  ),
]);

export type EndpointConversationRow = typeof endpointConversations.$inferSelect;
export type EndpointConversationMessageRow = typeof endpointConversationMessages.$inferSelect;
