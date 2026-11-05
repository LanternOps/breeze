import { check, foreignKey, index, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uuid, varchar } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { migrationWindows } from './migrationWindows';
import { organizations, partners } from './orgs';
import { partnerServicePrincipals } from './partnerServicePrincipals';
import { ticketCategories } from './tickets';
import { users } from './users';

/**
 * The ticket import framework (#8313 W4; spec
 * docs/superpowers/specs/api-platform/2026-10-19-ticket-import-modules-design.md
 * §5.5; migration 2027-01-20-100000). Six partner-axis tables (shape 3): RLS
 * is `system OR breeze_has_partner_access(partner_id)`, each is in
 * PARTNER_TENANT_TABLES and is erased with its partner. Partner-wide first:
 * an import spans orgs and is a partner-admin action (#8313 answer 2), so
 * every table is `partner_id NOT NULL` with no `org_id` owner. The one org id,
 * ticket_import_org_maps.org_id, is a target, registered like
 * migration_window_orgs.org_id.
 *
 * Partial indexes not modeled here: ticket_import_org_maps_source_key_uq and
 * ticket_import_org_maps_fallback_uq (one row per source org, at most one
 * fallback), ticket_import_runs_one_active_per_source (one queued or running
 * run per source), ticket_import_runs_window_idx and
 * ticket_import_run_issues_owner_uq (one owner_unmatched row per owner per run).
 */

export const TICKET_IMPORT_RUN_KINDS = ['dry_run', 'import'] as const;
export type TicketImportRunKind = (typeof TICKET_IMPORT_RUN_KINDS)[number];

export const TICKET_IMPORT_RUN_STATES = ['queued', 'running', 'completed', 'stopped', 'failed', 'cancelled'] as const;
export type TicketImportRunState = (typeof TICKET_IMPORT_RUN_STATES)[number];
export const TICKET_IMPORT_ACTIVE_RUN_STATES: readonly TicketImportRunState[] = ['queued', 'running'];

export const TICKET_IMPORT_RUN_PHASES = ['scan', 'links', 'deletions', 'done'] as const;
export type TicketImportRunPhase = (typeof TICKET_IMPORT_RUN_PHASES)[number];

export const TICKET_IMPORT_ITEM_STATES = [
  'imported',
  'skipped',
  'failed',
  'deleted_in_source',
  'hidden_in_source',
  'removed_in_breeze',
  'merged_in_breeze',
] as const;
export type TicketImportItemState = (typeof TICKET_IMPORT_ITEM_STATES)[number];

/** A link a conversion asked for, waiting on its item for the links phase. */
export type PendingLink = { targetKey: string; linkType: 'duplicate_of' | 'related' | 'caused_by' | 'resolves'; at: string };

/**
 * A connected source: one per keyless import principal (resume is per
 * principal, so a second source on a new principal would import everything
 * twice). The id is generated before sealing, and `credentials_encrypted` is
 * row-bound (encryptedColumnRegistry, aadBinding 'row'), written only by
 * services/ticketImport/sourceCredentials.ts. Revoke clears it and stamps
 * revoked_at; the CHECK keeps the two in step. Reads never select it.
 */
