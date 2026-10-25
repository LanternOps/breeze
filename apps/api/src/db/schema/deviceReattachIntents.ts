import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { devices } from './devices';
import { partners } from './orgs';
import { users } from './users';

export type DeviceReattachIntentState = 'requested' | 'staged' | 'confirmed' | 'expired' | 'cancelled';
export type DeviceReattachEvidenceLevel = 'hint' | 'tpm_continuity';

/**
 * A human-authorized reattach of a newly enrolled install (the source device)
 * onto an existing record (the target), #8318 wave 1b (spec §4.3, §6).
 *
 * Partner-axis (shape 3), narrowed by a RESTRICTIVE org-access policy over
 * target_org_id / source_org_id; source_parked is derived by trigger from the
 * source org's type and never written by callers. The authorized identity
 * columns are immutable and the end states are terminal (guard trigger). The
 * per-state shape CHECK (which staged columns a state may hold) lives in the
 * migration only — see migrations/2027-01-06-120100-device-reattach-intents.sql.
 */
export const deviceReattachIntents = pgTable('device_reattach_intents', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id, { onDelete: 'cascade' }),
  sourceDeviceId: uuid('source_device_id').notNull().references(() => devices.id, { onDelete: 'cascade' }),
  targetDeviceId: uuid('target_device_id').notNull().references(() => devices.id, { onDelete: 'cascade' }),
  state: text('state').$type<DeviceReattachIntentState>().notNull(),
  cancelReason: text('cancel_reason'),
  evidenceLevel: text('evidence_level').$type<DeviceReattachEvidenceLevel>().notNull(),
  restoreDecommissioned: boolean('restore_decommissioned').notNull().default(false),
  requestedBy: uuid('requested_by').references(() => users.id, { onDelete: 'set null' }),
  requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  stepUpGrantRef: text('step_up_grant_ref'),
  sourceAgentId: varchar('source_agent_id', { length: 64 }).notNull(),
  sourceOrgId: uuid('source_org_id').notNull(),
  /** Set by trigger from the source org's type; any written value is overwritten. */
  sourceParked: boolean('source_parked').notNull().default(false),
  targetAgentId: varchar('target_agent_id', { length: 64 }).notNull(),
  targetIncarnation: integer('target_incarnation').notNull(),
  targetOrgId: uuid('target_org_id').notNull(),
  stagedAgentId: varchar('staged_agent_id', { length: 64 }),
  stagedTokenHash: varchar('staged_token_hash', { length: 64 }),
  stagedWatchdogTokenHash: varchar('staged_watchdog_token_hash', { length: 64 }),
  stagedHelperTokenHash: varchar('staged_helper_token_hash', { length: 64 }),
  confirmationTokenHash: varchar('confirmation_token_hash', { length: 64 }),
  /** The target's pending_activation device_mtls_certificates row (no FK). */
  stagedMtlsCertificateId: uuid('staged_mtls_certificate_id'),
  stagedAt: timestamp('staged_at', { withTimezone: true }),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
}, (table) => [
  uniqueIndex('device_reattach_intents_open_source_uq')
    .on(table.sourceDeviceId)
    .where(sql`${table.state} IN ('requested', 'staged')`),
  uniqueIndex('device_reattach_intents_open_target_uq')
    .on(table.targetDeviceId)
    .where(sql`${table.state} IN ('requested', 'staged')`),
  index('device_reattach_intents_source_device_idx').on(table.sourceDeviceId),
  index('device_reattach_intents_target_device_idx').on(table.targetDeviceId),
  index('device_reattach_intents_partner_idx').on(table.partnerId),
  index('device_reattach_intents_requested_by_idx').on(table.requestedBy),
  index('device_reattach_intents_source_agent_idx').on(table.sourceAgentId),
  index('device_reattach_intents_open_expiry_idx')
    .on(table.expiresAt)
    .where(sql`${table.state} IN ('requested', 'staged')`),
  index('device_reattach_intents_requested_at_idx').on(table.requestedAt),
  check('device_reattach_intents_state_chk',
    sql`${table.state} IN ('requested', 'staged', 'confirmed', 'expired', 'cancelled')`),
  check('device_reattach_intents_evidence_level_chk',
    sql`${table.evidenceLevel} IN ('hint', 'tpm_continuity')`),
  check('device_reattach_intents_distinct_devices_chk',
    sql`${table.sourceDeviceId} <> ${table.targetDeviceId}`),
]);

export type DeviceReattachIntent = typeof deviceReattachIntents.$inferSelect;
export type NewDeviceReattachIntent = typeof deviceReattachIntents.$inferInsert;
