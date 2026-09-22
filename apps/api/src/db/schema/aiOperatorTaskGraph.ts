import { sql } from 'drizzle-orm';
import {
  bigint,
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
import { devices } from './devices';
import { tickets } from './portal';
import { contacts } from './contacts';
import { m365Connections } from './m365';
import { googleWorkspaceConnections } from './google';
import { aiOperatorTasks } from './aiOperatorTasks';

// AI Operator Recipe Library wave E2 — the task object graph.
// Migration: apps/api/migrations/2026-10-26-160000-ai-operator-task-graph.sql —
// read its header for the full rationale; this file mirrors it, it does not
// re-argue it.
//
// Split out of aiOperatorTasks.ts by LIFECYCLE, not by line count: that module
// owns the task and its two thin-slice siblings, this one owns everything
// hanging off a task. The import direction is one-way — this module imports
// `aiOperatorTasks`, and `aiOperatorTasks.ts` must NEVER import this one, for
// the same module-cycle reason its own header gives.
//
// Tenancy Shape 1 throughout: direct, NOT NULL, immutable `org_id`, ENABLE +
// FORCE RLS with `breeze_has_org_access(org_id)` policies declared in the
// creating migration. Auto-discovered by rls-coverage.integration.test.ts —
// nothing here belongs in any RLS allowlist.
//
// Every state/kind column is `text` + CHECK, never a pgEnum: under forced RLS
// enum equality is not leakproof and cannot become an index condition
// (Operator spec §11.1).

export const AI_OPERATOR_TARGET_KINDS = ['device', 'ticket', 'contact'] as const;
export type AiOperatorTargetKind = (typeof AI_OPERATOR_TARGET_KINDS)[number];

export const AI_OPERATOR_TARGET_STATES = [
  'pending', 'active', 'succeeded', 'failed', 'skipped', 'detached',
] as const;
export type AiOperatorTargetState = (typeof AI_OPERATOR_TARGET_STATES)[number];

export const AI_OPERATOR_STEP_KINDS = [
  'reason', 'effect', 'probe', 'wait', 'human_work', 'document',
] as const;
export type AiOperatorStepKind = (typeof AI_OPERATOR_STEP_KINDS)[number];

export const AI_OPERATOR_STEP_STATES = [
  'pending', 'running', 'waiting', 'succeeded', 'failed', 'skipped',
] as const;
export type AiOperatorStepState = (typeof AI_OPERATOR_STEP_STATES)[number];

export const AI_OPERATOR_ACCOUNT_PROVIDERS = ['m365', 'google'] as const;
export type AiOperatorAccountProvider = (typeof AI_OPERATOR_ACCOUNT_PROVIDERS)[number];

export const AI_OPERATOR_TASK_EVENT_TYPES = [
  'task_admitted', 'lease_claimed', 'step_opened', 'step_settled',
  'wait_entered', 'wait_resolved', 'target_attached', 'target_detached',
  'target_account_frozen', 'operation_reserved', 'operation_settled',
  'verification_recorded', 'plan_revision_bumped', 'task_settled',
] as const;
export type AiOperatorTaskEventType = (typeof AI_OPERATOR_TASK_EVENT_TYPES)[number];

export const AI_OPERATOR_EVENT_ACTOR_KINDS = [
  'coordinator', 'reconciler', 'user', 'agent', 'system',
] as const;
export type AiOperatorEventActorKind = (typeof AI_OPERATOR_EVENT_ACTOR_KINDS)[number];

export const aiOperatorTaskTargets = pgTable(
  'ai_operator_task_targets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => organizations.id),
    taskId: uuid('task_id').notNull(),

    targetKind: text('target_kind').$type<AiOperatorTargetKind>().notNull(),

    // THREE POINTERS, THREE FK SHAPES (migration header note A).
    // device/ticket are PLAIN FKs with no composite: Operator spec §11.3's
    // matrix says so, and a composite one would make the device-move trigger
    // and moveTicketOrg 23503 instead of leaving a stale pointer for the
    // detach statement to clear.
    deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'set null' }),
    ticketId: uuid('ticket_id').references(() => tickets.id, { onDelete: 'set null' }),
    // contact is COMPOSITE — declared in the table extras below. A contact
    // never moves between orgs, so the composite costs nothing and buys the
    // guarantee that matters most here: an offboarding task can never name a
    // person in another tenant.
    contactId: uuid('contact_id'),

    targetLabel: text('target_label').notNull(),
    targetOrdinal: integer('target_ordinal').notNull(),

    state: text('state').$type<AiOperatorTargetState>().notNull().default('pending'),

    detachedAt: timestamp('detached_at', { withTimezone: true }),
    // Reuses AI_OPERATOR_TARGET_DETACH_REASONS from ./aiOperatorTasks — the
    // same four values, deliberately NOT forked. Typed as a string here rather
    // than importing the type, to keep this module's import of
    // `aiOperatorTasks` to the table alone; enumParity.test.ts pins the CHECK.
    detachedReason: text('detached_reason'),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    // The tuple children reference: THREE columns, so a step or an account can
    // never name a target belonging to a different task of the same org
    // (Operator spec §11.3).
    idTaskOrgUq: uniqueIndex('ai_operator_task_targets_id_task_org_uq')
      .on(table.id, table.taskId, table.orgId),
    taskOrdinalUq: uniqueIndex('ai_operator_task_targets_task_ordinal_uq')
      .on(table.orgId, table.taskId, table.targetOrdinal),

    taskOrgFk: foreignKey({
      columns: [table.taskId, table.orgId],
      foreignColumns: [aiOperatorTasks.id, aiOperatorTasks.orgId],
      name: 'ai_operator_task_targets_task_org_fk',
    }).onDelete('cascade'),
    // The migration restricts SET NULL to the referencing column (PG15+) so
    // `org_id` survives; Drizzle cannot model the column list. A referential
    // SET NULL on ANY of the three pointers is stamped as a detach by the
    // BEFORE UPDATE trigger ai_operator_task_targets_stamp_detach (Drizzle
    // cannot model triggers either) — without it the null pointer would trip
    // ai_operator_task_targets_one_pointer_chk and abort the parent DELETE.
    contactOrgFk: foreignKey({
      columns: [table.contactId, table.orgId],
      foreignColumns: [contacts.id, contacts.orgId],
      name: 'ai_operator_task_targets_contact_org_fk',
    }).onDelete('set null'),

    deviceIdx: index('ai_operator_task_targets_device_idx')
      .on(table.deviceId).where(sql`device_id IS NOT NULL`),
    ticketIdx: index('ai_operator_task_targets_ticket_idx')
      .on(table.ticketId).where(sql`ticket_id IS NOT NULL`),
    contactIdx: index('ai_operator_task_targets_contact_idx')
      .on(table.contactId).where(sql`contact_id IS NOT NULL`),
  }),
);

