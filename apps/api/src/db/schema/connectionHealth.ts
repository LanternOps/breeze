import { index, integer, pgTable, smallint, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { partners } from './orgs';
import { users } from './users';

// Connection health incidents (spec 2026-10-15 §2.1). Tenancy shape 4
// (dual-axis): partner_id is always set; org_id is NULL only for a
// partner-owned connection. Written only by the reconciler in system scope.
//
// Composite FK (org_id, partner_id) → organizations(id, partner_id) is
// ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE and lives in the migration
// only: drizzle's foreignKey() builder has no deferrable option. The CHECK
// constraints (severity, resolution, pending_notice, href shape, lengths)
// are also migration-only.
export const connectionHealthIncidents = pgTable('connection_health_incidents', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id'),
  ownerUserId: uuid('owner_user_id').references(() => users.id, { onDelete: 'set null' }),
  sourceKind: text('source_kind').notNull(),
  sourceId: text('source_id').notNull(),
  condition: text('condition').notNull(),
  severity: text('severity').notNull(),
  detail: text('detail'),
  displayName: text('display_name').notNull(),
  fixHref: text('fix_href').notNull(),
  ownerFixHref: text('owner_fix_href'),
  viewPermission: text('view_permission').notNull(),
  repairPermission: text('repair_permission').notNull(),
  firstFailedAt: timestamp('first_failed_at', { withTimezone: true }).notNull(),
  openedAt: timestamp('opened_at', { withTimezone: true }),
  lastObservedAt: timestamp('last_observed_at', { withTimezone: true }).notNull(),
  healthyStreak: smallint('healthy_streak').notNull().default(0),
  flapCount: integer('flap_count').notNull().default(0),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  resolution: text('resolution'),
  pendingNotice: text('pending_notice'),
  notifiedUserIds: uuid('notified_user_ids').array().notNull().default(sql`'{}'::uuid[]`),
  /** W5 event outbox: what event consumers were last told ('opened' | 'resolved'), NULL = never. */
  eventState: text('event_state'),
}, (t) => ({
  openUniq: uniqueIndex('connection_health_incidents_open_uniq')
    .on(t.sourceKind, t.sourceId)
    .where(sql`${t.resolvedAt} IS NULL`),
  partnerOpenIdx: index('connection_health_incidents_partner_open_idx')
    .on(t.partnerId)
    .where(sql`${t.resolvedAt} IS NULL`),
  kindResolvedIdx: index('connection_health_incidents_kind_resolved_idx')
    .on(t.sourceKind, t.resolvedAt)
    .where(sql`${t.resolvedAt} IS NOT NULL`),
  pendingNoticeIdx: index('connection_health_incidents_pending_notice_idx')
    .on(t.id)
    .where(sql`${t.pendingNotice} IS NOT NULL`),
  orgIdx: index('connection_health_incidents_org_idx')
    .on(t.orgId)
    .where(sql`${t.orgId} IS NOT NULL`),
  eventDueIdx: index('connection_health_incidents_event_due_idx')
    .on(t.id)
    .where(sql`${t.orgId} IS NOT NULL AND ${t.openedAt} IS NOT NULL AND ((${t.resolvedAt} IS NULL AND ${t.eventState} IS DISTINCT FROM 'opened') OR (${t.resolvedAt} IS NOT NULL AND ${t.eventState} = 'opened'))`),
}));
