import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  char,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { organizations } from './orgs';
import { users } from './users';
import { devices } from './devices';
import { aiAgents, aiAgentRuns } from './aiAgents';
import { actionIntents } from './actionIntents';

// AI Operator thin-slice task model (#5205 W03, sub-issue #5208).
// Migration: apps/api/migrations/2026-10-14-100000-ai-operator-thin-slice.sql —
// read its header for the full rationale; this file mirrors it, it does not
// re-argue it.
//
// Tenancy Shape 1 throughout: direct, NOT NULL, immutable `org_id`, with
// ENABLE + FORCE RLS and `breeze_has_org_access(org_id)` policies declared in
// the creating migration. Auto-discovered by rls-coverage.integration.test.ts —
// nothing here belongs in any RLS allowlist.
//
// IMPORT DIRECTION IS LOAD-BEARING. This module imports `aiAgents`,
// `aiAgentRuns`, `actionIntents` and `devices`; those modules deliberately do
// NOT import this one. The reverse links (`action_intents.task_id`,
// `ai_agent_runs.task_id`) are therefore declared as plain columns here-adjacent
// in their own files with their composite FKs SQL-only, exactly as
// `reports.sourceAiAgentScheduleId` already is — a real Drizzle FK in both
// directions would be a module cycle. Postgres has the constraints either way;
// only Drizzle's view of them is one-directional.
//
// Every state/phase/outcome column is `text` + CHECK, never a pgEnum: under
// forced RLS enum equality is not leakproof and cannot become an index
// condition (spec §11.1).

export const AI_OPERATOR_TASK_STATES = [
  'queued',
  'running',
  'waiting',
  'paused',
  'stopping',
  'completed',
  'partial',
  'handed_off',
  'cancelled',
  'failed',
  'expired',
] as const;
export type AiOperatorTaskState = (typeof AI_OPERATOR_TASK_STATES)[number];

/**
 * States from which the org-merge fence and the device-move detach hook stop a
 * task: work that has not reached a terminal record yet. Kept here, next to the
 * state list itself, so a new live state cannot be added without the fence
 * seeing it.
 */
export const AI_OPERATOR_TASK_LIVE_STATES = [
  'queued',
  'running',
  'waiting',
  'paused',
] as const satisfies readonly AiOperatorTaskState[];

export const AI_OPERATOR_TASK_PHASES = ['investigate', 'plan', 'execute', 'verify', 'document'] as const;
export type AiOperatorTaskPhase = (typeof AI_OPERATOR_TASK_PHASES)[number];

export const AI_OPERATOR_WAIT_REASONS = [
  'approval',
  'information',
  'execution',
  'device',
  'maintenance_window',
  'verification_window',
] as const;
export type AiOperatorWaitReason = (typeof AI_OPERATOR_WAIT_REASONS)[number];

export const AI_OPERATOR_TASK_OUTCOMES = [
  'verified_resolved',
  'investigation_complete',
  'report_delivered',
  'no_action_needed',
  'trial_complete',
  'unresolved',
  'unknown_effect',
] as const;
export type AiOperatorTaskOutcome = (typeof AI_OPERATOR_TASK_OUTCOMES)[number];

export const AI_OPERATOR_TARGET_DETACH_REASONS = [
  'device_moved',
  'device_deleted',
  'org_merged',
  'scope_invalidated',
] as const;
export type AiOperatorTargetDetachReason = (typeof AI_OPERATOR_TARGET_DETACH_REASONS)[number];

export const AI_OPERATOR_EXECUTION_REF_KINDS = [
  'device_command',
  'script_execution',
  'patch_job_target',
  'playbook_execution',
  'ticket_comment',
  'report_delivery',
] as const;
export type AiOperatorExecutionRefKind = (typeof AI_OPERATOR_EXECUTION_REF_KINDS)[number];

