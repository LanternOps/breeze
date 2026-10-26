import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import type { BriefSection, WispTimelinePostKind } from '@breeze/shared';
import { userNotifications } from './notifications';
import { organizations, partners } from './orgs';
import { wispGrants } from './wisp';
import { wispConcerns } from './wispConcerns';
import { wispThreads } from './wispThreads';

/** WISP_TIMELINE_POST_KINDS (@breeze/shared); the CHECK below lists the same kinds. */
export type WispThreadPostKind = WispTimelinePostKind;

/**
 * Wisp companion W02a (#10212) — proactive Wisp output (morning brief, concern
 * nudges, digest) kept on the thread as durable posts
 * (migrations/2027-01-06-140000-wisp-thread-posts.sql). Written by
 * `notifyUser` whatever the recipient's channels; read by the thread timeline.
 *
 * Tenancy: partner-anchored / org-optional (the `wisp_thread_links` shape):
 * `partner_id NOT NULL`, `org_id NULL` = a partner-level post (brief, digest,
 * an org-less concern). One FOR ALL policy — system, or
 * `breeze_has_org_access(org_id)` for org rows, or
 * `breeze_has_partner_access(partner_id)` for partner-level rows; an org token
 * never sees a partner-level post. Registered in DUAL_AXIS_TENANT_TABLES and
 * the three org registries (cascade, merge `repoint`, export).
 *
 * Constraints Drizzle cannot express live in the migration only:
 * DEFERRABLE INITIALLY IMMEDIATE on the org composite FK.
 */
export const wispThreadPosts = pgTable('wisp_thread_posts', {
  id: uuid('id').primaryKey().defaultRandom(),
  threadId: uuid('thread_id').notNull(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id, { onDelete: 'cascade' }),
  grantId: uuid('grant_id').notNull(),
  /** null = a partner-level post (visible to partner-scoped sessions only). */
  orgId: uuid('org_id'),
  kind: text('kind').$type<WispThreadPostKind>().notNull(),
  title: varchar('title', { length: 255 }).notNull(),
  body: text('body'),
  /** Relative same-origin path (CHECK in SQL, as user_notifications.link). */
  link: varchar('link', { length: 500 }),
  /** Brief sections; null for nudges and digests. */
  sections: jsonb('sections').$type<BriefSection[]>(),
  concernId: uuid('concern_id').references(() => wispConcerns.id, { onDelete: 'set null' }),
  /** The in-app notification written in the same call, when there was one. */
  notificationId: uuid('notification_id').references(() => userNotifications.id, { onDelete: 'set null' }),
  /** The notification's dedupe key; unique per thread. */
  dedupeKey: text('dedupe_key').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  threadFk: foreignKey({
    name: 'wisp_thread_posts_thread_fk',
    columns: [t.threadId, t.partnerId],
    foreignColumns: [wispThreads.id, wispThreads.partnerId],
  }).onDelete('cascade'),
  grantFk: foreignKey({
    name: 'wisp_thread_posts_grant_fk',
    columns: [t.grantId, t.partnerId],
    foreignColumns: [wispGrants.id, wispGrants.partnerId],
  }).onDelete('cascade'),
  orgFk: foreignKey({
    name: 'wisp_thread_posts_org_partner_fk',
    columns: [t.orgId, t.partnerId],
    foreignColumns: [organizations.id, organizations.partnerId],
  }).onDelete('cascade'),
  threadDedupeUq: uniqueIndex('wisp_thread_posts_thread_dedupe_uq').on(t.threadId, t.dedupeKey),
  threadCreatedIdx: index('wisp_thread_posts_thread_created_idx').on(t.threadId, t.createdAt.desc(), t.id.desc()),
  partnerIdx: index('wisp_thread_posts_partner_idx').on(t.partnerId),
  grantIdx: index('wisp_thread_posts_grant_idx').on(t.grantId),
  orgIdx: index('wisp_thread_posts_org_idx').on(t.orgId).where(sql`org_id IS NOT NULL`),
  concernIdx: index('wisp_thread_posts_concern_idx').on(t.concernId).where(sql`concern_id IS NOT NULL`),
  notificationIdx: index('wisp_thread_posts_notification_idx').on(t.notificationId).where(sql`notification_id IS NOT NULL`),
  kindChk: check('wisp_thread_posts_kind_chk', sql`${t.kind} IN ('brief','nudge','digest')`),
}));

export type WispThreadPostRow = typeof wispThreadPosts.$inferSelect;
