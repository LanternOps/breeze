import {
  pgTable,
  uuid,
  text,
  integer,
  smallint,
  bigint,
  boolean,
  jsonb,
  timestamp,
  index,
  unique,
  uniqueIndex,
  foreignKey,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type {
  FlowRunErrorCode,
  FlowRunStatus,
  FlowRunStepStatus,
  FlowStepErrorCode,
  FlowToolSource,
  FlowTriggeredVia,
  FlowTriggerKind,
} from '@breeze/shared';
import { organizations, partners } from './orgs';
import { users } from './users';
import { aiSessions } from './ai';
import { flows } from './flows';

/**
 * Tool Catalog W04 (#5215 / #5219) — flow publications, runs and the step ledger.
 * Spec: docs/superpowers/specs/ai-mcp/2026-09-07-tool-catalog-and-flows-design.md §6.4 / §6.5.
 * Migration: 2027-01-06-130000-flow-runs.sql. The CHECKs, triggers, RLS and
 * the DEFERRABLE clauses live there (house convention: drizzle-orm's
 * foreignKey() has no deferrable option, and these declarations are
 * documentary — `db:check-drift` replays the SQL, not this file).
 *
 * Tenancy (Open Decision 1):
 *   - flow_versions follows flows: org_id XOR partner_id
 *     (`flow_versions_one_owner_chk`), owner copied from the flow and kept
 *     equal by the deferred constraint trigger `flow_versions_owner_guard_trg`.
 *   - flow_runs / flow_run_steps are shape 1: org_id NOT NULL, no partner axis.
 *     A run always executes in exactly one org.
 *
 * Text + CHECK columns are typed with the shared unions; the CHECK value lists
 * are pinned to the shared arrays by flowRuns.checkPins.test.ts.
 */

/** Pre-approval rule-4 binding stored on a publication (Decision 3). Shape owned by Task A6. */
export type FlowPublicationPreApproval = Record<string, unknown>;
/** Enable-time per-step pin (where drift is measured). Shape owned by Task A6. */
export type FlowPublicationStepPin = Record<string, unknown>;

/**
 * One immutable publication per enable (Decision 2). `flows.enabled_publication_seq`
 * names the live one (no FK back, so the pair is not circular).
 *
 * Immutable except the owner columns (org merge repoints a moved org flow's
 * publications) and the delegator's SET NULL tombstone —
 * `flow_versions_immutable_trg`.
 *
 * CHECKs (SQL): flow_versions_one_owner_chk, flow_versions_effective_tier_chk
 * (1..3), flow_versions_publication_seq_chk (>= 1), flow_versions_jsonb_shape_chk
 * (definition object; step_pins, pre_approvals arrays).
 * Export policy: definition / step_pins / pre_approvals excludedOpen (jsonb).
 */
export const flowVersions = pgTable(
  'flow_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    flowId: uuid('flow_id')
      .notNull()
      .references(() => flows.id, { onDelete: 'cascade' }),
    // DEFERRABLE INITIALLY IMMEDIATE in SQL.
    orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }),
    partnerId: uuid('partner_id').references(() => partners.id, { onDelete: 'cascade' }),
    publicationSeq: integer('publication_seq').notNull(),
    /** The draft revision snapshotted; recorded, not the publication's identity. */
    definitionVersion: integer('definition_version').notNull(),
    definition: jsonb('definition').$type<Record<string, unknown>>().notNull(),
    effectiveTier: smallint('effective_tier').$type<1 | 2 | 3>().notNull(),
    stepPins: jsonb('step_pins').$type<FlowPublicationStepPin[]>().notNull(),
    preApprovals: jsonb('pre_approvals').$type<FlowPublicationPreApproval[]>().notNull().default([]),
    /** The delegator (Decision 7). */
    enabledByUserId: uuid('enabled_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    flowSeqUq: unique('flow_versions_flow_seq_uq').on(table.flowId, table.publicationSeq),
    /** Composite-FK target for flow_runs (flow_version_id, flow_id). */
    idFlowUq: unique('flow_versions_id_flow_uq').on(table.id, table.flowId),
    orgIdIdx: index('flow_versions_org_id_idx')
      .on(table.orgId)
      .where(sql`${table.orgId} IS NOT NULL`),
    partnerWideIdx: index('flow_versions_partner_wide_idx')
      .on(table.partnerId)
      .where(sql`${table.orgId} IS NULL`),
  }),
);

