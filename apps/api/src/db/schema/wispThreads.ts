import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { aiSessions } from './ai';
import { aiRunArtifacts } from './aiWorkspace';
import { organizations, partners } from './orgs';
import { users } from './users';
import { wispGrants } from './wisp';

/**
 * Wisp W04 — the durable conversation thread (Wisp design §6;
 * migrations/2027-01-04-110200-wisp-threads.sql).
 *
 * Tenancy:
 *  - `wisp_threads` and `wisp_thread_sessions` are shape 3 (partner-axis,
 *    `breeze_has_partner_access(partner_id)`). `wisp_thread_sessions.org_id`
 *    is the attached session's org, NOT the tenancy axis; it is registered in
 *    the org cascade / merge / export registries.
 *  - `wisp_thread_attachments` is shape 1 (`breeze_has_org_access(org_id)`)
 *    with `partner_id` denormalised for the thread FK.
 *
 * Every constraint Drizzle cannot express — DEFERRABLE INITIALLY IMMEDIATE on
 * the org-bound composite FKs, and the column-list
 * `ON DELETE SET NULL (focus_org_id)` on `wisp_threads_focus_org_fk` — lives
 * in the migration only. The FKs are declared here (without those modifiers)
 * so FK readers over the Drizzle schema see the edges.
 */

export const wispThreads = pgTable('wisp_threads', {
  id: uuid('id').primaryKey().defaultRandom(),
  grantId: uuid('grant_id').notNull(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id, { onDelete: 'cascade' }),
  summary: text('summary').notNull().default(''),
  summaryUpdatedAt: timestamp('summary_updated_at', { withTimezone: true }),
  // Typed reference, no FK: a closed session may be erased before its thread.
  lastSessionId: uuid('last_session_id'),
  // w00 A24: the customer this thread is "working on"; NULL = unfocused.
  // FK (focus_org_id, partner_id) -> organizations(id, partner_id) is
  // ON DELETE SET NULL (focus_org_id) DEFERRABLE INITIALLY IMMEDIATE in SQL.
  focusOrgId: uuid('focus_org_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  grantUq: unique('wisp_threads_grant_uq').on(t.grantId),
  idPartnerUq: unique('wisp_threads_id_partner_uq').on(t.id, t.partnerId),
  grantFk: foreignKey({
    name: 'wisp_threads_grant_fk',
    columns: [t.grantId, t.partnerId],
    foreignColumns: [wispGrants.id, wispGrants.partnerId],
  }).onDelete('cascade'),
  focusOrgFk: foreignKey({
    name: 'wisp_threads_focus_org_fk',
    columns: [t.focusOrgId, t.partnerId],
    foreignColumns: [organizations.id, organizations.partnerId],
  }),
  partnerIdx: index('wisp_threads_partner_idx').on(t.partnerId),
  focusOrgIdx: index('wisp_threads_focus_org_idx').on(t.focusOrgId).where(sql`${t.focusOrgId} IS NOT NULL`),
  summaryLenChk: check('wisp_threads_summary_len_chk', sql`char_length(${t.summary}) <= 4000`),
}));

export const wispThreadSessions = pgTable('wisp_thread_sessions', {
  threadId: uuid('thread_id').notNull(),
  sessionId: uuid('session_id').notNull(),
  partnerId: uuid('partner_id').notNull(),
  orgId: uuid('org_id').notNull(),
  attachedAt: timestamp('attached_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pk: primaryKey({ name: 'wisp_thread_sessions_pkey', columns: [t.threadId, t.sessionId] }),
  sessionUq: unique('wisp_thread_sessions_session_uq').on(t.sessionId),
  threadFk: foreignKey({
    name: 'wisp_thread_sessions_thread_fk',
    columns: [t.threadId, t.partnerId],
    foreignColumns: [wispThreads.id, wispThreads.partnerId],
  }).onDelete('cascade'),
  sessionFk: foreignKey({
    name: 'wisp_thread_sessions_session_fk',
    columns: [t.sessionId, t.orgId],
    foreignColumns: [aiSessions.id, aiSessions.orgId],
  }).onDelete('cascade'),
  orgFk: foreignKey({
    name: 'wisp_thread_sessions_org_fk',
    columns: [t.orgId, t.partnerId],
    foreignColumns: [organizations.id, organizations.partnerId],
  }).onDelete('cascade'),
  orgIdx: index('wisp_thread_sessions_org_idx').on(t.orgId),
  partnerIdx: index('wisp_thread_sessions_partner_idx').on(t.partnerId),
  threadAttachedIdx: index('wisp_thread_sessions_thread_attached_idx').on(t.threadId, t.attachedAt.desc()),
}));

export const wispThreadAttachments = pgTable('wisp_thread_attachments', {
  id: uuid('id').primaryKey().defaultRandom(),
  threadId: uuid('thread_id').notNull(),
  partnerId: uuid('partner_id').notNull(),
  // The artifact's org (= the thread's focus org at upload time, or the grant org).
  orgId: uuid('org_id').notNull(),
  // The handle the model reads with read_artifact.
  artifactId: uuid('artifact_id').notNull(),
  addedByUserId: uuid('added_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  label: varchar('label', { length: 200 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  threadArtifactUq: unique('wisp_thread_attachments_thread_artifact_uq').on(t.threadId, t.artifactId),
  threadFk: foreignKey({
    name: 'wisp_thread_attachments_thread_fk',
    columns: [t.threadId, t.partnerId],
    foreignColumns: [wispThreads.id, wispThreads.partnerId],
  }).onDelete('cascade'),
  orgFk: foreignKey({
    name: 'wisp_thread_attachments_org_fk',
    columns: [t.orgId, t.partnerId],
    foreignColumns: [organizations.id, organizations.partnerId],
  }).onDelete('cascade'),
  artifactFk: foreignKey({
    name: 'wisp_thread_attachments_artifact_fk',
    columns: [t.artifactId, t.orgId],
    foreignColumns: [aiRunArtifacts.id, aiRunArtifacts.orgId],
  }).onDelete('cascade'),
  orgIdx: index('wisp_thread_attachments_org_idx').on(t.orgId),
  partnerIdx: index('wisp_thread_attachments_partner_idx').on(t.partnerId),
  threadCreatedIdx: index('wisp_thread_attachments_thread_created_idx').on(t.threadId, t.createdAt.desc()),
  artifactIdx: index('wisp_thread_attachments_artifact_idx').on(t.artifactId),
}));

export type WispThreadRow = typeof wispThreads.$inferSelect;
export type WispThreadSessionRow = typeof wispThreadSessions.$inferSelect;
export type WispThreadAttachmentRow = typeof wispThreadAttachments.$inferSelect;
