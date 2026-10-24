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
import type {
  ConcernFeedback,
  ConcernSeverity,
  ConcernStatus,
  ConcernSubjectKind,
  WatchKind,
  WatchStatus,
} from '@breeze/shared';
import { organizations, partners } from './orgs';
import { users } from './users';
import { wispGrants } from './wisp';

/**
 * Wisp W05 — the triage engine's facts (Wisp design §7.1–7.4;
 * migrations/2027-01-04-110300-wisp-concerns-watches.sql).
 *
 * Tenancy: all three tables are partner-anchored / org-optional (the
 * `connection_health_incidents` shape, w00 A30): `partner_id NOT NULL`,
 * `org_id NULL` = a partner-level row (cross-customer incident concern,
 * partner-wide watch). One FOR ALL policy each — system, or
 * `breeze_has_org_access(org_id)` for org rows, or
 * `breeze_has_partner_access(partner_id)` for partner-level rows. Registered
 * in DUAL_AXIS_TENANT_TABLES and in the three org registries (org rows carry
 * `org_id`; the cascade's `WHERE org_id = $1` never touches partner-level rows).
 *
 * `subject_id` is a soft reference (no FK, deliberately not named
 * `device_id`/`ticket_id`): the retention reaper resolves a concern whose
 * subject is gone with outcome `subject_gone`.
 *
 * Constraints Drizzle cannot express live in the migration only:
 * DEFERRABLE INITIALLY IMMEDIATE on the org-bound composite FKs,
 * `ON DELETE SET NULL (raised_by_grant_id)`, `NULLS NOT DISTINCT` on the
 * live-subject index, and the jsonb size CHECKs.
 */

export const wispConcerns = pgTable('wisp_concerns', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id, { onDelete: 'cascade' }),
  /** null = a partner-level concern (w00 A30). */
  orgId: uuid('org_id'),
  subjectKind: text('subject_kind').$type<ConcernSubjectKind>().notNull(),
  subjectId: uuid('subject_id').notNull(),
  summary: text('summary').notNull(),
  severity: text('severity').$type<ConcernSeverity>().notNull(),
  status: text('status').$type<ConcernStatus>().notNull().default('open'),
  evidence: jsonb('evidence').$type<Record<string, unknown>>().notNull().default({}),
  /** Correlator idempotency key (w00 A30); null for subject-keyed concerns. */
  signature: text('signature'),
  /** Partner-level incidents only: the org-level concerns it groups. */
  childConcernIds: uuid('child_concern_ids').array().notNull().default(sql`'{}'::uuid[]`),
  // FK (raised_by_grant_id, partner_id) -> wisp_grants(id, partner_id)
  // ON DELETE SET NULL (raised_by_grant_id) in SQL.
  raisedByGrantId: uuid('raised_by_grant_id'),
  /** Soft ref to the assessment run that last looked at it. */
  lastAssessedRunId: uuid('last_assessed_run_id'),
  outcome: text('outcome'),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  resolvedByUserId: uuid('resolved_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idPartnerUq: unique('wisp_concerns_id_partner_uq').on(t.id, t.partnerId),
  orgFk: foreignKey({
    name: 'wisp_concerns_org_partner_fk',
    columns: [t.orgId, t.partnerId],
    foreignColumns: [organizations.id, organizations.partnerId],
  }).onDelete('cascade'),
  raisedByGrantFk: foreignKey({
    name: 'wisp_concerns_raised_by_grant_fk',
    columns: [t.raisedByGrantId, t.partnerId],
    foreignColumns: [wispGrants.id, wispGrants.partnerId],
  }),
  // NULLS NOT DISTINCT in SQL: two live partner-level concerns on one subject collide too.
  liveSubjectUq: uniqueIndex('wisp_concerns_live_subject_uq')
    .on(t.partnerId, t.orgId, t.subjectKind, t.subjectId)
    .where(sql`status IN ('open','snoozed')`),
  liveSignatureUq: uniqueIndex('wisp_concerns_live_signature_uq')
    .on(t.partnerId, t.signature)
    .where(sql`status IN ('open','snoozed') AND signature IS NOT NULL`),
  partnerStatusIdx: index('wisp_concerns_partner_status_idx').on(t.partnerId, t.status),
  orgStatusSeverityIdx: index('wisp_concerns_org_status_severity_idx').on(t.orgId, t.status, t.severity),
  reaperIdx: index('wisp_concerns_closed_updated_idx')
    .on(t.status, t.updatedAt)
    .where(sql`status IN ('resolved','dismissed')`),
  raisedByGrantIdx: index('wisp_concerns_raised_by_grant_idx')
    .on(t.raisedByGrantId)
    .where(sql`raised_by_grant_id IS NOT NULL`),
  subjectKindChk: check('wisp_concerns_subject_kind_chk', sql`${t.subjectKind} IN ('ticket','device','alert','org','integration','run','task','incident','quote','invoice','contract','site')`),
  severityChk: check('wisp_concerns_severity_chk', sql`${t.severity} IN ('info','low','medium','high')`),
  statusChk: check('wisp_concerns_status_chk', sql`${t.status} IN ('open','snoozed','resolved','dismissed')`),
  summaryLenChk: check('wisp_concerns_summary_len_chk', sql`char_length(${t.summary}) BETWEEN 1 AND 2000`),
  outcomeLenChk: check('wisp_concerns_outcome_len_chk', sql`${t.outcome} IS NULL OR char_length(${t.outcome}) <= 1000`),
}));

