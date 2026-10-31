import { sql } from 'drizzle-orm';
import { boolean, check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { devices } from './devices';
import { organizations } from './orgs';

export const WAKE_READINESS_STATES = ['ready', 'needs_reboot', 'not_configured', 'apply_failed', 'firmware_protected', 'unproven', 'no_wired_adapter', 'unsupported_vm'] as const;
export type WakeReadinessState = (typeof WAKE_READINESS_STATES)[number];
export const WAKE_ATTEMPT_OUTCOMES = ['pending', 'sent', 'send_failed', 'came_online', 'timed_out', 'unknown', 'refused'] as const;
export type WakeAttemptOutcome = (typeof WAKE_ATTEMPT_OUTCOMES)[number];

// SQL is authoritative for DEFERRABLE INITIALLY IMMEDIATE; Drizzle cannot express it.
export const deviceWakeStatus = pgTable('device_wake_status', {
  deviceId: uuid('device_id').primaryKey(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  readinessState: varchar('readiness_state', { length: 32 }).$type<WakeReadinessState>(),
  reasonCodes: text('reason_codes').array().notNull().default([]),
  vendor: varchar('vendor', { length: 32 }),
  fingerprint: text('fingerprint'),
  agentVersion: text('agent_version'),
  proofFingerprint: text('proof_fingerprint'),
  collectedAt: timestamp('collected_at', { withTimezone: true }),
  receivedAt: timestamp('received_at', { withTimezone: true }),
  lastApplyAt: timestamp('last_apply_at', { withTimezone: true }),
  lastWiredAdapterSeenAt: timestamp('last_wired_adapter_seen_at', { withTimezone: true }),
  lastCameOnlineAt: timestamp('last_came_online_at', { withTimezone: true }),
  lastApplyResult: varchar('last_apply_result', { length: 32 }),
  details: jsonb('details'),
  consecutiveTimeouts: integer('consecutive_timeouts').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  foreignKey({ columns: [t.deviceId, t.orgId], foreignColumns: [devices.id, devices.orgId],
    name: 'device_wake_status_device_org_fk' }).onUpdate('cascade').onDelete('cascade'),
  check('device_wake_status_readiness_state_chk', sql`${t.readinessState} IN ('ready', 'needs_reboot', 'not_configured', 'apply_failed', 'firmware_protected', 'unproven', 'no_wired_adapter', 'unsupported_vm')`),
]);

// SQL is authoritative for DEFERRABLE INITIALLY IMMEDIATE; Drizzle cannot express it.
export const deviceWakeAttempts = pgTable('device_wake_attempts', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  deviceId: uuid('device_id').notNull(),
  relayDeviceId: uuid('relay_device_id').references(() => devices.id, { onDelete: 'set null' }),
  relayHostname: text('relay_hostname'),
  deviceCommandId: uuid('device_command_id'),
  requestedBy: uuid('requested_by'),
  bulkId: uuid('bulk_id'),
  macs: text('macs').array(),
  broadcast: text('broadcast'),
  outcome: varchar('outcome', { length: 16 }).$type<WakeAttemptOutcome>().notNull(),
  refusalCode: varchar('refusal_code', { length: 32 }),
  bootAfterSend: boolean('boot_after_send').notNull().default(false),
  sendCount: integer('send_count').notNull().default(1),
  requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
  deadlineAt: timestamp('deadline_at', { withTimezone: true }),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
}, (t) => [
  foreignKey({ columns: [t.deviceId, t.orgId], foreignColumns: [devices.id, devices.orgId],
    name: 'device_wake_attempts_device_org_fk' }).onUpdate('cascade').onDelete('cascade'),
  check('device_wake_attempts_outcome_chk', sql`${t.outcome} IN ('pending', 'sent', 'send_failed', 'came_online', 'timed_out', 'unknown', 'refused')`),
  uniqueIndex('device_wake_attempts_open_uidx').on(t.deviceId)
    .where(sql`${t.outcome} IN ('pending','sent')`),
  index('device_wake_attempts_relay_idx').on(t.relayDeviceId)
    .where(sql`${t.relayDeviceId} IS NOT NULL`),
  index('device_wake_attempts_deadline_idx').on(t.deadlineAt)
    .where(sql`${t.outcome} IN ('pending','sent')`),
  index('device_wake_attempts_device_requested_idx').on(t.deviceId, t.requestedAt.desc()),
  index('device_wake_attempts_org_requested_idx').on(t.orgId, t.requestedAt.desc()),
]);