/**
 * A run (Decision 1: one org, always). Immutable identity/provenance and a
 * final terminal status — `flow_runs_immutable_trg` (the ai_agent_runs
 * precedent): org_id, flow_id, flow_version_id, definition_version,
 * trigger_kind, triggered_via, dedupe_key, pre_approvals_honored,
 * chain_depth, caused_by_run_id, created_at never change; triggered_by_user_id
 * may only tombstone to NULL.
 *
 * CHECKs (SQL): flow_runs_status_chk, flow_runs_trigger_kind_chk (+ webhook,
 * tool for W05), flow_runs_triggered_via_chk, flow_runs_via_matches_kind_chk,
 * flow_runs_pre_approvals_chk (Decision 4), flow_runs_error_code_chk,
 * flow_runs_lease_pair_chk, flow_runs_chain_chk (0..3, cause required when
 * > 0), flow_runs_finished_chk, flow_runs_awaiting_chk, flow_runs_waiting_chk,
 * flow_runs_pruned_chk, flow_runs_error_len_chk (<= 2000).
 *
 * `flow_runs_dedupe_uq` is a real UNIQUE constraint without a status predicate
 * (Decision 9) so `ON CONFLICT ON CONSTRAINT flow_runs_dedupe_uq` can target it.
 * Export policy: trigger_payload / inputs excludedOpen; lease_token excludedSensitive.
 */
export const flowRuns = pgTable(
  'flow_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // DEFERRABLE INITIALLY IMMEDIATE in SQL.
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    flowId: uuid('flow_id')
      .notNull()
      .references(() => flows.id, { onDelete: 'cascade' }),
    /** Composite FK (flow_version_id, flow_id) → flow_versions(id, flow_id) below. */
    flowVersionId: uuid('flow_version_id').notNull(),
    definitionVersion: integer('definition_version').notNull(),
    /** W04 writes FlowTriggerKind only; the CHECK also admits 'webhook' | 'tool' (W05). */
    triggerKind: text('trigger_kind').$type<FlowTriggerKind>().notNull(),
    triggeredVia: text('triggered_via').$type<FlowTriggeredVia>().notNull(),
    /** Nullable only for retention pruning; the service always writes an object. */
    triggerPayload: jsonb('trigger_payload').$type<Record<string, unknown> | null>(),
    inputs: jsonb('inputs').$type<Record<string, unknown> | null>(),
    status: text('status').$type<FlowRunStatus>().notNull().default('queued'),
    preApprovalsHonored: boolean('pre_approvals_honored').notNull(),
    currentStepId: text('current_step_id'),
    currentItemIndex: integer('current_item_index'),
    resumeSeq: integer('resume_seq').notNull().default(0),
    /** Durable slice lease (Decision 15); paired with leaseExpiresAt. */
    leaseToken: uuid('lease_token'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    wakeAt: timestamp('wake_at', { withTimezone: true }),
    dedupeKey: text('dedupe_key').notNull(),
    chainDepth: smallint('chain_depth').notNull().default(0),
    /** Plain uuid, no FK: the causing run may sit in another org's ledger after a merge. */
    causedByRunId: uuid('caused_by_run_id'),
    triggeredByUserId: uuid('triggered_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    aiSessionId: uuid('ai_session_id').references(() => aiSessions.id, { onDelete: 'set null' }),
    activeMs: bigint('active_ms', { mode: 'number' }).notNull().default(0),
    lastHeartbeatAt: timestamp('last_heartbeat_at', { withTimezone: true }),
    cancelRequestedAt: timestamp('cancel_requested_at', { withTimezone: true }),
    bodiesPrunedAt: timestamp('bodies_pruned_at', { withTimezone: true }),
    errorCode: text('error_code').$type<FlowRunErrorCode>(),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    /** Composite-FK target for flow_run_steps and action_intents. */
    idOrgUq: unique('flow_runs_id_org_uq').on(table.id, table.orgId),
    dedupeUq: unique('flow_runs_dedupe_uq').on(table.flowId, table.orgId, table.dedupeKey),
    flowVersionFk: foreignKey({
      columns: [table.flowVersionId, table.flowId],
      foreignColumns: [flowVersions.id, flowVersions.flowId],
      name: 'flow_runs_flow_version_fk',
    }).onDelete('cascade'),
    flowCreatedIdx: index('flow_runs_flow_created_idx').on(table.flowId, table.createdAt.desc()),
    orgCreatedIdx: index('flow_runs_org_created_idx').on(table.orgId, table.createdAt.desc()),
    flowVersionIdx: index('flow_runs_flow_version_idx').on(table.flowVersionId),
    activeIdx: index('flow_runs_active_idx')
      .on(table.status, table.updatedAt)
      .where(sql`${table.status} IN ('queued', 'running', 'waiting', 'awaiting_approval')`),
    retentionIdx: index('flow_runs_retention_idx')
      .on(table.finishedAt)
      .where(sql`${table.bodiesPrunedAt} IS NULL AND ${table.finishedAt} IS NOT NULL`),
  }),
);