export const aiOperatorTaskTargetAccounts = pgTable(
  'ai_operator_task_target_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => organizations.id),
    taskId: uuid('task_id').notNull(),
    targetId: uuid('target_id').notNull(),

    provider: text('provider').$type<AiOperatorAccountProvider>().notNull(),

    // Two nullable columns, not one polymorphic `connection_id`: the two
    // providers live in two tables, and a single column could reference
    // neither with a real FK.
    m365ConnectionId: uuid('m365_connection_id'),
    googleConnectionId: uuid('google_connection_id'),

    /** Immutable Entra object id / Google user id — NEVER the UPN. This is what
     *  every dispatch addresses, so a rename mid-task cannot retarget an
     *  effect (recipe spec §5.2, D2). */
    externalId: text('external_id').notNull(),
    /** UPN / primary email at admission. DISPLAY ONLY. */
    principalLabel: text('principal_label').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    taskProviderUq: uniqueIndex('ai_operator_task_target_accounts_task_provider_uq')
      .on(table.orgId, table.taskId, table.provider),
    targetIdx: index('ai_operator_task_target_accounts_target_idx')
      .on(table.orgId, table.targetId),

    // SAME-ORG *AND* SAME-TASK.
    targetFk: foreignKey({
      columns: [table.targetId, table.taskId, table.orgId],
      foreignColumns: [
        aiOperatorTaskTargets.id,
        aiOperatorTaskTargets.taskId,
        aiOperatorTaskTargets.orgId,
      ],
      name: 'ai_operator_task_target_accounts_target_fk',
    }).onDelete('cascade'),
    taskOrgFk: foreignKey({
      columns: [table.taskId, table.orgId],
      foreignColumns: [aiOperatorTasks.id, aiOperatorTasks.orgId],
      name: 'ai_operator_task_target_accounts_task_org_fk',
    }).onDelete('cascade'),
    m365ConnOrgFk: foreignKey({
      columns: [table.m365ConnectionId, table.orgId],
      foreignColumns: [m365Connections.id, m365Connections.orgId],
      name: 'ai_operator_task_target_accounts_m365_conn_org_fk',
    }).onDelete('set null'),
    googleConnOrgFk: foreignKey({
      columns: [table.googleConnectionId, table.orgId],
      foreignColumns: [googleWorkspaceConnections.id, googleWorkspaceConnections.orgId],
      name: 'ai_operator_task_target_accounts_google_conn_org_fk',
    }).onDelete('set null'),
  }),
);