export const ticketImportSources = pgTable('ticket_import_sources', {
  id: uuid('id').primaryKey(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id, { onDelete: 'cascade' }),
  module: varchar('module', { length: 32 }).notNull(),
  label: varchar('label', { length: 64 }).notNull(),
  baseUrl: text('base_url').notNull(),
  credentialsEncrypted: text('credentials_encrypted'),
  partnerServicePrincipalId: uuid('partner_service_principal_id').notNull(),
  // Module options (priority map, toggles); never an org or category id.
  options: jsonb('options').$type<Record<string, unknown>>().notNull().default({}),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revokedBy: uuid('revoked_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('ticket_import_sources_id_partner_uq').on(t.id, t.partnerId),
  unique('ticket_import_sources_principal_uq').on(t.partnerServicePrincipalId),
  foreignKey({
    columns: [t.partnerServicePrincipalId, t.partnerId],
    foreignColumns: [partnerServicePrincipals.id, partnerServicePrincipals.partnerId],
    name: 'ticket_import_sources_principal_fk',
  }).onDelete('cascade'),
  check('ticket_import_sources_revoked_chk', sql`(${t.revokedAt} IS NULL) = (${t.credentialsEncrypted} IS NOT NULL)`),
  index('ticket_import_sources_partner_idx').on(t.partnerId),
  index('ticket_import_sources_created_by_idx').on(t.createdBy),
  index('ticket_import_sources_revoked_by_idx').on(t.revokedBy),
]);

/**
 * Source org -> Breeze org. A NULL key is the fallback for a ticket with no
 * org or an unmapped one. A child table, not a jsonb map, so the org id is
 * reached by every org-side registration: ORG_AXIS_POLICY_EXCLUDED_TABLES,
 * the org cascade, the merge registry (repoint) and the export policy.
 */
export const ticketImportOrgMaps = pgTable('ticket_import_org_maps', {
  id: uuid('id').primaryKey().defaultRandom(),
  sourceId: uuid('source_id').notNull(),
  partnerId: uuid('partner_id').notNull(),
  sourceOrgKey: varchar('source_org_key', { length: 255 }),
  // A display snapshot of the source's name for the org.
  sourceOrgName: varchar('source_org_name', { length: 255 }),
  orgId: uuid('org_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  foreignKey({
    columns: [t.sourceId, t.partnerId],
    foreignColumns: [ticketImportSources.id, ticketImportSources.partnerId],
    name: 'ticket_import_org_maps_source_fk',
  }).onDelete('cascade'),
  // DEFERRABLE INITIALLY IMMEDIATE in SQL: org merge defers constraints.
  foreignKey({
    columns: [t.orgId, t.partnerId],
    foreignColumns: [organizations.id, organizations.partnerId],
    name: 'ticket_import_org_maps_org_fk',
  }).onDelete('cascade'),
  index('ticket_import_org_maps_org_idx').on(t.orgId),
  index('ticket_import_org_maps_partner_idx').on(t.partnerId),
]);

/** Source group -> partner category. No row means no category. */
export const ticketImportCategoryMaps = pgTable('ticket_import_category_maps', {
  id: uuid('id').primaryKey().defaultRandom(),
  sourceId: uuid('source_id').notNull(),
  partnerId: uuid('partner_id').notNull(),
  sourceGroupKey: varchar('source_group_key', { length: 255 }).notNull(),
  sourceGroupName: varchar('source_group_name', { length: 255 }),
  categoryId: uuid('category_id').notNull(),
}, (t) => [
  foreignKey({
    columns: [t.sourceId, t.partnerId],
    foreignColumns: [ticketImportSources.id, ticketImportSources.partnerId],
    name: 'ticket_import_category_maps_source_fk',
  }).onDelete('cascade'),
  // ticket_categories' UNIQUE (id, partner_id) lives in SQL only (2026-06-10-c).
  foreignKey({
    columns: [t.categoryId, t.partnerId],
    foreignColumns: [ticketCategories.id, ticketCategories.partnerId],
    name: 'ticket_import_category_maps_category_fk',
  }).onDelete('cascade'),
  unique('ticket_import_category_maps_uq').on(t.sourceId, t.sourceGroupKey),
  index('ticket_import_category_maps_category_idx').on(t.categoryId),
  index('ticket_import_category_maps_partner_idx').on(t.partnerId),
]);

/**
 * One run of a source (spec §5.8): a dry run (no window) or an import (one
 * migration window). A run is executed by self-continuing slices; only the
 * slice whose seq equals `slice_seq` may write it, and it advances the
 * sequence with a compare-and-set. `cursor` is the framework's position
 * (services/ticketImport/runCursor.ts) and `counters` the typed report
 * (services/ticketImport/runReport.ts).
 */
