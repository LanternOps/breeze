import { pgTable, uuid, text, integer, boolean, jsonb, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type {
  FlowConversionFidelity,
  FlowConversionFinding,
  FlowConversionState,
  OccurrenceClaimEngine,
  ShadowDivergenceKind,
} from '@breeze/shared';
import { organizations, partners } from './orgs';
import { users } from './users';
import { automations } from './automations';
import { flows } from './flows';

/**
 * Tool Catalog W06 (#5215 / #5221) — legacy automation ("Job") → flow conversion.
 * Migration: 2027-01-09-100000-flow-automation-conversions.sql. CHECKs, triggers, RLS and
 * the DEFERRABLE clauses live there (drizzle-orm's foreignKey() has no deferrable option;
 * `db:check-drift` replays the SQL, not this file).
 *
 * Tenancy: the `automations`/`flows` shape — org_id XOR partner_id, one dual-axis FOR ALL
 * policy plus the SELECT-only partner-wide branch. A constraint trigger (DEFERRABLE
 * INITIALLY IMMEDIATE, so it holds across an org merge) keeps each row's owner pair equal
 * to its automation's (and, for a conversion, its flow's).
 */

/**
 * One append-only conversion generation: `shadow → switched → reverted`. At most one live
 * (non-reverted) generation per automation; one generation per flow. CHECKs (SQL):
 * _one_owner_chk, _state_chk, _fidelity_chk, _fidelity_row_chk (never unconvertible),
 * _switch_chk (shadow ⇔ no switch_at/switched_at), _revert_chk (reverted ⇔ revert_at),
 * _counters_chk, _digests_chk, _json_chk. `flow_automation_conversions_immutable_trg` fixes
 * the identity, source and actor columns and admits only the two transitions.
 * Export policy: findings / source_snapshot / shadow_last_divergence excludedOpen; the
 * digests reviewedIncluded; the rest included.
 */
export const flowAutomationConversions = pgTable(
  'flow_automation_conversions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** DEFERRABLE INITIALLY IMMEDIATE in SQL. */
    orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }),
    partnerId: uuid('partner_id').references(() => partners.id, { onDelete: 'cascade' }),
    automationId: uuid('automation_id').notNull().references(() => automations.id, { onDelete: 'cascade' }),
    flowId: uuid('flow_id').notNull().references(() => flows.id, { onDelete: 'cascade' }),
    state: text('state').$type<FlowConversionState>().notNull().default('shadow'),
    fidelity: text('fidelity').$type<Exclude<FlowConversionFidelity, 'unconvertible'>>().notNull(),
    findings: jsonb('findings').$type<FlowConversionFinding[]>().notNull().default(sql`'[]'::jsonb`),
    sourceDigest: text('source_digest').notNull(),
    /** trigger (without the webhook secret), conditions, actions, on_failure, notification_targets. */
    sourceSnapshot: jsonb('source_snapshot').$type<Record<string, unknown>>().notNull(),
    documentDigest: text('document_digest').notNull(),
    shadowRuns: integer('shadow_runs').notNull().default(0),
    shadowDivergences: integer('shadow_divergences').notNull().default(0),
    shadowStartedAt: timestamp('shadow_started_at', { withTimezone: true }).defaultNow().notNull(),
    shadowLastAt: timestamp('shadow_last_at', { withTimezone: true }),
    shadowLastDivergence: jsonb('shadow_last_divergence').$type<{ kind: ShadowDivergenceKind; at: string; detail: string }>(),
    /** now() + SWITCH_LEAD_MS, written in the transaction that enables the flow. */
    switchAt: timestamp('switch_at', { withTimezone: true }),
    switchedAt: timestamp('switched_at', { withTimezone: true }),
    revertAt: timestamp('revert_at', { withTimezone: true }),
    convertedBy: uuid('converted_by').references(() => users.id, { onDelete: 'set null' }),
    switchedBy: uuid('switched_by').references(() => users.id, { onDelete: 'set null' }),
    revertedBy: uuid('reverted_by').references(() => users.id, { onDelete: 'set null' }),
    divergenceAcknowledged: boolean('divergence_acknowledged').notNull().default(false),
    scopeWideningAccepted: boolean('scope_widening_accepted').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    liveUq: uniqueIndex('flow_automation_conversions_live_uq')
      .on(table.automationId)
      .where(sql`${table.state} <> 'reverted'`),
    flowUq: uniqueIndex('flow_automation_conversions_flow_uq').on(table.flowId),
    automationCreatedIdx: index('flow_automation_conversions_automation_created_idx').on(table.automationId, table.createdAt),
    orgIdx: index('flow_automation_conversions_org_idx').on(table.orgId).where(sql`${table.orgId} IS NOT NULL`),
    partnerIdx: index('flow_automation_conversions_partner_idx').on(table.partnerId).where(sql`${table.orgId} IS NULL`),
  }),
);

/**
 * Who admitted each occurrence of an automation, across both engines and every
 * generation. Unique `(automation_id, occurrence_key)`; inserted in the same transaction as
 * the run admission. Append-only (`automation_occurrence_claims_append_only_trg`; breeze_app
 * holds only UPDATE (org_id), for the org-merge repoint). Export policy: occurrence_key
 * reviewedIncluded, the rest included.
 */
export const automationOccurrenceClaims = pgTable(
  'automation_occurrence_claims',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** DEFERRABLE INITIALLY IMMEDIATE in SQL. */
    orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }),
    partnerId: uuid('partner_id').references(() => partners.id, { onDelete: 'cascade' }),
    automationId: uuid('automation_id').notNull().references(() => automations.id, { onDelete: 'cascade' }),
    /** `occurrenceKey.*` (OCCURRENCE_KEY_RE, `automation_occurrence_claims_key_chk`). */
    occurrenceKey: text('occurrence_key').notNull(),
    engine: text('engine').$type<OccurrenceClaimEngine>().notNull(),
    /** Provenance only (plain uuid). */
    conversionId: uuid('conversion_id'),
    legacyRunId: uuid('legacy_run_id'),
    /** NULL for a partner-wide flow's parent schedule claim. */
    flowRunId: uuid('flow_run_id'),
    occurrenceAt: timestamp('occurrence_at', { withTimezone: true }),
    claimedAt: timestamp('claimed_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    occurrenceUq: uniqueIndex('automation_occurrence_claims_occurrence_uq').on(table.automationId, table.occurrenceKey),
    claimedIdx: index('automation_occurrence_claims_claimed_idx').on(table.claimedAt),
    orgIdx: index('automation_occurrence_claims_org_idx').on(table.orgId).where(sql`${table.orgId} IS NOT NULL`),
    partnerIdx: index('automation_occurrence_claims_partner_idx').on(table.partnerId).where(sql`${table.orgId} IS NULL`),
  }),
);

export type FlowAutomationConversionRow = typeof flowAutomationConversions.$inferSelect;
export type AutomationOccurrenceClaimRow = typeof automationOccurrenceClaims.$inferSelect;