export const AI_OPERATOR_OUTBOX_SOURCE_KINDS = [
  'run',
  'intent',
  'execution',
  'verification',
  'user_answer',
  'target',
  'cancellation',
] as const;
export type AiOperatorOutboxSourceKind = (typeof AI_OPERATOR_OUTBOX_SOURCE_KINDS)[number];

export const aiOperatorTasks = pgTable(
  'ai_operator_tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => organizations.id),

    // PLAIN FK, deliberately not composite: org merge repoints every loser-org
    // `ai_agents` row to the survivor while task `org_id` is immutable, so a
    // composite `(agent_id, org_id)` FK would make the merge impossible.
    // Same-org is checked in application code at admission (spec §11.3).
    agentId: uuid('agent_id').notNull().references(() => aiAgents.id, { onDelete: 'restrict' }),
    // Frozen at admission so a repointed, renamed or re-kinded agent cannot
    // rewrite what the task's evidence says it was run by.
    agentKind: text('agent_kind').notNull(),
    agentName: text('agent_name').notNull(),

    workflowKey: text('workflow_key').notNull(),
    workflowVersion: integer('workflow_version').notNull().default(1),
    // 'trial' is reserved for P3-4; the thin slice admits 'live' only.
    mode: text('mode').$type<'live' | 'trial'>().notNull().default('live'),

    originKind: text('origin_kind')
      .$type<'manual' | 'alert' | 'ticket' | 'schedule' | 'anomaly' | 'sweep' | 'chat'>()
      .notNull(),
    requesterUserId: uuid('requester_user_id').references(() => users.id, { onDelete: 'set null' }),

    // Bounded exportable text. Spec §11: every jsonb column is `excludedOpen`
    // in the export policy without exception, so anything a customer must be
    // able to export lives in a bounded `text` column, never only inside
    // `checkpoint`.
    objective: text('objective').notNull(),

    // Single inline target for the thin slice (P3-2 introduces
    // `ai_operator_task_targets`). ON DELETE SET NULL and NO composite FK:
    // task history stays in its source org with the pointer released and the
    // frozen label kept. Device MOVE detaches via routes/devices/moveOrg.ts;
    // device DELETE detaches via services/deviceDeletion.ts. The table is in
    // DEVICE_DETACH_DEVICE_ID_TABLES and in neither device delete-cascade nor
    // org-denormalized list.
    deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'set null' }),
    targetLabel: text('target_label'),
    targetDetachedAt: timestamp('target_detached_at', { withTimezone: true }),
    targetDetachedReason: text('target_detached_reason').$type<AiOperatorTargetDetachReason>(),

    state: text('state').$type<AiOperatorTaskState>().notNull().default('queued'),
    phase: text('phase').$type<AiOperatorTaskPhase>(),
    waitReason: text('wait_reason').$type<AiOperatorWaitReason>(),
    waitDependencyKind: text('wait_dependency_kind')
      .$type<'intent' | 'operation' | 'run' | 'device_command' | 'user_answer' | 'verification'>(),
    waitDependencyId: uuid('wait_dependency_id'),

    // Three separate clocks that must never be conflated (spec §6.2):
    // `revision` is the approved-plan revision, `leaseEpoch` the scheduler
    // fencing token, `attemptOrdinal` the reasoning attempt.
    revision: integer('revision').notNull().default(1),
    leaseEpoch: bigint('lease_epoch', { mode: 'number' }).notNull().default(0),
    leaseOwner: text('lease_owner'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    attemptOrdinal: integer('attempt_ordinal').notNull().default(0),

    currentStepKey: text('current_step_key'),
    checkpoint: jsonb('checkpoint').$type<Record<string, unknown>>().notNull().default({}),

    deadlineAt: timestamp('deadline_at', { withTimezone: true }),
    nextWakeAt: timestamp('next_wake_at', { withTimezone: true }),

    outcome: text('outcome').$type<AiOperatorTaskOutcome>(),
    outcomeDetail: text('outcome_detail'),
    handoffSummary: text('handoff_summary'),

    accountingRootTaskId: uuid('accounting_root_task_id'),
    successorOfTaskId: uuid('successor_of_task_id'),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    // Declares the tuple every task-qualified child FK references. `id` is
    // already PK, so this adds no new tenancy invariant on its own — same role
    // as ai_agent_runs_id_org_uq / action_intents_id_org_uq.
    idOrgUq: uniqueIndex('ai_operator_tasks_id_org_uq').on(table.id, table.orgId),

    // Self-lineage. The migration restricts SET NULL to the referencing column
    // (PG15+) so `org_id` survives; Drizzle cannot model the column list, same
    // caveat as action_intents.scopeTicketId's composite FK.
    rootOrgFk: foreignKey({
      columns: [table.accountingRootTaskId, table.orgId],
      foreignColumns: [table.id, table.orgId],
      name: 'ai_operator_tasks_root_org_fk',
    }).onDelete('set null'),
    successorOrgFk: foreignKey({
      columns: [table.successorOfTaskId, table.orgId],
      foreignColumns: [table.id, table.orgId],
      name: 'ai_operator_tasks_successor_org_fk',
    }).onDelete('set null'),

    // Spec §11.1. Predicate literals are spelled out rather than interpolated:
    // a bound parameter is invisible to the planner's predicate proof.
    wakeIdx: index('ai_operator_tasks_wake_idx')
      .on(table.nextWakeAt)
      .where(sql`state = 'waiting'`),
    orgStateUpdatedIdx: index('ai_operator_tasks_org_state_updated_idx')
      .on(table.orgId, table.state, table.updatedAt.desc()),
    orgRootIdx: index('ai_operator_tasks_org_root_idx').on(table.orgId, table.accountingRootTaskId),
    leaseIdx: index('ai_operator_tasks_lease_idx')
      .on(table.leaseExpiresAt)
      .where(sql`state IN ('running', 'stopping')`),
    deviceIdx: index('ai_operator_tasks_device_idx')
      .on(table.deviceId)
      .where(sql`device_id IS NOT NULL`),
  }),
);

