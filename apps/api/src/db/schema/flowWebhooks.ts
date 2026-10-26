import { pgTable, uuid, text, integer, timestamp, index, uniqueIndex, foreignKey } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { FlowWebhookAuthMode, FlowWebhookDeliveryStatus } from '@breeze/shared';
import { organizations, partners } from './orgs';
import { flows } from './flows';
import { flowRuns } from './flowRuns';

/**
 * Tool Catalog W05 (#5215 / #5220) — the authenticated webhook delivery log (plan Decision 2).
 * Migration: 2027-01-06-160000-flow-webhooks-tools-budgets.sql. CHECKs, triggers, RLS and
 * the DEFERRABLE clauses live there (drizzle-orm's foreignKey() has no deferrable option;
 * `db:check-drift` replays the SQL, not this file).
 *
 * Tenancy: the connection_health_incidents shape — partner_id always set, org_id NULL for an
 * org_unresolved delivery of a partner-wide flow; composite (org_id, partner_id) →
 * organizations(id, partner_id); one conditional FOR ALL policy (org rows by org access,
 * partner-level rows by partner access). `flow_webhook_deliveries_owner_guard_trg` (BEFORE
 * INSERT) keeps the owner equal to the flow's owner.
 *
 * One row per AUTHENTICATED delivery — never a body (only `body_sha256` and `body_bytes`).
 * Replay protection: partial unique keys over accepted rows, `(flow_id, signature_digest)`
 * and `(flow_id, delivery_id)`. Immutable except `attempts`, `last_attempt_at` and
 * `refusal_code` (`flow_webhook_deliveries_immutable_trg`); a refused delivery accepted later
 * is a new row.
 *
 * CHECKs (SQL): _status_chk, _auth_mode_chk, _signature_chk (hmac ⇔ digest), _accepted_run_chk
 * (accepted ⇔ run, accepted ⇒ org), _unresolved_chk, _delivery_id_chk, _digest_chk (hex sha256),
 * _lengths_chk. Export policy: signature_digest reviewedIncluded, the rest included.
 */
export const flowWebhookDeliveries = pgTable(
  'flow_webhook_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    partnerId: uuid('partner_id').notNull().references(() => partners.id, { onDelete: 'cascade' }),
    /** Composite FK (org_id, partner_id) → organizations(id, partner_id); DEFERRABLE in SQL. */
    orgId: uuid('org_id'),
    flowId: uuid('flow_id').notNull().references(() => flows.id, { onDelete: 'cascade' }),
    receivedAt: timestamp('received_at', { withTimezone: true }).defaultNow().notNull(),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }).defaultNow().notNull(),
    attempts: integer('attempts').notNull().default(1),
    authMode: text('auth_mode').$type<FlowWebhookAuthMode>().notNull(),
    deliveryId: text('delivery_id'),
    /** sha256 hex of the verified signature header; hmac mode only. */
    signatureDigest: text('signature_digest'),
    bodySha256: text('body_sha256').notNull(),
    bodyBytes: integer('body_bytes').notNull(),
    status: text('status').$type<FlowWebhookDeliveryStatus>().notNull(),
    refusalCode: text('refusal_code'),
    resolverValue: text('resolver_value'),
    /** Composite FK (run_id, org_id) → flow_runs(id, org_id); DEFERRABLE in SQL. */
    runId: uuid('run_id'),
  },
  (table) => ({
    orgPartnerFk: foreignKey({
      columns: [table.orgId, table.partnerId],
      foreignColumns: [organizations.id, organizations.partnerId],
      name: 'flow_webhook_deliveries_org_partner_fk',
    }).onDelete('cascade'),
    runFk: foreignKey({
      columns: [table.runId, table.orgId],
      foreignColumns: [flowRuns.id, flowRuns.orgId],
      name: 'flow_webhook_deliveries_run_fk',
    }).onDelete('cascade'),
    sigUq: uniqueIndex('flow_webhook_deliveries_sig_uq')
      .on(table.flowId, table.signatureDigest)
      .where(sql`${table.status} = 'accepted'`),
    deliveryUq: uniqueIndex('flow_webhook_deliveries_delivery_uq')
      .on(table.flowId, table.deliveryId)
      .where(sql`${table.status} = 'accepted' AND ${table.deliveryId} IS NOT NULL`),
    flowReceivedIdx: index('flow_webhook_deliveries_flow_received_idx').on(table.flowId, table.receivedAt.desc()),
    orgIdx: index('flow_webhook_deliveries_org_idx').on(table.orgId).where(sql`${table.orgId} IS NOT NULL`),
    partnerIdx: index('flow_webhook_deliveries_partner_idx').on(table.partnerId),
    runIdx: index('flow_webhook_deliveries_run_idx').on(table.runId).where(sql`${table.runId} IS NOT NULL`),
    retentionIdx: index('flow_webhook_deliveries_retention_idx')
      .on(table.lastAttemptAt)
      .where(sql`${table.status} <> 'accepted'`),
  }),
);

export type FlowWebhookDeliveryRow = typeof flowWebhookDeliveries.$inferSelect;
export type NewFlowWebhookDeliveryRow = typeof flowWebhookDeliveries.$inferInsert;
