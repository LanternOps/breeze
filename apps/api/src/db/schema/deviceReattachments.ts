import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { partners } from './orgs';
import type { DeviceReattachEvidenceLevel } from './deviceReattachIntents';

/** The boundary's invalidation counts, by handler id then `<table>[.<action>]`. */
export type DeviceReattachmentInvalidationCounts = Record<string, Record<string, number>>;

/**
 * Append-only ledger of confirmed reattaches, #8318 wave 1b (spec §4.4).
 * Partner-axis (shape 3); every device / org / site / user / intent column is
 * a snapshot with NO FK, so the record outlives them. UPDATE is blocked by
 * trigger; writes are system-scope only and reads are narrowed by the intent
 * table's org-access branch over the snapshot org columns — see
 * migrations/2027-01-07-120200-device-reattachments.sql.
 */
export const deviceReattachments = pgTable('device_reattachments', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id, { onDelete: 'cascade' }),
  intentId: uuid('intent_id').notNull(),
  sourceDeviceId: uuid('source_device_id').notNull(),
  sourceAgentId: varchar('source_agent_id', { length: 64 }).notNull(),
  sourceOrgId: uuid('source_org_id').notNull(),
  sourceParked: boolean('source_parked').notNull(),
  targetDeviceId: uuid('target_device_id').notNull(),
  targetOrgId: uuid('target_org_id').notNull(),
  targetSiteId: uuid('target_site_id').notNull(),
  targetPreviousAgentId: varchar('target_previous_agent_id', { length: 64 }).notNull(),
  stagedAgentId: varchar('staged_agent_id', { length: 64 }).notNull(),
  targetPreviousIncarnation: integer('target_previous_incarnation').notNull(),
  targetNewIncarnation: integer('target_new_incarnation').notNull(),
  actorUserId: uuid('actor_user_id').notNull(),
  evidenceLevel: text('evidence_level').$type<DeviceReattachEvidenceLevel>().notNull(),
  restoreDecommissioned: boolean('restore_decommissioned').notNull().default(false),
  stepUpGrantRef: text('step_up_grant_ref'),
  invalidationCounts: jsonb('invalidation_counts').$type<DeviceReattachmentInvalidationCounts>().notNull().default({}),
  confirmationTokenHash: varchar('confirmation_token_hash', { length: 64 }).notNull(),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('device_reattachments_intent_uq').on(table.intentId),
  uniqueIndex('device_reattachments_confirmation_hash_uq').on(table.confirmationTokenHash),
  index('device_reattachments_source_agent_idx').on(table.sourceAgentId),
  index('device_reattachments_source_device_idx').on(table.sourceDeviceId),
  index('device_reattachments_target_device_idx').on(table.targetDeviceId),
  index('device_reattachments_partner_confirmed_idx').on(table.partnerId, table.confirmedAt),
  check('device_reattachments_evidence_level_chk',
    sql`${table.evidenceLevel} IN ('hint', 'tpm_continuity')`),
  check('device_reattachments_distinct_devices_chk',
    sql`${table.sourceDeviceId} <> ${table.targetDeviceId}`),
]);

export type DeviceReattachment = typeof deviceReattachments.$inferSelect;
export type NewDeviceReattachment = typeof deviceReattachments.$inferInsert;
