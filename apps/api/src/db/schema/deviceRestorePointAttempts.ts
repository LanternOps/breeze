import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { devices } from './devices';
import { organizations } from './orgs';

export const RESTORE_POINT_ATTEMPT_TRIGGERS = ['patch', 'script', 'software_install'] as const;
export type RestorePointAttemptTrigger = (typeof RESTORE_POINT_ATTEMPT_TRIGGERS)[number];

export const RESTORE_POINT_ATTEMPT_STATUSES = [
  'requested',
  'created',
  'existing_accepted',
  'skipped_disabled',
  'skipped_definition_only',
  'unsupported',
  'busy',
  'insufficient_privileges',
  'verification_failed',
  'failed',
] as const;
export type RestorePointAttemptStatus = (typeof RESTORE_POINT_ATTEMPT_STATUSES)[number];

/**
 * Every Windows System Restore checkpoint Breeze requested before a risky
 * action, and what was observed to happen (#4609, W04 #4755).
 *
 * The ONLY durable record -- terminal command processing erases the payload
 * the request was stamped into. The row is created at command-creation time
 * with status 'requested' and terminalised from the agent's result, so an
 * absent row means "we never asked". Records attempts and observations, never a
 * promise of recoverability (a created point can later be purged by VSS).
 *
 * The composite (device_id, org_id) FK is DEFERRABLE INITIALLY IMMEDIATE in the
 * migration (org merge defers constraints); Drizzle's foreignKey() builder
 * cannot express that, so the migration is authoritative.
 *
 * NO jsonb/bytea columns, deliberately: every field is typed, which is what
 * lets the whole table classify as `included` in CORE_TENANT_EXPORT_POLICY
 * with nothing in excludedOpen. A new column here must be classified there in
 * the same PR.
 */
export const deviceRestorePointAttempts = pgTable('device_restore_point_attempts', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** Idempotency key from the command's restorePoint block (unique). */
  requestId: uuid('request_id').notNull(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  deviceId: uuid('device_id').notNull(),
  /** Optional, and NOT the identity: the direct non-UUID software path has no device_commands row. */
  deviceCommandId: uuid('device_command_id'),
  trigger: varchar('trigger', { length: 24 }).$type<RestorePointAttemptTrigger>().notNull(),
  status: varchar('status', { length: 32 }).$type<RestorePointAttemptStatus>().notNull(),
  /** INT64 on Windows -- rendered as a decimal STRING on the wire (JS safe-integer range). */
  sequenceNumber: bigint('sequence_number', { mode: 'bigint' }),
  description: text('description'),
  message: text('message'),
  policyRevision: text('policy_revision'),
  acceptedExistingPoint: boolean('accepted_existing_point').notNull().default(false),
  existingPointAgeMinutes: integer('existing_point_age_minutes'),
  frequencyMinutes: integer('frequency_minutes'),
  durationMs: integer('duration_ms'),
  /** Server clock, at command creation. */
  requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
  /** Agent clock. */
  attemptedAt: timestamp('attempted_at', { withTimezone: true }),
  /** Server clock, at result ingest. */
  receivedAt: timestamp('received_at', { withTimezone: true }),
  scriptExecutionId: uuid('script_execution_id'),
  softwareDeploymentId: uuid('software_deployment_id'),
  patchJobId: uuid('patch_job_id'),
}, (table) => [
  foreignKey({
    columns: [table.deviceId, table.orgId],
    foreignColumns: [devices.id, devices.orgId],
    name: 'device_restore_point_attempts_device_org_fk',
  }).onUpdate('cascade').onDelete('cascade'),
  uniqueIndex('device_restore_point_attempts_request_uidx').on(table.requestId),
  index('device_restore_point_attempts_device_requested_idx')
    .on(table.deviceId, table.requestedAt.desc()),
  index('device_restore_point_attempts_org_requested_idx')
    .on(table.orgId, table.requestedAt.desc()),
  index('device_restore_point_attempts_pending_idx')
    .on(table.requestedAt)
    .where(sql`${table.status} = 'requested'`),
  check(
    'device_restore_point_attempts_trigger_chk',
    sql`${table.trigger} IN ('patch', 'script', 'software_install')`,
  ),
  check(
    'device_restore_point_attempts_status_chk',
    sql`${table.status} IN ('requested', 'created', 'existing_accepted', 'skipped_disabled', 'skipped_definition_only', 'unsupported', 'busy', 'insufficient_privileges', 'verification_failed', 'failed')`,
  ),
]);

export type DeviceRestorePointAttempt = typeof deviceRestorePointAttempts.$inferSelect;
export type NewDeviceRestorePointAttempt = typeof deviceRestorePointAttempts.$inferInsert;
