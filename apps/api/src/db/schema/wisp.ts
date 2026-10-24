import { sql } from 'drizzle-orm';
import {
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
import { organizations, partners } from './orgs';
import { users } from './users';

/**
 * Wisp W02 — the delegation ceiling (Wisp design §4.2;
 * migrations/2027-01-04-100100-wisp-grants.sql).
 *
 * Tenancy: shape 3 (partner-axis) plus ownership constraints. `orgId` is the
 * grant's SCOPE (NULL = partner-wide), not the tenancy axis. The ownership
 * rules RLS cannot express (admin tighten/revoke-only, revisions append-only)
 * are enforced by the `wisp_grants_update_guard` and
 * `wisp_grant_revisions_immutable_guard` triggers in the migration.
 *
 * Import only orgs/users here, never aiAgents/aiOperatorTasks: those modules
 * carry plain `grant_id` / `grant_revision_id` uuid columns whose FKs are
 * SQL-only (same technique as `aiAgentRuns.taskId`).
 */

export type WispGrantStatus = 'active' | 'paused' | 'revoked' | 'expired';

export type WispGrantPauseReason =
  | 'grantor_access_lost'
  | 'grantor_suspended'
  | 'factor_expired'
  | 'entitlement_lost'
  | 'budget_exhausted'
  | 'user_paused'
  | 'partner_disabled';

/**
 * The ceiling a revision pins (Wisp design §4.2). Every list is the grantor's
 * CONCRETE reach at snapshot time; `permissionKeys` may contain the literal
 * `*:*` (partner admin), so consumers match with `permissionGrantMatches`,
 * never set membership (w00 A3).
 */
export type WispCeilingSnapshot = {
  version: 1;
  /** concrete `${resource}:${action}` keys, incl. a literal '*:*' for admins */
  permissionKeys: string[];
  /** explicit org list at snapshot time (partner-wide grants list every reachable live org) */
  orgIds: string[];
  /** null = unrestricted */
  siteIds: string[] | null;
  /** null = agent policy default */
  toolAllowlist: string[] | null;
  deniedTools: string[];
  /**
   * The grantor held `org_access = 'all'` when this revision was pinned AND the
   * grant is partner-wide. Partner-level subjects (aggregates across every org)
   * need this AND the grantor's live `'all'`, so a grantor widened to `'all'`
   * later still needs a refresh (Wisp design §4.4). Absent = false.
   */
  partnerWide?: boolean;
};

export type WispFactorProof = { method: string; verifiedAt: string };

export const wispGrants = pgTable('wisp_grants', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id'),
  grantorUserId: uuid('grantor_user_id').notNull(),
  grantee: text('grantee').$type<'wisp'>().notNull().default('wisp'),
  // FK (current_revision_id, id) -> wisp_grant_revisions(id, grant_id) is
  // SQL-only: DEFERRABLE INITIALLY DEFERRED + ON DELETE SET NULL
  // (current_revision_id), neither of which Drizzle can declare.
  currentRevisionId: uuid('current_revision_id'),
  status: text('status').$type<WispGrantStatus>().notNull().default('active'),
  pausedReason: text('paused_reason').$type<WispGrantPauseReason>(),
  pausedAt: timestamp('paused_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revokedByUserId: uuid('revoked_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull().default(sql`(now() + interval '90 days')`),
  budgetCentsPerDay: integer('budget_cents_per_day').notNull().default(200),
  floorTickMinutes: integer('floor_tick_minutes').notNull().default(30),
  /** W05 (2027-01-04-110300): the floor-tick cursor the wake scheduler advances (W05b). */
  lastFloorTickAt: timestamp('last_floor_tick_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idPartnerUq: unique('wisp_grants_id_partner_uq').on(t.id, t.partnerId),
  orgPartnerFk: foreignKey({
    name: 'wisp_grants_org_partner_fk',
    columns: [t.orgId, t.partnerId],
    foreignColumns: [organizations.id, organizations.partnerId],
  }).onDelete('cascade'),
  grantorPartnerFk: foreignKey({
    name: 'wisp_grants_grantor_partner_fk',
    columns: [t.grantorUserId, t.partnerId],
    foreignColumns: [users.id, users.partnerId],
  }).onDelete('cascade'),
  partnerIdx: index('wisp_grants_partner_idx').on(t.partnerId),
  grantorIdx: index('wisp_grants_grantor_idx').on(t.grantorUserId),
  orgIdx: index('wisp_grants_org_idx').on(t.orgId).where(sql`${t.orgId} IS NOT NULL`),
  liveExpiryIdx: index('wisp_grants_live_expiry_idx').on(t.expiresAt).where(sql`${t.status} IN ('active','paused')`),
  oneLivePerScopeUq: uniqueIndex('wisp_grants_one_live_per_scope_uq')
    .on(t.grantorUserId, t.partnerId, sql`COALESCE(${t.orgId}, '00000000-0000-0000-0000-000000000000'::uuid)`)
    .where(sql`${t.status} IN ('active','paused')`),
  statusChk: check('wisp_grants_status_chk', sql`${t.status} IN ('active','paused','revoked','expired')`),
  granteeChk: check('wisp_grants_grantee_chk', sql`${t.grantee} IN ('wisp')`),
  pausedReasonChk: check('wisp_grants_paused_reason_chk', sql`${t.pausedReason} IS NULL OR ${t.pausedReason} IN ('grantor_access_lost','grantor_suspended','factor_expired','entitlement_lost','budget_exhausted','user_paused','partner_disabled')`),
  pausedShapeChk: check('wisp_grants_paused_shape_chk', sql`(${t.status} = 'paused') = (${t.pausedReason} IS NOT NULL)`),
  budgetChk: check('wisp_grants_budget_chk', sql`${t.budgetCentsPerDay} >= 0 AND ${t.floorTickMinutes} BETWEEN 15 AND 240`),
}));

export const wispGrantRevisions = pgTable('wisp_grant_revisions', {
  id: uuid('id').primaryKey().defaultRandom(),
  grantId: uuid('grant_id').notNull(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id, { onDelete: 'cascade' }),
  revision: integer('revision').notNull(),
  ceilingSnapshot: jsonb('ceiling_snapshot').$type<WispCeilingSnapshot>().notNull(),
  factorProof: jsonb('factor_proof').$type<WispFactorProof>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idGrantUq: unique('wisp_grant_revisions_id_grant_uq').on(t.id, t.grantId),
  grantRevUq: unique('wisp_grant_revisions_grant_rev_uq').on(t.grantId, t.revision),
  grantPartnerFk: foreignKey({
    name: 'wisp_grant_revisions_grant_partner_fk',
    columns: [t.grantId, t.partnerId],
    foreignColumns: [wispGrants.id, wispGrants.partnerId],
  }).onDelete('cascade'),
  partnerIdx: index('wisp_grant_revisions_partner_idx').on(t.partnerId),
  revisionChk: check('wisp_grant_revisions_revision_chk', sql`${t.revision} >= 1`),
}));

export type WispGrantRow = typeof wispGrants.$inferSelect;
export type WispGrantRevisionRow = typeof wispGrantRevisions.$inferSelect;
