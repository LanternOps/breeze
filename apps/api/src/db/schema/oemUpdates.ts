import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import type { OemLane, OemOutcome } from '@breeze/shared';
import { organizations } from './orgs';
import { devices } from './devices';

export const OEM_APPLICABILITY_STATES = ['applicable', 'not_applicable', 'not_supported'] as const;
export type OemApplicabilityState = (typeof OEM_APPLICABILITY_STATES)[number];

export const OEM_TAKEOVER_STATES = ['none', 'taken_over', 'policy_locked', 'releasing'] as const;
export type OemTakeoverState = (typeof OEM_TAKEOVER_STATES)[number];

export type OemBitlockerState = 'on' | 'suspended' | 'off' | 'unknown';

/**
 * One row per device for the vendor update command (#11065).
 * Device state, so `org_id` is the device's org, restamped by the composite FK
 * when the device moves. Run history stays in `device_commands.result`.
 */
export const deviceOemUpdateStatus = pgTable('device_oem_update_status', {
  id: uuid('id').primaryKey().defaultRandom(),
  deviceId: uuid('device_id').notNull(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  lane: varchar('lane', { length: 16 }).$type<OemLane>(),
  applicability: varchar('applicability', { length: 16 }).$type<OemApplicabilityState>().notNull(),
  reason: varchar('reason', { length: 48 }),
  toolVersion: varchar('tool_version', { length: 64 }),
  occurrenceKey: varchar('occurrence_key', { length: 64 }),
  attempts: integer('attempts').notNull().default(0),
  lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
  lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
  lastOutcome: varchar('last_outcome', { length: 32 }).$type<OemOutcome>(),
  lastErrorCode: varchar('last_error_code', { length: 64 }),
  // Bare uuid: device_commands is system-scoped and keeps its own retention.
  lastCommandId: uuid('last_command_id'),
  installedCount: integer('installed_count').notNull().default(0),
  failedCount: integer('failed_count').notNull().default(0),
  rebootRequired: boolean('reboot_required').notNull().default(false),
  biosVersionBefore: varchar('bios_version_before', { length: 100 }),
  biosVersionAfter: varchar('bios_version_after', { length: 100 }),
  firstCompletedAt: timestamp('first_completed_at', { withTimezone: true }),
  runStartedAt: timestamp('run_started_at', { withTimezone: true }),
  returnDeadlineAt: timestamp('return_deadline_at', { withTimezone: true }),
  notReturnedAlertedAt: timestamp('not_returned_alerted_at', { withTimezone: true }),
  rebootPendingSince: timestamp('reboot_pending_since', { withTimezone: true }),
  takeoverState: varchar('takeover_state', { length: 16 }).$type<OemTakeoverState>().notNull().default('none'),
  notSupportedToolVersion: varchar('not_supported_tool_version', { length: 64 }),
  notSupportedModel: varchar('not_supported_model', { length: 255 }),
  bitlockerAfter: varchar('bitlocker_after', { length: 16 }).$type<OemBitlockerState>(),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  foreignKey({
    columns: [table.deviceId, table.orgId],
    foreignColumns: [devices.id, devices.orgId],
    name: 'device_oem_update_status_device_org_fk',
  }).onUpdate('cascade').onDelete('cascade'),
  uniqueIndex('device_oem_update_status_device_uidx').on(table.deviceId),
  index('device_oem_update_status_org_applicability_idx').on(table.orgId, table.applicability),
  index('device_oem_update_status_return_deadline_idx')
    .on(table.returnDeadlineAt)
    .where(sql`${table.returnDeadlineAt} IS NOT NULL`),
  check(
    'device_oem_update_status_lane_chk',
    sql`${table.lane} IS NULL OR ${table.lane} IN ('dell', 'surface', 'hp', 'lenovo')`,
  ),
  check(
    'device_oem_update_status_applicability_chk',
    sql`${table.applicability} IN ('applicable', 'not_applicable', 'not_supported')`,
  ),
  check(
    'device_oem_update_status_last_outcome_chk',
    sql`${table.lastOutcome} IS NULL OR ${table.lastOutcome} IN ('success', 'success_reboot_required', 'no_updates', 'partial', 'failed', 'not_supported', 'tool_unavailable', 'blocked_on_battery', 'blocked_reboot_pending', 'blocked_no_recovery_key', 'retry_later', 'interrupted')`,
  ),
  check(
    'device_oem_update_status_takeover_state_chk',
    sql`${table.takeoverState} IN ('none', 'taken_over', 'policy_locked', 'releasing')`,
  ),
  check(
    'device_oem_update_status_bitlocker_after_chk',
    sql`${table.bitlockerAfter} IS NULL OR ${table.bitlockerAfter} IN ('on', 'suspended', 'off', 'unknown')`,
  ),
]);

export type DeviceOemUpdateStatus = typeof deviceOemUpdateStatus.$inferSelect;
export type NewDeviceOemUpdateStatus = typeof deviceOemUpdateStatus.$inferInsert;

export const OEM_POLICY_REBOOT_MODES = ['overnight', 'never'] as const;
export type OemPolicyRebootMode = (typeof OEM_POLICY_REBOOT_MODES)[number];

/**
 * What a device's vendor updates policy contributes to its display state (#11242),
 * kept per device by the policy-side refresh (`policySideStore.ts`) so the fleet view counts and
 * pages in SQL. Only the half that is stable between known instants: the query
 * compares `now` against these boundaries itself (`displayStateSql.ts`).
 *
 * Every computed device has a row, so a missing row means "not computed yet", not
 * "no lane". Derived device state: `org_id` is the device's org, restamped by the
 * composite FK when the device moves.
 */
export const deviceOemPolicySide = pgTable('device_oem_policy_side', {
  deviceId: uuid('device_id').primaryKey(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  offeredLane: varchar('offered_lane', { length: 16 }).$type<OemLane>(),
  gatesFingerprint: varchar('gates_fingerprint', { length: 64 }).notNull(),
  // Bare uuid: a derived pointer, recomputed on every refresh.
  linkId: uuid('link_id'),
  linkEnabled: boolean('link_enabled').notNull().default(false),
  rebootMode: varchar('reboot_mode', { length: 16 }).$type<OemPolicyRebootMode>(),
  occurrenceKey: varchar('occurrence_key', { length: 64 }),
  lastNightStart: timestamp('last_night_start', { withTimezone: true }),
  pastLastNightAt: timestamp('past_last_night_at', { withTimezone: true }),
  refreshAfter: timestamp('refresh_after', { withTimezone: true }),
  managedSince: timestamp('managed_since', { withTimezone: true }),
  computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  foreignKey({
    columns: [table.deviceId, table.orgId],
    foreignColumns: [devices.id, devices.orgId],
    name: 'device_oem_policy_side_device_org_fk',
  }).onUpdate('cascade').onDelete('cascade'),
  index('device_oem_policy_side_org_idx').on(table.orgId),
  index('device_oem_policy_side_refresh_idx')
    .on(table.refreshAfter)
    .where(sql`${table.refreshAfter} IS NOT NULL`),
  check(
    'device_oem_policy_side_lane_chk',
    sql`${table.offeredLane} IS NULL OR ${table.offeredLane} IN ('dell', 'surface', 'hp', 'lenovo')`,
  ),
  check(
    'device_oem_policy_side_reboot_mode_chk',
    sql`${table.rebootMode} IS NULL OR ${table.rebootMode} IN ('overnight', 'never')`,
  ),
]);

export type DeviceOemPolicySide = typeof deviceOemPolicySide.$inferSelect;
export type NewDeviceOemPolicySide = typeof deviceOemPolicySide.$inferInsert;
