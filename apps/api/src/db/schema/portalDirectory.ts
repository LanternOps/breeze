import { pgTable, uuid, text, integer, boolean, timestamp, check, unique, index, foreignKey } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations } from './orgs';
import { users } from './users';
import { portalUserIdentities, portalUsers } from './portal';

/**
 * Portal registration W8 (#11385): directory deprovisioning runs and actions.
 * Plan: docs/superpowers/plans/portal/2026-11-12-portal-registration-options-w08-directory-deprovisioning.md
 * (D4, D7, D8, D9, D12). Migration: 2027-01-24-200000-portal-directory-deprovisioning.sql,
 * which is the spec of record; this file mirrors it.
 *
 * Both tables are tenancy shape 1 (direct org_id, RLS enabled + forced,
 * breeze_has_org_access per command). `org_id NOT NULL` by design: a run is
 * evidence about one org's directory, not configuration.
 */

export type PortalDirectorySource = 'entra' | 'google';
export type PortalDirectoryRunOutcome = 'evaluated' | 'incomplete' | 'suspect_shrink' | 'skipped';
export type PortalDirectoryRunReason =
  | 'tenant_not_proven' | 'tenant_mismatch' | 'connection_inactive' | 'org_inactive'
  | 'sync_incomplete' | 'directory_too_large' | 'scope_missing' | 'access_denied' | 'unavailable'
  | 'connection_invalid' | 'admin_not_admin' | 'mixed_customer' | 'malformed';
export type PortalDirectoryMode = 'report' | 'enforce';
export type PortalDirectoryRunDisposition =
  | 'none' | 'reported' | 'applying' | 'applied' | 'held' | 'held_applied' | 'held_dismissed' | 'superseded';
export type PortalDirectoryHoldReason = 'threshold' | 'first_enforcement';
export type PortalDirectoryActionReason = 'account_disabled' | 'absent' | 'suspended' | 'archived';
export type PortalDirectoryActionEffect = 'identity' | 'identity_and_account';
export type PortalDirectoryActionStatus = 'reported' | 'held' | 'applied' | 'skipped' | 'superseded' | 'restored';

/**
 * One row per directory snapshot an org's source produced. `snapshot_key` is
 * `<connectionId>:<consentGeneration>:<generation>` (Entra) or
 * `<connectionId>:<utcDate>` (Google); `chain_key` is NULL when the run was
 * refused before a chain is known.
 */
export const portalDirectoryRuns = pgTable('portal_directory_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  source: text('source').$type<PortalDirectorySource>().notNull(),
  chainKey: text('chain_key'),
  snapshotKey: text('snapshot_key').notNull(),
  snapshotAt: timestamp('snapshot_at', { withTimezone: true }).notNull(),
  outcome: text('outcome').$type<PortalDirectoryRunOutcome>().notNull(),
  reason: text('reason').$type<PortalDirectoryRunReason>(),
  mode: text('mode').$type<PortalDirectoryMode>().notNull(),
  directoryUserCount: integer('directory_user_count'),
  usableCount: integer('usable_count').notNull().default(0),
  affectedCount: integer('affected_count').notNull().default(0),
  disposition: text('disposition').$type<PortalDirectoryRunDisposition>().notNull(),
  holdReason: text('hold_reason').$type<PortalDirectoryHoldReason>(),
  impactDigest: text('impact_digest'),
  decidedByUserId: uuid('decided_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check('portal_directory_runs_source_chk', sql`${t.source} IN ('entra','google')`),
  check('portal_directory_runs_outcome_chk', sql`${t.outcome} IN ('evaluated','incomplete','suspect_shrink','skipped')`),
  check('portal_directory_runs_reason_chk', sql`${t.reason} IS NULL OR ${t.reason} IN (
    'tenant_not_proven','tenant_mismatch','connection_inactive','org_inactive',
    'sync_incomplete','directory_too_large','scope_missing','access_denied','unavailable',
    'connection_invalid','admin_not_admin','mixed_customer','malformed')`),
  check('portal_directory_runs_mode_chk', sql`${t.mode} IN ('report','enforce')`),
  check('portal_directory_runs_disposition_chk', sql`${t.disposition} IN (
    'none','reported','applying','applied','held','held_applied','held_dismissed','superseded')`),
  check('portal_directory_runs_hold_reason_chk', sql`${t.holdReason} IS NULL OR ${t.holdReason} IN ('threshold','first_enforcement')`),
  unique('portal_directory_runs_snapshot_uq').on(t.orgId, t.source, t.snapshotKey),
  unique('portal_directory_runs_id_org_uq').on(t.id, t.orgId),
  index('portal_directory_runs_chain_idx').on(t.orgId, t.source, t.chainKey, t.createdAt.desc()),
  index('portal_directory_runs_disposition_idx').on(t.disposition, t.createdAt)
    .where(sql`${t.disposition} IN ('applying','held')`),
]);

