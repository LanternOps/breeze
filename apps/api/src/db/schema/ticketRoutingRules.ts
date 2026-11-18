import { boolean, index, integer, pgTable, text, timestamp, unique, uuid, varchar } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations, partners } from './orgs';
import { users } from './users';
import { ticketPriorityEnum, ticketSourceEnum } from './portal';
import { ticketCategories } from './tickets';
import { ticketStatuses } from './ticketConfig';

/**
 * Ticket routing rules (#8883 W5, spec §5.1) —
 * 2027-01-04-120000-ticket-routing-rules.sql.
 *
 * Ownership follows "Partner-Wide First": org_id XOR partner_id
 * (`ticket_routing_rules_one_owner_chk`, in the migration). RLS: one dual-axis
 * FOR ALL policy plus two SELECT-only read branches (partner-wide by
 * breeze_current_partner_id(), org-member for org sessions).
 *
 * Conditions AND across columns and OR within a list; a NULL or empty column
 * means "any". Category / status references are ON DELETE RESTRICT; the
 * `ticket_routing_rules_ref_partner_guard_trg` constraint trigger keeps every
 * reference inside the rule's partner (Gate B4). "At least one action" is a
 * service validation (Gate B13), not a CHECK. Evaluation order is
 * (position, id): org rules first, then partner-wide rules (D7).
 *
 * No jsonb: every column is export-policy `included`.
 *
 * Note: tickets.routing_rule_id (portal.ts) declares its FK to this table in
 * SQL only — importing this module from portal.ts would close an import
 * cycle (portal -> here -> tickets/ticketConfig -> portal enums) that fails
 * at module load.
 */
export const ticketRoutingRules = pgTable(
  'ticket_routing_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }),
    partnerId: uuid('partner_id').references(() => partners.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 100 }).notNull(),
    enabled: boolean('enabled').notNull().default(true),
    position: integer('position').notNull().default(0),
    matchSources: ticketSourceEnum('match_sources').array(),
    matchPriorities: ticketPriorityEnum('match_priorities').array(),
    matchCategoryId: uuid('match_category_id').references(() => ticketCategories.id, { onDelete: 'restrict' }),
    matchSubjectKeywords: text('match_subject_keywords').array(),
    matchRequesterDomains: text('match_requester_domains').array(),
    setAssigneeUserId: uuid('set_assignee_user_id').references(() => users.id, { onDelete: 'set null' }),
    setPriority: ticketPriorityEnum('set_priority'),
    setCategoryId: uuid('set_category_id').references(() => ticketCategories.id, { onDelete: 'restrict' }),
    setStatusId: uuid('set_status_id').references(() => ticketStatuses.id, { onDelete: 'restrict' }),
    addTags: text('add_tags').array(),
    // Partner-wide rules only (ticket_routing_rules_org_scoped_chk): true =
    // applies to the orgs in ticket_routing_rule_org_links and nothing else.
    // Explicit so a cascaded link delete can never widen a rule (fail closed).
    orgScoped: boolean('org_scoped').notNull().default(false),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    orgPositionIdx: index('ticket_routing_rules_org_position_idx').on(table.orgId, table.position).where(sql`org_id IS NOT NULL`),
    partnerPositionIdx: index('ticket_routing_rules_partner_position_idx').on(table.partnerId, table.position).where(sql`org_id IS NULL`),
    setAssigneeIdx: index('ticket_routing_rules_set_assignee_idx').on(table.setAssigneeUserId).where(sql`set_assignee_user_id IS NOT NULL`),
    matchCategoryIdx: index('ticket_routing_rules_match_category_idx').on(table.matchCategoryId).where(sql`match_category_id IS NOT NULL`),
    setCategoryIdx: index('ticket_routing_rules_set_category_idx').on(table.setCategoryId).where(sql`set_category_id IS NOT NULL`),
    setStatusIdx: index('ticket_routing_rules_set_status_idx').on(table.setStatusId).where(sql`set_status_id IS NOT NULL`),
    createdByIdx: index('ticket_routing_rules_created_by_idx').on(table.createdByUserId).where(sql`created_by_user_id IS NOT NULL`),
  }),
);

/**
 * Org allowlist of an `org_scoped` partner-wide routing rule. This table's
 * own `org_id` is the ALLOWLISTED org, NOT the tenancy axis: RLS joins through
 * the parent rule (template ticket_form_org_links), plus a SELECT-only branch
 * that admits a caller's own org's link of a rule it can read.
 */
export const ticketRoutingRuleOrgLinks = pgTable(
  'ticket_routing_rule_org_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ruleId: uuid('rule_id').notNull().references(() => ticketRoutingRules.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    ruleOrgUq: unique('ticket_routing_rule_org_links_rule_org_uq').on(table.ruleId, table.orgId),
    ruleIdx: index('ticket_routing_rule_org_links_rule_id_idx').on(table.ruleId),
    orgIdx: index('ticket_routing_rule_org_links_org_id_idx').on(table.orgId),
  }),
);

export type TicketRoutingRuleRow = typeof ticketRoutingRules.$inferSelect;
export type TicketRoutingRuleOrgLinkRow = typeof ticketRoutingRuleOrgLinks.$inferSelect;