export const ticketImportRuns = pgTable('ticket_import_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id, { onDelete: 'cascade' }),
  sourceId: uuid('source_id').notNull(),
  kind: text('kind').$type<TicketImportRunKind>().notNull(),
  windowId: uuid('window_id'),
  state: text('state').$type<TicketImportRunState>().notNull().default('queued'),
  stopReason: text('stop_reason'),
  phase: text('phase').$type<TicketImportRunPhase>().notNull().default('scan'),
  cursor: jsonb('cursor').$type<Record<string, unknown>>().notNull().default({}),
  sliceSeq: integer('slice_seq').notNull().default(0),
  // The execution that claimed the current slice; every commit requires it.
  sliceToken: uuid('slice_token'),
  counters: jsonb('counters').$type<Record<string, unknown>>().notNull().default({}),
  // The source's module options when the run started.
  options: jsonb('options').$type<Record<string, unknown>>().notNull(),
  startedBy: uuid('started_by').references(() => users.id, { onDelete: 'set null' }),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),
  // When a deferred slice is due back; a sign of life for the stalled-run sweep.
  resumeAt: timestamp('resume_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
}, (t) => [
  unique('ticket_import_runs_id_partner_uq').on(t.id, t.partnerId),
  foreignKey({
    columns: [t.sourceId, t.partnerId],
    foreignColumns: [ticketImportSources.id, ticketImportSources.partnerId],
    name: 'ticket_import_runs_source_fk',
  }).onDelete('cascade'),
  foreignKey({
    columns: [t.windowId, t.partnerId],
    foreignColumns: [migrationWindows.id, migrationWindows.partnerId],
    name: 'ticket_import_runs_window_fk',
  }).onDelete('cascade'),
  check('ticket_import_runs_kind_chk', sql`${t.kind} IN ('dry_run', 'import')`),
  check('ticket_import_runs_state_chk', sql`${t.state} IN ('queued', 'running', 'completed', 'stopped', 'failed', 'cancelled')`),
  check('ticket_import_runs_phase_chk', sql`${t.phase} IN ('scan', 'links', 'deletions', 'done')`),
  check('ticket_import_runs_window_chk', sql`(${t.kind} = 'import') = (${t.windowId} IS NOT NULL)`),
  check('ticket_import_runs_slice_seq_chk', sql`${t.sliceSeq} >= 0`),
  check(
    'ticket_import_runs_finished_chk',
    sql`(${t.state} IN ('completed', 'stopped', 'failed', 'cancelled')) = (${t.finishedAt} IS NOT NULL)`,
  ),
  index('ticket_import_runs_source_started_idx').on(t.sourceId, t.startedAt),
  index('ticket_import_runs_partner_idx').on(t.partnerId),
  index('ticket_import_runs_started_by_idx').on(t.startedBy),
]);

/**
 * The per-source ticket ledger (spec §5.5, §5.9): source keys, versions and
 * codes only, never content. `seen_run_id` is FK-less (runs may be deleted).
 */
export const ticketImportItems = pgTable('ticket_import_items', {
  sourceId: uuid('source_id').notNull(),
  partnerId: uuid('partner_id').notNull(),
  sourceTicketKey: varchar('source_ticket_key', { length: 255 }).notNull(),
  state: text('state').$type<TicketImportItemState>().notNull(),
  // The source version of the last complete import.
  importedVersion: varchar('imported_version', { length: 64 }),
  seenVersion: varchar('seen_version', { length: 64 }),
  seenRunId: uuid('seen_run_id'),
  // FK-less: the Breeze ticket this item imported into, or began to.
  breezeTicketId: uuid('breeze_ticket_id'),
  // Links waiting for the links phase (spec §6.6); NULL when none wait.
  pendingLinks: jsonb('pending_links').$type<PendingLink[]>(),
  failureCode: varchar('failure_code', { length: 64 }),
  // Failed attempts since the last success.
  attempts: integer('attempts').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ name: 'ticket_import_items_pkey', columns: [t.sourceId, t.sourceTicketKey] }),
  foreignKey({
    columns: [t.sourceId, t.partnerId],
    foreignColumns: [ticketImportSources.id, ticketImportSources.partnerId],
    name: 'ticket_import_items_source_fk',
  }).onDelete('cascade'),
  check(
    'ticket_import_items_state_chk',
    sql`${t.state} IN ('imported', 'skipped', 'failed', 'deleted_in_source', 'hidden_in_source', 'removed_in_breeze', 'merged_in_breeze')`,
  ),
  check('ticket_import_items_attempts_chk', sql`${t.attempts} >= 0`),
  index('ticket_import_items_source_state_key_idx').on(t.sourceId, t.state, t.sourceTicketKey),
  index('ticket_import_items_partner_idx').on(t.partnerId),
]);

/**
 * The run report's per-ticket rows (spec §5.10): ids, numbers and codes,
 * never ticket content, so an org's erasure leaves nothing personal here.
 */
export const ticketImportRunIssues = pgTable('ticket_import_run_issues', {
  id: uuid('id').primaryKey().defaultRandom(),
  runId: uuid('run_id').notNull(),
  partnerId: uuid('partner_id').notNull(),
  sourceTicketKey: varchar('source_ticket_key', { length: 255 }),
  sourceTicketNumber: varchar('source_ticket_number', { length: 255 }),
  kind: varchar('kind', { length: 48 }).notNull(),
  code: varchar('code', { length: 64 }),
  count: integer('count').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  foreignKey({
    columns: [t.runId, t.partnerId],
    foreignColumns: [ticketImportRuns.id, ticketImportRuns.partnerId],
    name: 'ticket_import_run_issues_run_fk',
  }).onDelete('cascade'),
  check('ticket_import_run_issues_count_chk', sql`${t.count} >= 1`),
  index('ticket_import_run_issues_run_idx').on(t.runId, t.kind, t.createdAt, t.id),
  index('ticket_import_run_issues_partner_idx').on(t.partnerId),
]);
