import { sql } from 'drizzle-orm';
import { check, foreignKey, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { WispCheckInContext, WispCheckInFireReason, WispCheckInMode, WispCheckInStatus, WispCheckInTriggerKind } from '@breeze/shared';
import { organizations, partners } from './orgs';
import { users } from './users';
import { wispGrants } from './wisp';
import { wispThreads } from './wispThreads';

/**
 * Wisp check-in timers W01 (#10992, feature #10991) — a follow-up Wisp
 * scheduled on its own thread (migrations/2027-01-20-130000-wisp-check-ins.sql).
 * A delayed `check-in` job on wisp-wake fires it; the grantor's next turn in
 * the thread gets the instruction prepended and the row becomes `consumed`.
 * Lifecycle: scheduled → fired → consumed; scheduled | fired → cancelled; a
 * run row scheduled → running → consumed | fired (W07).
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
 * Event check-ins (W04 #11493, #10410;
 * migrations/2027-01-22-233100-wisp-check-ins-event-triggers.sql): a row with
 * `trigger_kind <> 'time'` waits for an event on `trigger_subject_id` (a
 * provenance pointer, no FK: a deleted subject is a fire-time condition), and
 * its `due_at` is the deadline. `fire_reason` records why it fired and is also
 * the fire claim (services/wisp/checkIns.ts fireCheckIn); `cancel_reason` why
 * Breeze cancelled it (null when Wisp or the user did).
 *
 * Run check-ins (W07 #11496, #10410;
 * migrations/2027-01-22-233600-wisp-check-ins-run-mode.sql): `mode = 'run'`
 * admits one assessment run when it fires (status `running`, `run_id` set)
 * and posts the run's result when it settles. `grant_revision_id` is the
 * revision it was scheduled under; a run row whose grant has moved on to
 * another revision runs nothing (services/wisp/checkInRuns.ts).
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
  /** `time`, or the event it waits for (WISP_CHECK_IN_TRIGGER_KINDS). */
  triggerKind: text('trigger_kind').$type<WispCheckInTriggerKind>().notNull().default('time'),
  /** The device / script execution / device command / agent run the event is about; null for `time`. */
  triggerSubjectId: uuid('trigger_subject_id'),
  /** Why it fired (due / event / deadline); written first, as the fire claim. */
  fireReason: text('fire_reason').$type<WispCheckInFireReason>(),
  /** Why Breeze cancelled it (≤ 200 chars); null when Wisp or the user cancelled it. */
  cancelReason: text('cancel_reason'),
  /** `notify` or `run` (WISP_CHECK_IN_MODES). */
  mode: text('mode').$type<WispCheckInMode>().notNull().default('notify'),
  /** The assessment run a `run` check-in admitted; a provenance pointer, no FK. */
  runId: uuid('run_id'),
  /** The grant revision current at scheduling; required for `run`. */
  grantRevisionId: uuid('grant_revision_id'),
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
  triggerIdx: index('wisp_check_ins_trigger_idx')
    .on(t.triggerKind, t.triggerSubjectId)
    .where(sql`status = 'scheduled' AND trigger_kind <> 'time'`),
  runIdx: index('wisp_check_ins_run_idx').on(t.runId).where(sql`run_id IS NOT NULL`),
  statusChk: check('wisp_check_ins_status_chk', sql`${t.status} IN ('scheduled','running','fired','consumed','cancelled')`),
  modeChk: check('wisp_check_ins_mode_chk', sql`${t.mode} IN ('notify','run')`),
  runOrgChk: check(
    'wisp_check_ins_run_org_chk',
    sql`${t.mode} = 'notify' OR (${t.orgId} IS NOT NULL AND ${t.grantRevisionId} IS NOT NULL)`,
  ),
  runIdModeChk: check('wisp_check_ins_run_id_mode_chk', sql`${t.runId} IS NULL OR ${t.mode} = 'run'`),
  instructionLenChk: check('wisp_check_ins_instruction_len_chk', sql`char_length(${t.instruction}) BETWEEN 1 AND 1000`),
  dueWindowChk: check(
    'wisp_check_ins_due_window_chk',
    sql`${t.dueAt} >= ${t.createdAt} + interval '1 minute' AND ${t.dueAt} <= ${t.createdAt} + interval '7 days'`,
  ),
  triggerKindChk: check(
    'wisp_check_ins_trigger_kind_chk',
    sql`${t.triggerKind} IN ('time','device_online','script_finished','command_finished','run_settled')`,
  ),
  triggerShapeChk: check('wisp_check_ins_trigger_shape_chk', sql`(${t.triggerKind} = 'time') = (${t.triggerSubjectId} IS NULL)`),
  fireReasonChk: check('wisp_check_ins_fire_reason_chk', sql`${t.fireReason} IS NULL OR ${t.fireReason} IN ('due','event','deadline')`),
  cancelReasonLenChk: check('wisp_check_ins_cancel_reason_len_chk', sql`${t.cancelReason} IS NULL OR char_length(${t.cancelReason}) <= 200`),
  statusShapeChk: check(
    'wisp_check_ins_status_shape_chk',
    sql`(${t.status} <> 'fired' OR ${t.firedAt} IS NOT NULL) AND (${t.status} <> 'consumed' OR (${t.firedAt} IS NOT NULL AND ${t.consumedAt} IS NOT NULL)) AND (${t.status} <> 'cancelled' OR ${t.cancelledAt} IS NOT NULL) AND (${t.status} <> 'running' OR ${t.runId} IS NOT NULL)`,
  ),
}));

export type WispCheckInRow = typeof wispCheckIns.$inferSelect;