export const aiOperatorOperations = pgTable(
  'ai_operator_operations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => organizations.id),
    taskId: uuid('task_id').notNull(),
    taskStepKey: text('task_step_key').notNull(),
    operationKey: text('operation_key').notNull(),
    attemptOrdinal: integer('attempt_ordinal').notNull().default(0),

    intentId: uuid('intent_id'),
    originatingRunId: uuid('originating_run_id'),

    argumentDigest: char('argument_digest', { length: 64 }).notNull(),

    // Typed reference with NO hard FK (spec §11.3): the referenced row may be
    // erased first, and `device_commands` has no RLS at all — every read goes
    // through an authorized adapter route, never a direct select.
    executionRefKind: text('execution_ref_kind').$type<AiOperatorExecutionRefKind>(),
    executionRefId: uuid('execution_ref_id'),

    dispatchState: text('dispatch_state')
      .$type<'reserved' | 'dispatched' | 'dispatch_failed' | 'abandoned'>()
      .notNull()
      .default('reserved'),
    // 'unknown' is a first-class result, not an error: between the tool's 30 s
    // wait and the device command's 5-minute reap the effect may still land
    // (spec §6.5, "three clocks").
    resultState: text('result_state')
      .$type<'pending' | 'succeeded' | 'failed' | 'unknown' | 'superseded'>()
      .notNull()
      .default('pending'),
    result: jsonb('result').$type<Record<string, unknown>>().notNull().default({}),

    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
    resultAt: timestamp('result_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    // THE sequential-replay guard (baseline C7/H2). Permanent, NO status
    // predicate: `action_intents_org_idem_uniq` covers live statuses only, and
    // a `completed` intent frees its key while the device may still be
    // executing. Do not add a status predicate here.
    orgTaskOpUq: uniqueIndex('ai_operator_operations_org_task_op_uq')
      .on(table.orgId, table.taskId, table.operationKey),

    taskOrgFk: foreignKey({
      columns: [table.taskId, table.orgId],
      foreignColumns: [aiOperatorTasks.id, aiOperatorTasks.orgId],
      name: 'ai_operator_operations_task_org_fk',
    }).onDelete('cascade'),
    // Both parents sort BEFORE ai_operator_operations in
    // CORE_ORG_CASCADE_DELETE_ORDER, so a RESTRICT here would abort org
    // erasure. SET NULL (restricted to the referencing column by the
    // migration) keeps `org_id` intact.
    intentOrgFk: foreignKey({
      columns: [table.intentId, table.orgId],
      foreignColumns: [actionIntents.id, actionIntents.orgId],
      name: 'ai_operator_operations_intent_org_fk',
    }).onDelete('set null'),
    runOrgFk: foreignKey({
      columns: [table.originatingRunId, table.orgId],
      foreignColumns: [aiAgentRuns.id, aiAgentRuns.orgId],
      name: 'ai_operator_operations_run_org_fk',
    }).onDelete('set null'),

    orgTaskResultIdx: index('ai_operator_operations_org_task_result_idx')
      .on(table.orgId, table.taskId, table.resultState),
    intentIdx: index('ai_operator_operations_intent_idx')
      .on(table.intentId)
      .where(sql`intent_id IS NOT NULL`),
    execRefIdx: index('ai_operator_operations_exec_ref_idx')
      .on(table.executionRefKind, table.executionRefId),
  }),
);

