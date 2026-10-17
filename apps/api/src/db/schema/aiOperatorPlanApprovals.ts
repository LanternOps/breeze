/**
 * Plan approval (Operator Recipe Library spec §5.4, §6.4), wave E4 (#6169).
 *
 * Mirrors migrations/2026-12-23-190000-ai-operator-plan-approvals.sql. These
 * are plan CONTENT tables: the decision itself is the single `operator_plan`
 * action intent on the ordinary approval_requests flow, never a row here.
 *
 * Every value list is `text` + CHECK, never pgEnum, and the three copies —
 * CHECK, the arrays below, @breeze/shared — are pinned together by
 * `services/aiOperator/enumParity.test.ts`.
 */
import {
  char, foreignKey, index, integer, pgTable, smallint, text, timestamp, uniqueIndex, uuid,
} from 'drizzle-orm/pg-core';
import { organizations } from './orgs';
import { users } from './users';
import { actionIntents } from './actionIntents';
import { aiOperatorTasks } from './aiOperatorTasks';

export const AI_OPERATOR_PLAN_APPROVAL_STATES = [
  'pending', 'approved', 'rejected', 'expired', 'superseded',
] as const;
export type AiOperatorPlanApprovalState = (typeof AI_OPERATOR_PLAN_APPROVAL_STATES)[number];

export const AI_OPERATOR_EFFECT_IDEMPOTENCY_CLASSES = [
  'idempotent', 'idempotent_by_probe', 'non_idempotent',
] as const;
export type AiOperatorEffectIdempotencyClass =
  (typeof AI_OPERATOR_EFFECT_IDEMPOTENCY_CLASSES)[number];

export const AI_OPERATOR_EFFECT_PROVIDERS = ['breeze', 'm365', 'google'] as const;
export type AiOperatorEffectProvider = (typeof AI_OPERATOR_EFFECT_PROVIDERS)[number];

export const aiOperatorPlanApprovals = pgTable(
  'ai_operator_plan_approvals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => organizations.id),
    taskId: uuid('task_id').notNull(),
    /** The effect step that owns this plan; part of every child's operation key. */
    stepKey: text('step_key').notNull(),
    planRevision: integer('plan_revision').notNull(),
    effectSetDigest: char('effect_set_digest', { length: 64 }).notNull(),
    effectCount: integer('effect_count').notNull(),
    /** NULL only while `pending` and not yet linked (see the migration, D). */
    intentId: uuid('intent_id'),
    state: text('state').$type<AiOperatorPlanApprovalState>().notNull().default('pending'),
    approvedByUserId: uuid('approved_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    approvedAssuranceLevel: smallint('approved_assurance_level'),
    supersededByRevision: integer('superseded_by_revision'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    taskRevisionUq: uniqueIndex('ai_operator_plan_approvals_task_revision_uq')
      .on(table.orgId, table.taskId, table.planRevision),
    idTaskOrgUq: uniqueIndex('ai_operator_plan_approvals_id_task_org_uq')
      .on(table.id, table.taskId, table.orgId),
    intentUq: uniqueIndex('ai_operator_plan_approvals_intent_uq').on(table.orgId, table.intentId),
    taskStateIdx: index('ai_operator_plan_approvals_task_state_idx')
      .on(table.orgId, table.taskId, table.state),
    taskOrgFk: foreignKey({
      columns: [table.taskId, table.orgId],
      foreignColumns: [aiOperatorTasks.id, aiOperatorTasks.orgId],
      name: 'ai_operator_plan_approvals_task_org_fk',
    }).onDelete('cascade'),
    intentOrgFk: foreignKey({
      columns: [table.intentId, table.orgId],
      foreignColumns: [actionIntents.id, actionIntents.orgId],
      name: 'ai_operator_plan_approvals_intent_org_fk',
    }).onDelete('restrict'),
  }),
);

export const aiOperatorPlanApprovalEffects = pgTable(
  'ai_operator_plan_approval_effects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => organizations.id),
    approvalId: uuid('approval_id').notNull(),
    taskId: uuid('task_id').notNull(),
    planRevision: integer('plan_revision').notNull(),
    ordinal: integer('ordinal').notNull(),
    toolName: text('tool_name').notNull(),
    provider: text('provider').$type<AiOperatorEffectProvider>().notNull(),
    /** `ai_operator_task_targets.id`. Typed reference, NO hard FK. */
    targetId: uuid('target_id'),
    accountExternalId: text('account_external_id'),
    argumentDigest: char('argument_digest', { length: 64 }).notNull(),
    targetLabel: text('target_label').notNull(),
    principalLabel: text('principal_label'),
    rendering: text('rendering').notNull(),
    idempotencyClass: text('idempotency_class').$type<AiOperatorEffectIdempotencyClass>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    membershipUq: uniqueIndex('ai_operator_plan_approval_effects_membership_uq')
      .on(table.orgId, table.taskId, table.planRevision, table.ordinal),
    approvalIdx: index('ai_operator_plan_approval_effects_approval_idx')
      .on(table.approvalId, table.ordinal),
    approvalTaskOrgFk: foreignKey({
      columns: [table.approvalId, table.taskId, table.orgId],
      foreignColumns: [
        aiOperatorPlanApprovals.id, aiOperatorPlanApprovals.taskId, aiOperatorPlanApprovals.orgId,
      ],
      name: 'ai_operator_plan_approval_effects_approval_task_org_fk',
    }).onDelete('cascade'),
  }),
);

export type AiOperatorPlanApprovalRow = typeof aiOperatorPlanApprovals.$inferSelect;
export type AiOperatorPlanApprovalEffectRow = typeof aiOperatorPlanApprovalEffects.$inferSelect;
