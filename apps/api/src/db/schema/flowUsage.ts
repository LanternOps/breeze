import { pgTable, uuid, text, integer, timestamp, index, foreignKey } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations, partners } from './orgs';
import { flows } from './flows';

/**
 * Tool Catalog W05 (#5215 / #5220) — exact monthly flow run counters (plan Decision 15).
 * Migration: 2027-01-07-140000-flow-webhooks-tools-budgets.sql (CHECKs, the NULLS NOT DISTINCT
 * key, the owner guard, RLS and DEFERRABLE clauses live there).
 *
 * One row per (flow owner, flow, UTC month `YYYY-MM`) plus one owner-total row per (owner,
 * month) with `flow_id` NULL. The owner is the FLOW's owner: an org flow ⇒ (partner, org); a
 * partner-wide flow ⇒ (partner, NULL). `flow_usage_counters_key_uq` — UNIQUE NULLS NOT DISTINCT
 * (partner_id, org_id, flow_id, period_key) — is the ON CONFLICT target for both row kinds
 * (declared in SQL only; drizzle cannot express NULLS NOT DISTINCT).
 *
 * Tenancy: the connection_health_incidents shape (partner_id NOT NULL, org_id nullable,
 * conditional FOR ALL policy). Charged only by `chargeFlowRun` inside the run's system
 * transaction. Export policy: every column included.
 */
export const flowUsageCounters = pgTable(
  'flow_usage_counters',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    partnerId: uuid('partner_id').notNull().references(() => partners.id, { onDelete: 'cascade' }),
    /** Composite FK (org_id, partner_id) → organizations(id, partner_id); DEFERRABLE in SQL. */
    orgId: uuid('org_id'),
    flowId: uuid('flow_id').references(() => flows.id, { onDelete: 'cascade' }),
    periodKey: text('period_key').notNull(),
    runs: integer('runs').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    orgPartnerFk: foreignKey({
      columns: [table.orgId, table.partnerId],
      foreignColumns: [organizations.id, organizations.partnerId],
      name: 'flow_usage_counters_org_partner_fk',
    }).onDelete('cascade'),
    orgIdx: index('flow_usage_counters_org_idx').on(table.orgId).where(sql`${table.orgId} IS NOT NULL`),
    flowIdx: index('flow_usage_counters_flow_idx').on(table.flowId).where(sql`${table.flowId} IS NOT NULL`),
    periodIdx: index('flow_usage_counters_period_idx').on(table.periodKey),
  }),
);

export type FlowUsageCounterRow = typeof flowUsageCounters.$inferSelect;