// DELIBERATELY RLS-SCOPED. `intent_outbox` is INTENTIONAL_UNSCOPED because the
// agent WS path drains it; the task coordinator runs under tenant context, so
// this outbox is org-scoped and MUST NEVER be added to that allowlist
// (baseline C20). It also carries `org_id`, so unlike `intent_outbox` (whose
// ON DELETE CASCADE to action_intents covers erasure) it IS registered in
// CORE_ORG_CASCADE_DELETE_ORDER.
export const aiOperatorTaskOutbox = pgTable(
  'ai_operator_task_outbox',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    orgId: uuid('org_id').notNull().references(() => organizations.id),
    taskId: uuid('task_id').notNull(),
    sourceKind: text('source_kind').$type<AiOperatorOutboxSourceKind>().notNull(),
    // A typed reference, never an embedded payload (spec §6.3). `text` rather
    // than `uuid` because not every source id is a uuid.
    sourceId: text('source_id').notNull(),
    transitionSeq: bigint('transition_seq', { mode: 'number' }).notNull(),
    dueAt: timestamp('due_at', { withTimezone: true }).defaultNow().notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    // Wake dedupe identity (spec §6.3): duplicate delivery converges here.
    identityUq: uniqueIndex('ai_operator_task_outbox_identity_uq')
      .on(table.orgId, table.taskId, table.sourceKind, table.sourceId, table.transitionSeq),
    taskOrgFk: foreignKey({
      columns: [table.taskId, table.orgId],
      foreignColumns: [aiOperatorTasks.id, aiOperatorTasks.orgId],
      name: 'ai_operator_task_outbox_task_org_fk',
    }).onDelete('cascade'),
    // Publisher poll. Precedent: intent_outbox_unpublished_idx.
    unpublishedIdx: index('ai_operator_task_outbox_unpublished_idx')
      .on(table.dueAt, table.id)
      .where(sql`published_at IS NULL`),
  }),
);

export type AiOperatorTaskRow = typeof aiOperatorTasks.$inferSelect;
export type AiOperatorOperationRow = typeof aiOperatorOperations.$inferSelect;
export type AiOperatorTaskOutboxRow = typeof aiOperatorTaskOutbox.$inferSelect;