export const aiOperatorTaskSteps = pgTable(
  'ai_operator_task_steps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => organizations.id),
    taskId: uuid('task_id').notNull(),

    stepKey: text('step_key').notNull(),
    stepKind: text('step_kind').$type<AiOperatorStepKind>().notNull(),

    targetId: uuid('target_id'),
    attemptOrdinal: integer('attempt_ordinal').notNull().default(0),
    state: text('state').$type<AiOperatorStepState>().notNull().default('pending'),
    planRevision: integer('plan_revision'),

    /** Bounded exportable text, never jsonb — Operator spec §11's export rule. */
    expectedCriterion: text('expected_criterion'),

    dependencyKind: text('dependency_kind')
      .$type<'intent' | 'operation' | 'run' | 'device_command' | 'user_answer' | 'verification'>(),
    dependencyId: uuid('dependency_id'),

    /** jsonb, therefore `excludedOpen` in the export policy WITHOUT exception. */
    checkpoint: jsonb('checkpoint').$type<Record<string, unknown>>().notNull().default({}),
    detail: text('detail'),

    startedAt: timestamp('started_at', { withTimezone: true }),
    settledAt: timestamp('settled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    // TWO partial uniques, not one five-column unique: a NULL target_id makes
    // a plain unique index enforce NOTHING for task-wide steps.
    identityUq: uniqueIndex('ai_operator_task_steps_identity_uq')
      .on(table.orgId, table.taskId, table.stepKey, table.targetId, table.attemptOrdinal)
      .where(sql`target_id IS NOT NULL`),
    identityNullTargetUq: uniqueIndex('ai_operator_task_steps_identity_null_target_uq')
      .on(table.orgId, table.taskId, table.stepKey, table.attemptOrdinal)
      .where(sql`target_id IS NULL`),
    taskStateIdx: index('ai_operator_task_steps_task_state_idx')
      .on(table.orgId, table.taskId, table.state),

    taskOrgFk: foreignKey({
      columns: [table.taskId, table.orgId],
      foreignColumns: [aiOperatorTasks.id, aiOperatorTasks.orgId],
      name: 'ai_operator_task_steps_task_org_fk',
    }).onDelete('cascade'),
    targetFk: foreignKey({
      columns: [table.targetId, table.taskId, table.orgId],
      foreignColumns: [
        aiOperatorTaskTargets.id,
        aiOperatorTaskTargets.taskId,
        aiOperatorTaskTargets.orgId,
      ],
      name: 'ai_operator_task_steps_target_fk',
    }).onDelete('set null'),
  }),
);

/**
 * APPEND-ONLY (migration header note C). `breeze_app` holds SELECT and INSERT
 * only; UPDATE and DELETE are revoked and a BEFORE trigger RAISEs 55000.
 * Registered in AUDIT_ADMIN_REQUIRED_TABLES (services/tenantCascade.ts) so org
 * erasure arms `breeze_audit_admin` for it.
 *
 * `actorUserId` and `targetId` carry NO Drizzle (or SQL) foreign key, and that
 * is not an omission: `ON DELETE SET NULL` performs an UPDATE, which the
 * immutability trigger rejects — deleting a user would abort with 55000 —
 * while RESTRICT would make a user undeletable. Typed references only.
 */
export const aiOperatorTaskEvents = pgTable(
  'ai_operator_task_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => organizations.id),
    taskId: uuid('task_id').notNull(),

    /** Allocated from `ai_operator_tasks.event_seq`. NOT the outbox's fixed
     *  terminal-status ordinal — see that column's COMMENT. */
    transitionSeq: bigint('transition_seq', { mode: 'number' }).notNull(),

    eventType: text('event_type').$type<AiOperatorTaskEventType>().notNull(),
    actorKind: text('actor_kind').$type<AiOperatorEventActorKind>().notNull(),
    actorUserId: uuid('actor_user_id'),

    stepKey: text('step_key'),
    targetId: uuid('target_id'),

    /** Bounded text. There is deliberately NO jsonb column on this table. */
    detail: text('detail'),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    taskSeqUq: uniqueIndex('ai_operator_task_events_task_seq_uq')
      .on(table.taskId, table.transitionSeq),
    orgTaskCreatedIdx: index('ai_operator_task_events_org_task_created_idx')
      .on(table.orgId, table.taskId, table.createdAt.desc()),
    taskOrgFk: foreignKey({
      columns: [table.taskId, table.orgId],
      foreignColumns: [aiOperatorTasks.id, aiOperatorTasks.orgId],
      name: 'ai_operator_task_events_task_org_fk',
    }).onDelete('cascade'),
  }),
);

export type AiOperatorTaskTargetRow = typeof aiOperatorTaskTargets.$inferSelect;
export type AiOperatorTaskTargetAccountRow = typeof aiOperatorTaskTargetAccounts.$inferSelect;
export type AiOperatorTaskStepRow = typeof aiOperatorTaskSteps.$inferSelect;
export type AiOperatorTaskEventRow = typeof aiOperatorTaskEvents.$inferSelect;