/**
 * One proposed or applied identity disable per (run, identity). Every
 * composite FK names org_id (ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE
 * in SQL, so org merge can re-tenant parent and child), so an action can never
 * point at a run, identity or account of another org.
 */
export const portalDirectoryActions = pgTable('portal_directory_actions', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull(),
  runId: uuid('run_id').notNull(),
  identityId: uuid('identity_id').notNull(),
  portalUserId: uuid('portal_user_id').notNull(),
  provider: text('provider').$type<PortalDirectorySource>().notNull(),
  reason: text('reason').$type<PortalDirectoryActionReason>().notNull(),
  effect: text('effect').$type<PortalDirectoryActionEffect>().notNull(),
  keepsPassword: boolean('keeps_password').notNull().default(false),
  status: text('status').$type<PortalDirectoryActionStatus>().notNull(),
  skipReason: text('skip_reason'),
  appliedAt: timestamp('applied_at', { withTimezone: true }),
  sessionsPurgedAt: timestamp('sessions_purged_at', { withTimezone: true }),
  restoredAt: timestamp('restored_at', { withTimezone: true }),
  restoredByUserId: uuid('restored_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  foreignKey({
    name: 'portal_directory_actions_run_fk',
    columns: [t.runId, t.orgId],
    foreignColumns: [portalDirectoryRuns.id, portalDirectoryRuns.orgId],
  }).onDelete('cascade'),
  foreignKey({
    name: 'portal_directory_actions_identity_fk',
    columns: [t.identityId, t.orgId],
    foreignColumns: [portalUserIdentities.id, portalUserIdentities.orgId],
  }).onDelete('cascade'),
  foreignKey({
    name: 'portal_directory_actions_user_fk',
    columns: [t.portalUserId, t.orgId],
    foreignColumns: [portalUsers.id, portalUsers.orgId],
  }).onDelete('cascade'),
  unique('portal_directory_actions_run_identity_uq').on(t.runId, t.identityId),
  check('portal_directory_actions_provider_chk', sql`${t.provider} IN ('entra','google')`),
  check('portal_directory_actions_reason_chk', sql`${t.reason} IN ('account_disabled','absent','suspended','archived')`),
  check('portal_directory_actions_effect_chk', sql`${t.effect} IN ('identity','identity_and_account')`),
  check('portal_directory_actions_status_chk',
    sql`${t.status} IN ('reported','held','applied','skipped','superseded','restored')`),
  check('portal_directory_actions_applied_chk',
    sql`(${t.status} IN ('applied','restored')) = (${t.appliedAt} IS NOT NULL)`),
  index('portal_directory_actions_identity_idx').on(t.identityId, t.createdAt.desc()),
  index('portal_directory_actions_purge_idx').on(t.appliedAt)
    .where(sql`${t.status} = 'applied' AND ${t.sessionsPurgedAt} IS NULL`),
]);

export type PortalDirectoryRunRow = typeof portalDirectoryRuns.$inferSelect;
export type PortalDirectoryActionRow = typeof portalDirectoryActions.$inferSelect;
