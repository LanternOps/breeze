import { sql } from 'drizzle-orm';
import { check, foreignKey, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { WispCheckInContext, WispCheckInStatus } from '@breeze/shared';
import { organizations, partners } from './orgs';
import { users } from './users';
import { wispGrants } from './wisp';
import { wispThreads } from './wispThreads';

/**
 * Wisp check-in timers W01 (#10992, feature #10991) — a follow-up Wisp
 * scheduled on its own thread (migrations/2027-01-20-130000-wisp-check-ins.sql).
 * A delayed `check-in` job on wisp-wake fires it; the grantor's next turn in
 * the thread gets the instruction prepended and the row becomes `consumed`.
 * Lifecycle: scheduled → fired → consumed; scheduled | fired → cancelled.
 *
 * Tenancy: partner-anchored / org-optional (the `wisp_thread_posts` shape):
 * `partner_id NOT NULL`, `org_id NULL` = a check-in on a partner-level thread.
 * One FOR ALL policy — system, or `breeze_has_org_access(org_id)` for org rows,
 * or `breeze_has_partner_access(partner_id)` for partner-level rows; an org
 * token never sees a partner-level row. Registered in DUAL_AXIS_TENANT_TABLES
 * and the three org registries (cascade, merge `repoint`, export).
 *
 * `id` has no default: the service generates it so `job_id`
 * (`wisp-check-in-<id>`) goes in the same insert. The due window is bounded
 * against the row's own `created_at`, not `now()`.
 *
 * Constraints Drizzle cannot express live in the migration only:
 * DEFERRABLE INITIALLY IMMEDIATE on the org composite FK.
 */
export const wispCheckIns = pgTable('wisp_check_ins', {
  id: uuid('id').primaryKey(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id, { onDelete: 'cascade' }),
  /** null = a check-in on a partner-level thread (partner-scoped sessions only). */
  orgId: uuid('org_id'),
  grantId: uuid('grant_id').notNull(),
  threadId: uuid('thread_id').notNull(),
  /** The session that scheduled it; provenance only, no FK. */
  sessionId: uuid('session_id'),
  /** Who is notified when it fires (the grantor). */
  userId: uuid('user_id').notNull(),
  dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
  /** What Wisp should do when it fires (1–1000 chars); written by the model. */
  instruction: text('instruction').notNull(),
  context: jsonb('context').$type<WispCheckInContext>(),
  status: text('status').$type<WispCheckInStatus>().notNull().default('scheduled'),
  firedAt: timestamp('fired_at', { withTimezone: true }),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  /** BullMQ job id on wisp-wake (`wisp-check-in-<id>`). */
  jobId: text('job_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  threadFk: foreignKey({
    name: 'wisp_check_ins_thread_fk',
    columns: [t.threadId, t.partnerId],
    foreignColumns: [wispThreads.id, wispThreads.partnerId],
  }).onDelete('cascade'),
  grantFk: foreignKey({
    name: 'wisp_check_ins_grant_fk',
    columns: [t.grantId, t.partnerId],
    foreignColumns: [wispGrants.id, wispGrants.partnerId],
  }).onDelete('cascade'),
  userFk: foreignKey({
    name: 'wisp_check_ins_user_fk',
    columns: [t.userId, t.partnerId],
    foreignColumns: [users.id, users.partnerId],
  }).onDelete('cascade'),
  orgFk: foreignKey({
    name: 'wisp_check_ins_org_partner_fk',
    columns: [t.orgId, t.partnerId],
    foreignColumns: [organizations.id, organizations.partnerId],
  }).onDelete('cascade'),
  threadStatusIdx: index('wisp_check_ins_thread_status_idx').on(t.threadId, t.status),
  scheduledDueIdx: index('wisp_check_ins_scheduled_due_idx').on(t.dueAt).where(sql`status = 'scheduled'`),
  grantStatusIdx: index('wisp_check_ins_grant_status_idx').on(t.grantId, t.status),
  partnerIdx: index('wisp_check_ins_partner_idx').on(t.partnerId),
  userIdx: index('wisp_check_ins_user_idx').on(t.userId),
  orgIdx: index('wisp_check_ins_org_idx').on(t.orgId).where(sql`org_id IS NOT NULL`),
  statusChk: check('wisp_check_ins_status_chk', sql`${t.status} IN ('scheduled','fired','consumed','cancelled')`),
  instructionLenChk: check('wisp_check_ins_instruction_len_chk', sql`char_length(${t.instruction}) BETWEEN 1 AND 1000`),
  dueWindowChk: check(
    'wisp_check_ins_due_window_chk',
    sql`${t.dueAt} >= ${t.createdAt} + interval '1 minute' AND ${t.dueAt} <= ${t.createdAt} + interval '7 days'`,
  ),
  statusShapeChk: check(
    'wisp_check_ins_status_shape_chk',
    sql`(${t.status} <> 'fired' OR ${t.firedAt} IS NOT NULL) AND (${t.status} <> 'consumed' OR (${t.firedAt} IS NOT NULL AND ${t.consumedAt} IS NOT NULL)) AND (${t.status} <> 'cancelled' OR ${t.cancelledAt} IS NOT NULL)`,
  ),
}));

export type WispCheckInRow = typeof wispCheckIns.$inferSelect;
