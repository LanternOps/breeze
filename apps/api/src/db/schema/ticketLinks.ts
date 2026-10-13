import { foreignKey, index, pgEnum, pgTable, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations } from './orgs';
import { tickets } from './portal';
import { users } from './users';

export const ticketLinkTypeEnum = pgEnum('ticket_link_type', ['caused_by', 'resolves', 'related', 'duplicate_of']);

/**
 * A typed link between two tickets of ONE organization (#7900, migration
 * 2026-12-26-190000). A row reads "source <link_type> target"; the inverse
 * label is derived at read time (`ticketLinkLabel` in @breeze/shared), so a
 * link is exactly one row. `related` is symmetric and stored canonically
 * (source < target, CHECK).
 *
 * Shape 1 on `org_id`. Both legs are composite (ticket_id, org_id) ->
 * tickets(id, org_id) FKs sharing this one org_id, so a cross-org link is
 * unrepresentable; both are DEFERRABLE INITIALLY IMMEDIATE. There is no
 * `ticket_id` column, so the org movers cannot re-stamp it with their
 * `WHERE ticket_id = …` loops: they DELETE every link touching the moved
 * ticket(s) instead (TICKET_ORG_MOVE_DELETE_TABLES in
 * services/ticketOrgMoveLockOrder.ts) and defer both FKs by name.
 */
export const ticketLinks = pgTable('ticket_links', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  sourceTicketId: uuid('source_ticket_id').notNull(),
  targetTicketId: uuid('target_ticket_id').notNull(),
  linkType: ticketLinkTypeEnum('link_type').notNull(),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  uniqueIndex('ticket_links_pair_type_uq').on(t.sourceTicketId, t.targetTicketId, t.linkType),
  uniqueIndex('ticket_links_one_canonical_uq').on(t.sourceTicketId).where(sql`link_type = 'duplicate_of'`),
  index('ticket_links_target_idx').on(t.targetTicketId),
  index('ticket_links_org_idx').on(t.orgId),
  foreignKey({
    columns: [t.sourceTicketId, t.orgId],
    foreignColumns: [tickets.id, tickets.orgId],
    name: 'ticket_links_source_org_fk',
  }).onDelete('cascade'),
  foreignKey({
    columns: [t.targetTicketId, t.orgId],
    foreignColumns: [tickets.id, tickets.orgId],
    name: 'ticket_links_target_org_fk',
  }).onDelete('cascade'),
]);