/**
 * The step ledger. `flow_run_steps_attempt_uq` — a unique INDEX on
 * (run_id, step_id, COALESCE(item_index, -1), attempt) — is the idempotency
 * key of an attempt (`flow_run_steps_item_index_chk` keeps item_index >= 0 so
 * the -1 sentinel never collides).
 *
 * `actionIntentId` has no FK: `action_intents.requesting_flow_run_id` is the
 * FK'd edge, and a back-FK would make the cascade graph cyclic.
 *
 * CHECKs (SQL): flow_run_steps_status_chk, flow_run_steps_tool_source_chk,
 * flow_run_steps_tier_chk (1..3), flow_run_steps_approval_mode_chk,
 * flow_run_steps_error_code_chk, flow_run_steps_intent_pair_chk
 * (intent ⇔ actionIntentId), flow_run_steps_awaiting_chk,
 * flow_run_steps_approval_tier_chk (approval only on tier 3),
 * flow_run_steps_approver_chk, flow_run_steps_finished_chk,
 * flow_run_steps_error_len_chk, flow_run_steps_item_index_chk,
 * flow_run_steps_attempt_chk.
 * Export policy: rendered_input / output excludedOpen.
 */
export const flowRunSteps = pgTable(
  'flow_run_steps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Composite FK (run_id, org_id) → flow_runs(id, org_id) below; DEFERRABLE in SQL. */
    runId: uuid('run_id').notNull(),
    // DEFERRABLE INITIALLY IMMEDIATE in SQL.
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    stepId: text('step_id').notNull(),
    itemIndex: integer('item_index'),
    attempt: smallint('attempt').notNull().default(1),
    tool: text('tool').notNull(),
    toolSource: text('tool_source').$type<FlowToolSource>().notNull(),
    tier: smallint('tier').$type<1 | 2 | 3>().notNull(),
    status: text('status').$type<FlowRunStepStatus>().notNull(),
    approvalMode: text('approval_mode').$type<'none' | 'intent' | 'pre_approved'>().notNull().default('none'),
    /** Null after retention pruning. */
    renderedInput: jsonb('rendered_input').$type<unknown>(),
    output: jsonb('output').$type<unknown>(),
    outputTruncated: boolean('output_truncated').notNull().default(false),
    errorCode: text('error_code').$type<FlowStepErrorCode>(),
    error: text('error'),
    actionIntentId: uuid('action_intent_id'),
    approvedByUserId: uuid('approved_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    durationMs: integer('duration_ms'),
  },
  (table) => ({
    runFk: foreignKey({
      columns: [table.runId, table.orgId],
      foreignColumns: [flowRuns.id, flowRuns.orgId],
      name: 'flow_run_steps_run_fk',
    }).onDelete('cascade'),
    attemptUq: uniqueIndex('flow_run_steps_attempt_uq').on(
      table.runId,
      table.stepId,
      sql`COALESCE(${table.itemIndex}, -1)`,
      table.attempt,
    ),
    runStartedIdx: index('flow_run_steps_run_started_idx').on(table.runId, table.startedAt),
  }),
);

export type FlowVersionRow = typeof flowVersions.$inferSelect;
export type NewFlowVersionRow = typeof flowVersions.$inferInsert;
export type FlowRunRow = typeof flowRuns.$inferSelect;
export type NewFlowRunRow = typeof flowRuns.$inferInsert;
export type FlowRunStepRow = typeof flowRunSteps.$inferSelect;
export type NewFlowRunStepRow = typeof flowRunSteps.$inferInsert;
