import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { WispEntityKind } from '@breeze/shared';
import { organizations, partners } from './orgs';
import { users } from './users';
import { wispGrants } from './wisp';
import { wispThreads } from './wispThreads';

export type WispLinkSource = 'user_pin' | 'wisp_pin' | 'auto';

/**
 * Wisp W08 — soft links from a Wisp thread to Breeze objects (tickets,
 * devices, orgs, ...; migrations/2027-01-05-100500-wisp-thread-links.sql).
 *
 * Tenancy: partner-anchored / org-optional (the `connection_health_incidents`
 * and `wisp_concerns` shape): `partner_id NOT NULL`, `org_id NULL` = a
 * partner-level link (a `user`, an org-less `organization`, a partner-scoped
 * `run`/`task`). One FOR ALL policy — system, or
 * `breeze_has_org_access(org_id)` for org rows, or
 * `breeze_has_partner_access(partner_id)` for partner-level rows; an org token
 * never sees a partner-level link. Registered in DUAL_AXIS_TENANT_TABLES and
 * the three org registries (cascade, merge `repoint`, export).
 *
 * `entity_id` is a soft reference (no FK — ten target tables): a deleted
 * entity resolves to null on read and the row is pruned. `label` is a display
 * cache, never an authority; the org is re-read from the entity on every read.
 *
 * Constraints Drizzle cannot express live in the migration only:
 * DEFERRABLE INITIALLY IMMEDIATE on the org/user composite FKs, the
 * column-list `ON DELETE SET NULL (added_by_grant_id)`, and NULLS NOT DISTINCT
 * on the thread/entity unique index.
 */
export const wispThreadLinks = pgTable('wisp_thread_links', {
  id: uuid('id').primaryKey().defaultRandom(),
  threadId: uuid('thread_id').notNull(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id, { onDelete: 'cascade' }),
  /** null = a partner-level link (visible to partner-scoped sessions only). */
  orgId: uuid('org_id'),
  entityKind: text('entity_kind').$type<WispEntityKind>().notNull(),
  /** Soft reference — no FK. */
  entityId: uuid('entity_id').notNull(),
  /** Display cache (<= 200 chars), never an authority. */
  label: text('label').notNull(),
  /** FK (added_by_user_id, partner_id) -> users(id, partner_id) in SQL. */
  addedByUserId: uuid('added_by_user_id').notNull(),
  /** Set when `link_entity` added it; FK ... ON DELETE SET NULL (added_by_grant_id) in SQL. */
  addedByGrantId: uuid('added_by_grant_id'),
  source: text('source').$type<WispLinkSource>().notNull(),
  lastTouchedAt: timestamp('last_touched_at', { withTimezone: true }).notNull().defaultNow(),
  touchCount: integer('touch_count').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  threadFk: foreignKey({
    name: 'wisp_thread_links_thread_fk',
    columns: [t.threadId, t.partnerId],
    foreignColumns: [wispThreads.id, wispThreads.partnerId],
  }).onDelete('cascade'),
  orgFk: foreignKey({
    name: 'wisp_thread_links_org_partner_fk',
    columns: [t.orgId, t.partnerId],
    foreignColumns: [organizations.id, organizations.partnerId],
  }).onDelete('cascade'),
  addedByUserFk: foreignKey({
    name: 'wisp_thread_links_added_by_user_fk',
    columns: [t.addedByUserId, t.partnerId],
    foreignColumns: [users.id, users.partnerId],
  }).onDelete('cascade'),
  addedByGrantFk: foreignKey({
    name: 'wisp_thread_links_added_by_grant_fk',
    columns: [t.addedByGrantId, t.partnerId],
    foreignColumns: [wispGrants.id, wispGrants.partnerId],
  }),
  // NULLS NOT DISTINCT in SQL.
  threadEntityUq: uniqueIndex('wisp_thread_links_thread_entity_uq').on(t.threadId, t.entityKind, t.entityId),
  threadTouchedIdx: index('wisp_thread_links_thread_touched_idx').on(t.threadId, t.lastTouchedAt.desc()),
  threadCreatedIdx: index('wisp_thread_links_thread_created_idx').on(t.threadId, t.createdAt.desc()),
  orgIdx: index('wisp_thread_links_org_idx').on(t.orgId).where(sql`org_id IS NOT NULL`),
  entityIdx: index('wisp_thread_links_entity_idx').on(t.entityKind, t.entityId),
  partnerIdx: index('wisp_thread_links_partner_idx').on(t.partnerId),
  addedByUserIdx: index('wisp_thread_links_added_by_user_idx').on(t.addedByUserId),
  addedByGrantIdx: index('wisp_thread_links_added_by_grant_idx')
    .on(t.addedByGrantId)
    .where(sql`added_by_grant_id IS NOT NULL`),
  entityKindChk: check('wisp_thread_links_entity_kind_chk', sql`${t.entityKind} IN ('ticket','quote','invoice','contract','device','organization','site','alert','run','task','user')`),
  sourceChk: check('wisp_thread_links_source_chk', sql`${t.source} IN ('user_pin','wisp_pin','auto')`),
  labelLenChk: check('wisp_thread_links_label_len_chk', sql`char_length(${t.label}) <= 200`),
}));

export type WispThreadLinkRow = typeof wispThreadLinks.$inferSelect;
