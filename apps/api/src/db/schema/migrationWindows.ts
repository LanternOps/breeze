import { check, foreignKey, index, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uuid, varchar } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations, partners } from './orgs';
import { partnerServicePrincipals } from './partnerServicePrincipals';
import { users } from './users';

export type MigrationWindowStatus = 'open' | 'closed';
export type MigrationWindowClosedReason = 'expired' | 'closed_by_admin' | 'principal_inactive' | 'opener_inactive';

/** Per-org counts written once at close (spec §3.5). */
export type MigrationWindowSummary = {
  orgs: Array<{ orgId: string; ticketsImported: number; commentsImported: number }>;
  ticketsImported: number;
  commentsImported: number;
};

/**
 * Ticket migration windows (#8313; spec
 * docs/superpowers/specs/api-platform/2026-10-10-ticket-migration-windows-design.md
 * §3; migration 2026-12-23-110000). A window grants ONE keyless partner
 * service principal import mode, for one time box, on the organizations in
 * migration_window_orgs. Partner-axis (shape 3): RLS is
 * `system OR breeze_has_partner_access(partner_id)`, registered in
 * PARTNER_TENANT_TABLES, and erased with its partner.
 *
 * Partial indexes not modeled here: migration_windows_one_open_per_partner
 * (partner_id) WHERE status = 'open' — the one-open-window rule — and
 * migration_windows_principal_open_idx (partner_service_principal_id)
 * WHERE status = 'open'.
 */
export const migrationWindows = pgTable('migration_windows', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id, { onDelete: 'cascade' }),
  partnerServicePrincipalId: uuid('partner_service_principal_id').notNull(),
  sourceLabel: varchar('source_label', { length: 64 }).notNull(),
  status: text('status').$type<MigrationWindowStatus>().notNull().default('open'),
  openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
  endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
  writesPerHour: integer('writes_per_hour').notNull(),
  // ON DELETE SET NULL (both): org erasure and user deletion never abort on a
  // window. A window whose opener is gone is closed as opener_inactive.
  openedBy: uuid('opened_by').references(() => users.id, { onDelete: 'set null' }),
  // The opener's credential state at open (#8332): a window ends when either
  // epoch moves, the same rule partner service principal keys follow.
  openerCredentialEpoch: integer('opener_credential_epoch').notNull(),
  openerMfaEpoch: integer('opener_mfa_epoch').notNull(),
  closedBy: uuid('closed_by').references(() => users.id, { onDelete: 'set null' }),
  closedReason: text('closed_reason').$type<MigrationWindowClosedReason>(),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  summary: jsonb('summary').$type<MigrationWindowSummary>(),
  // Set once every org's migration.window_closed event is published; the
  // sweep retries the publication while it is null.
  summaryPublishedAt: timestamp('summary_published_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('migration_windows_id_partner_uq').on(t.id, t.partnerId),
  foreignKey({
    columns: [t.partnerServicePrincipalId, t.partnerId],
    foreignColumns: [partnerServicePrincipals.id, partnerServicePrincipals.partnerId],
    name: 'migration_windows_principal_fk',
  }).onDelete('cascade'),
  check('migration_windows_status_chk', sql`${t.status} IN ('open', 'closed')`),
  check('migration_windows_writes_per_hour_chk', sql`${t.writesPerHour} BETWEEN 600 AND 100000`),
  check(
    'migration_windows_closed_reason_chk',
    sql`${t.closedReason} IS NULL OR ${t.closedReason} IN ('expired', 'closed_by_admin', 'principal_inactive', 'opener_inactive')`,
  ),
  check('migration_windows_span_chk', sql`${t.endsAt} > ${t.openedAt}`),
  check(
    'migration_windows_closed_shape_chk',
    sql`(${t.status} = 'closed') = (${t.closedAt} IS NOT NULL AND ${t.closedReason} IS NOT NULL)`,
  ),
  index('migration_windows_sweep_idx').on(t.status, t.summaryPublishedAt),
  index('migration_windows_opened_by_idx').on(t.openedBy),
  index('migration_windows_closed_by_idx').on(t.closedBy),
]);

/**
 * The organizations a migration window may write to. A child table rather
 * than a uuid[] so every org-side registration reaches it (spec §3.2).
 * Partner-axis like its window; its org_id is NOT the tenancy axis
 * (ORG_AXIS_POLICY_EXCLUDED_TABLES) but is registered in the org cascade, the
 * merge registry (repoint-dedupe on window_id) and the export policy.
 */
export const migrationWindowOrgs = pgTable('migration_window_orgs', {
  windowId: uuid('window_id').notNull(),
  partnerId: uuid('partner_id').notNull(),
  orgId: uuid('org_id').notNull(),
}, (t) => [
  primaryKey({ name: 'migration_window_orgs_pkey', columns: [t.windowId, t.orgId] }),
  foreignKey({
    columns: [t.windowId, t.partnerId],
    foreignColumns: [migrationWindows.id, migrationWindows.partnerId],
    name: 'migration_window_orgs_window_fk',
  }).onDelete('cascade'),
  // DEFERRABLE INITIALLY IMMEDIATE in SQL: org merge defers constraints.
  foreignKey({
    columns: [t.orgId, t.partnerId],
    foreignColumns: [organizations.id, organizations.partnerId],
    name: 'migration_window_orgs_org_fk',
  }).onDelete('cascade'),
  index('migration_window_orgs_org_idx').on(t.orgId),
  index('migration_window_orgs_partner_idx').on(t.partnerId),
]);
