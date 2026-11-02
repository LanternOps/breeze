import { sql } from 'drizzle-orm';
import {
  bigint, boolean, check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, varchar,
} from 'drizzle-orm/pg-core';
import { organizations } from './orgs';
import { devices } from './devices';
import { incidentActions, incidents } from './incidentResponse';
import { users } from './users';
import type {
  IsolationAllowEntry,
  IsolationDesiredState,
  IsolationFailureCode,
  IsolationMechanism,
  IsolationReleaseKind,
  IsolationRequestedByKind,
  IsolationState,
  SafeAgentReport,
} from '@breeze/shared';

/**
 * Network-isolation containment episodes (#10089 W1a, feature #10088, spec
 * docs/superpowers/specs/security/2026-10-25-network-isolation-containment-spec.md §3.2, §4).
 *
 * One row per isolate request; at most one UNRESOLVED row per device (partial unique index). The row
 * keeps three things apart: the server's intent (`desiredState` + monotonic `generation`, release
 * tombstones), what the agent reports it actually did (`state`, `mechanism`, `lastAgentReport`), and
 * the ordering high-water mark (`lastJournalSeq`). Command delivery stays in device_commands.
 *
 * RLS shape 1 on org_id. Migration 2027-01-17-200000-device-network-isolations.sql is the source of
 * truth for what Drizzle cannot express:
 *  - all three composite FKs are DEFERRABLE INITIALLY IMMEDIATE;
 *  - the incident and action FKs use the column-list form ON DELETE SET NULL (incident_id) /
 *    (incident_action_id) — declared below as plain `set null` only so moveOrg.coverage.test.ts can
 *    see the composite (x, org_id) pointers that justify the org-move delete disposition; a bare
 *    composite SET NULL would null org_id too, so never generate DDL from these declarations
 *    (hand-written SQL only, per apps/api/migrations/README.md);
 *  - the BEFORE UPDATE OF org_id trigger on devices (breeze_network_isolation_device_moved) that
 *    deletes resolved, confirmed history before a device org flip and refuses one while an episode is
 *    unresolved or a release tombstone is unconfirmed;
 *  - desired_state = 'isolated' exactly while the state is isolating (desired_matches_state_chk).
 *
 * `breakGlassSecretEnc` is row-bound ciphertext (encryptedColumnRegistry: AAD = episode id). It is
 * NOT NULL, so erasing it when the episode resolves (W1b) writes '' and readers treat '' as no secret.
 */
export const deviceNetworkIsolations = pgTable('device_network_isolations', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  deviceId: uuid('device_id').notNull(),
  incidentId: uuid('incident_id'),
  incidentActionId: uuid('incident_action_id'),
  desiredState: varchar('desired_state', { length: 16 }).$type<IsolationDesiredState>().notNull().default('isolated'),
  state: varchar('state', { length: 32 }).$type<IsolationState>().notNull().default('requested'),
  generation: integer('generation').notNull().default(1),
  acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
  acknowledgedBy: uuid('acknowledged_by').references(() => users.id, { onDelete: 'set null' }),
  /** Encrypted under APP_ENCRYPTION_KEY; '' once erased at resolution. Never logged or audited. */
  breakGlassSecretEnc: text('break_glass_secret_enc').notNull(),
  requestedByKind: varchar('requested_by_kind', { length: 16 }).$type<IsolationRequestedByKind>().notNull(),
  requestedByUserId: uuid('requested_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  reason: text('reason').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  deadManSeconds: integer('dead_man_seconds').notNull().default(0),
  remoteRelay: boolean('remote_relay').notNull().default(false),
  mechanism: varchar('mechanism', { length: 16 }).$type<IsolationMechanism>(),
  /** What was sent: hostnames only, never resolved addresses. */
  allowSnapshot: jsonb('allow_snapshot').$type<IsolationAllowEntry[]>().notNull().default([]),
  lastAgentReport: jsonb('last_agent_report').$type<SafeAgentReport | null>(),
  failureCode: varchar('failure_code', { length: 48 }).$type<IsolationFailureCode>(),
  releaseKind: varchar('release_kind', { length: 24 }).$type<IsolationReleaseKind>(),
  commandId: uuid('command_id'),
  releaseCommandId: uuid('release_command_id'),
  expiryWarnedAt: timestamp('expiry_warned_at', { withTimezone: true }),
  breakGlassAckSeq: bigint('break_glass_ack_seq', { mode: 'number' }),
  lastJournalSeq: bigint('last_journal_seq', { mode: 'number' }).notNull().default(0),
  releaseConfirmedAt: timestamp('release_confirmed_at', { withTimezone: true }),
  requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
  dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
  appliedAt: timestamp('applied_at', { withTimezone: true }),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  releaseRequestedAt: timestamp('release_requested_at', { withTimezone: true }),
  releasedAt: timestamp('released_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  foreignKey({
    name: 'device_network_isolations_device_fk',
    columns: [table.deviceId, table.orgId],
    foreignColumns: [devices.id, devices.orgId],
  }).onDelete('cascade'),
  // SQL: ON DELETE SET NULL (incident_id) — see the header.
  foreignKey({
    name: 'device_network_isolations_incident_fk',
    columns: [table.incidentId, table.orgId],
    foreignColumns: [incidents.id, incidents.orgId],
  }).onDelete('set null'),
  // SQL: ON DELETE SET NULL (incident_action_id) — see the header.
  foreignKey({
    name: 'device_network_isolations_incident_action_fk',
    columns: [table.incidentActionId, table.orgId],
    foreignColumns: [incidentActions.id, incidentActions.orgId],
  }).onDelete('set null'),
  uniqueIndex('device_network_isolations_one_unresolved_uniq')
    .on(table.deviceId)
    .where(sql`state NOT IN ('released', 'expired', 'failed', 'uninstalled')`),
  index('device_network_isolations_org_state_idx').on(table.orgId, table.state),
  index('device_network_isolations_active_expiry_idx')
    .on(table.expiresAt)
    .where(sql`state IN ('requested', 'dispatched', 'applying', 'applied', 'verified', 'release_requested')`),
  index('device_network_isolations_unconfirmed_tombstone_idx')
    .on(table.deviceId)
    .where(sql`desired_state = 'released' AND release_confirmed_at IS NULL`),
  index('device_network_isolations_device_created_idx').on(table.deviceId, table.createdAt.desc()),
  index('device_network_isolations_incident_idx').on(table.incidentId).where(sql`incident_id IS NOT NULL`),
  index('device_network_isolations_incident_action_idx')
    .on(table.incidentActionId)
    .where(sql`incident_action_id IS NOT NULL`),
  check('device_network_isolations_failed_has_code_chk', sql`(state = 'failed') = (failure_code IS NOT NULL)`),
  check(
    'device_network_isolations_desired_matches_state_chk',
    sql`(desired_state = 'isolated') = (state IN ('requested', 'dispatched', 'applying', 'applied', 'verified'))`,
  ),
  check('device_network_isolations_generation_chk', sql`generation >= 1`),
  check('device_network_isolations_journal_seq_chk', sql`last_journal_seq >= 0`),
]);

export type DeviceNetworkIsolation = typeof deviceNetworkIsolations.$inferSelect;
export type NewDeviceNetworkIsolation = typeof deviceNetworkIsolations.$inferInsert;