export const wispConcernRecipients = pgTable('wisp_concern_recipients', {
  id: uuid('id').primaryKey().defaultRandom(),
  concernId: uuid('concern_id').notNull(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id, { onDelete: 'cascade' }),
  /** Copied from the concern for RLS only; the concern is the source of truth (w00 A30). */
  orgId: uuid('org_id'),
  grantId: uuid('grant_id').notNull(),
  nudgeCount: integer('nudge_count').notNull().default(0),
  lastNudgedAt: timestamp('last_nudged_at', { withTimezone: true }),
  nextEligibleNudgeAt: timestamp('next_eligible_nudge_at', { withTimezone: true }),
  snoozedUntil: timestamp('snoozed_until', { withTimezone: true }),
  dismissedAt: timestamp('dismissed_at', { withTimezone: true }),
  /** Set by any user action on the concern (snooze / dismiss / resolve / reply / feedback). */
  answeredAt: timestamp('answered_at', { withTimezone: true }),
  feedback: text('feedback').$type<ConcernFeedback>(),
  feedbackAt: timestamp('feedback_at', { withTimezone: true }),
  feedbackNote: text('feedback_note'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  concernGrantUq: unique('wisp_concern_recipients_concern_grant_uq').on(t.concernId, t.grantId),
  concernFk: foreignKey({
    name: 'wisp_concern_recipients_concern_fk',
    columns: [t.concernId, t.partnerId],
    foreignColumns: [wispConcerns.id, wispConcerns.partnerId],
  }).onDelete('cascade'),
  orgFk: foreignKey({
    name: 'wisp_concern_recipients_org_partner_fk',
    columns: [t.orgId, t.partnerId],
    foreignColumns: [organizations.id, organizations.partnerId],
  }).onDelete('cascade'),
  grantFk: foreignKey({
    name: 'wisp_concern_recipients_grant_fk',
    columns: [t.grantId, t.partnerId],
    foreignColumns: [wispGrants.id, wispGrants.partnerId],
  }).onDelete('cascade'),
  grantIdx: index('wisp_concern_recipients_grant_idx').on(t.grantId),
  orgIdx: index('wisp_concern_recipients_org_idx').on(t.orgId).where(sql`org_id IS NOT NULL`),
  partnerIdx: index('wisp_concern_recipients_partner_idx').on(t.partnerId),
  nudgeCountChk: check('wisp_concern_recipients_nudge_count_chk', sql`${t.nudgeCount} >= 0`),
  feedbackChk: check('wisp_concern_recipients_feedback_chk', sql`${t.feedback} IS NULL OR ${t.feedback} IN ('useful','not_useful')`),
  feedbackNoteLenChk: check('wisp_concern_recipients_feedback_note_len_chk', sql`${t.feedbackNote} IS NULL OR char_length(${t.feedbackNote}) <= 200`),
}));

export const wispWatches = pgTable('wisp_watches', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id, { onDelete: 'cascade' }),
  /** null = every org in the grant's ceiling (partner-wide grants only). */
  orgId: uuid('org_id'),
  grantId: uuid('grant_id').notNull(),
  /** = the grantor; FK (owner_user_id, partner_id) -> users(id, partner_id) in SQL. */
  ownerUserId: uuid('owner_user_id').notNull(),
  kind: text('kind').$type<WatchKind>().notNull(),
  params: jsonb('params').$type<Record<string, unknown>>().notNull().default({}),
  cadenceMinutes: integer('cadence_minutes').notNull(),
  status: text('status').$type<WatchStatus>().notNull().default('active'),
  /** The grant status that stopped it; `'paused'` is read by W02's userResumeGrant (A29). */
  stoppedReason: text('stopped_reason'),
  lastRanAt: timestamp('last_ran_at', { withTimezone: true }),
  nextDueAt: timestamp('next_due_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  orgFk: foreignKey({
    name: 'wisp_watches_org_partner_fk',
    columns: [t.orgId, t.partnerId],
    foreignColumns: [organizations.id, organizations.partnerId],
  }).onDelete('cascade'),
  grantFk: foreignKey({
    name: 'wisp_watches_grant_fk',
    columns: [t.grantId, t.partnerId],
    foreignColumns: [wispGrants.id, wispGrants.partnerId],
  }).onDelete('cascade'),
  ownerFk: foreignKey({
    name: 'wisp_watches_owner_fk',
    columns: [t.ownerUserId, t.partnerId],
    foreignColumns: [users.id, users.partnerId],
  }).onDelete('cascade'),
  dueIdx: index('wisp_watches_active_due_idx').on(t.status, t.nextDueAt).where(sql`status = 'active'`),
  grantIdx: index('wisp_watches_grant_idx').on(t.grantId),
  orgIdx: index('wisp_watches_org_idx').on(t.orgId).where(sql`org_id IS NOT NULL`),
  partnerIdx: index('wisp_watches_partner_idx').on(t.partnerId),
  ownerIdx: index('wisp_watches_owner_idx').on(t.ownerUserId),
  kindChk: check('wisp_watches_kind_chk', sql`${t.kind} IN ('ticket_waiting','alert_pattern','backup_health','patch_compliance','security_findings','custom_query','ticket_cluster')`),
  cadenceChk: check('wisp_watches_cadence_chk', sql`${t.cadenceMinutes} BETWEEN 15 AND 10080`),
  statusChk: check('wisp_watches_status_chk', sql`${t.status} IN ('active','stopped')`),
}));

export type WispConcernRow = typeof wispConcerns.$inferSelect;
export type WispConcernRecipientRow = typeof wispConcernRecipients.$inferSelect;
export type WispWatchRow = typeof wispWatches.$inferSelect;
