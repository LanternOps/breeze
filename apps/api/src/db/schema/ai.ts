import { pgTable, uuid, varchar, text, timestamp, boolean, jsonb, pgEnum, integer, real, smallint, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations } from './orgs';
import { users } from './users';
import { devices } from './devices';
import { portalUsers } from './portal';
import { actionIntents } from './actionIntents';

// ============================================
// Enums
// ============================================

export const aiSessionStatusEnum = pgEnum('ai_session_status', ['active', 'closed', 'expired']);
export const aiMessageRoleEnum = pgEnum('ai_message_role', ['user', 'assistant', 'system', 'tool_use', 'tool_result']);
export const aiToolStatusEnum = pgEnum('ai_tool_status', ['pending', 'approved', 'executing', 'completed', 'failed', 'rejected']);
export const aiApprovalModeEnum = pgEnum('ai_approval_mode', [
  'per_step', 'action_plan', 'auto_approve', 'hybrid_plan',
]);
export const aiPlanStatusEnum = pgEnum('ai_plan_status', [
  'pending', 'approved', 'rejected', 'executing', 'completed', 'aborted',
]);

// ============================================
// AI Sessions
// ============================================

export const aiSessions = pgTable('ai_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  userId: uuid('user_id').references(() => users.id),
  deviceId: uuid('device_id').references(() => devices.id),
  status: aiSessionStatusEnum('status').notNull().default('active'),
  type: text('type').notNull().default('general'),
  title: varchar('title', { length: 255 }),
  model: varchar('model', { length: 100 }).notNull().default('claude-sonnet-4-5-20250929'),
  billingSource: text('billing_source', { enum: ['platform', 'partner_key'] }).notNull().default('platform'),
  catalogEntryId: uuid('catalog_entry_id'),
  catalogRevisionId: uuid('catalog_revision_id'),
  systemPrompt: text('system_prompt'),
  contextSnapshot: jsonb('context_snapshot'),
  // TOTAL input across the session — uncached + cache-read + cache-creation.
  // The SDK splits those three apart because they are priced differently, not
  // because only the first is "input"; see sumInputTokens in aiCostTracker.
  // Rows written before that fix carry the uncached slice only and read
  // implausibly low (an 8-turn session at 17 tokens); they are NOT backfilled,
  // since the split components were never persisted anywhere to recover from.
  totalInputTokens: integer('total_input_tokens').notNull().default(0),
  totalOutputTokens: integer('total_output_tokens').notNull().default(0),
  // Independent of the token columns above: cost comes from the SDK's own
  // total_cost_usd, or from per-component pricing when that is 0. It was
  // correct throughout — do not "reconcile" it against the token columns.
  totalCostCents: real('total_cost_cents').notNull().default(0),
  turnCount: integer('turn_count').notNull().default(0),
  maxTurns: integer('max_turns').notNull().default(50),
  sdkSessionId: varchar('sdk_session_id', { length: 255 }),
  lastActivityAt: timestamp('last_activity_at').defaultNow().notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  flaggedAt: timestamp('flagged_at'),
  flaggedBy: uuid('flagged_by').references(() => users.id),
  flagReason: text('flag_reason'),
  delegantM365ConnectionId: uuid('delegant_m365_connection_id'),
  // AI for Office client principal (FK → portal_users). CHECKs in SQL:
  // ai_sessions_single_principal_check (never both user_id and client_user_id),
  // ai_sessions_client_principal_check (any client session — type matching the
  // `${host}_client` convention, e.g. 'excel_client'/'word_client' — ⇒ set).
  // Partial index ai_sessions_client_user_id_idx created via SQL migration.
  clientUserId: uuid('client_user_id').references(() => portalUsers.id),
  // AI for Office: the name of the Excel workbook the session happened in,
  // captured at create time so the per-user history list can tag/filter by
  // file. Nullable (older rows, non-Office sessions). Added in
  // 2026-06-13-c-ai-sessions-workbook-name.sql.
  workbookName: varchar('workbook_name', { length: 500 }),
  // AI agent principal (spec §3.3). CHECK ai_sessions_single_principal_check
  // (at most one of user_id/client_user_id/agent_id) and
  // ai_sessions_agent_type_check (type='agent' ⇒ agent_id set) live in
  // 2026-09-02-ai-agents.sql. FK is declared in SQL to avoid a circular import
  // (aiAgents.ts imports aiSessions for ai_agent_runs.session_id).
  agentId: uuid('agent_id'),
}, (table) => ({
  orgIdIdx: index('ai_sessions_org_id_idx').on(table.orgId),
  userIdIdx: index('ai_sessions_user_id_idx').on(table.userId),
  statusIdx: index('ai_sessions_status_idx').on(table.status),
  // flaggedAt partial index created via SQL migration (WHERE flagged_at IS NOT NULL)
}));

// ============================================
// AI Messages
// ============================================

export const aiMessages = pgTable('ai_messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id').notNull().references(() => aiSessions.id),
  role: aiMessageRoleEnum('role').notNull(),
  content: text('content'),
  contentBlocks: jsonb('content_blocks'),
  toolName: varchar('tool_name', { length: 100 }),
  toolInput: jsonb('tool_input'),
  toolOutput: jsonb('tool_output'),
  toolUseId: varchar('tool_use_id', { length: 100 }),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  createdAt: timestamp('created_at').defaultNow().notNull()
}, (table) => ({
  sessionIdIdx: index('ai_messages_session_id_idx').on(table.sessionId),
  roleIdx: index('ai_messages_role_idx').on(table.role)
}));

// ============================================
// AI Tool Executions (audit trail)
// ============================================

export const aiToolExecutions = pgTable('ai_tool_executions', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id').notNull().references(() => aiSessions.id),
  messageId: uuid('message_id').references(() => aiMessages.id),
  toolName: varchar('tool_name', { length: 100 }).notNull(),
  toolInput: jsonb('tool_input').notNull(),
  toolOutput: jsonb('tool_output'),
  status: aiToolStatusEnum('status').notNull().default('pending'),
  approvedBy: uuid('approved_by').references(() => users.id),
  approvedAt: timestamp('approved_at'),
  commandId: uuid('command_id'),
  durationMs: integer('duration_ms'),
  errorMessage: text('error_message'),
  delegantToolCallId: varchar('delegant_tool_call_id', { length: 64 }),
  // Links this execution ledger row to the durable action_intents row it was
  // created for (Tier-3 chat flow only — services/actionIntents/intentService.ts's
  // createActionIntent). NULL for legacy Tier-2 per_step / helper-PAM
  // executions, which never go through the intents layer. Set in
  // 2026-07-18-c-ai-executions-intent-id.sql; used by handleApproval
  // (services/aiAgent.ts) to detect intent-backed executions and refuse to
  // report a self-approval success for them (whole-branch review CRITICAL-3).
  intentId: uuid('intent_id').references(() => actionIntents.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  completedAt: timestamp('completed_at')
}, (table) => ({
  sessionIdIdx: index('ai_tool_executions_session_id_idx').on(table.sessionId),
  statusIdx: index('ai_tool_executions_status_idx').on(table.status)
}));

// ============================================
// AI Cost Usage (daily/monthly aggregates)
// ============================================

export const aiCostUsage = pgTable('ai_cost_usage', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  period: varchar('period', { length: 10 }).notNull(), // 'daily' or 'monthly'
  periodKey: varchar('period_key', { length: 10 }).notNull(), // '2026-02-06' or '2026-02'
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  totalCostCents: real('total_cost_cents').notNull().default(0),
  sessionCount: integer('session_count').notNull().default(0),
  messageCount: integer('message_count').notNull().default(0),
  toolExecutionCount: integer('tool_execution_count').notNull().default(0),
  // Most-recent-writer label, not a per-source cost split; deductions are decided per turn, never from this column.
  billingSource: text('billing_source', { enum: ['platform', 'partner_key'] }).notNull().default('platform'),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (table) => ({
  orgPeriodIdx: uniqueIndex('ai_cost_usage_org_period_idx').on(table.orgId, table.period, table.periodKey)
}));

// ============================================
// AI Budgets (per-org configuration)
// ============================================

export const aiBudgets = pgTable('ai_budgets', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id).unique(),
  enabled: boolean('enabled').notNull().default(true),
  monthlyBudgetCents: integer('monthly_budget_cents'),
  dailyBudgetCents: integer('daily_budget_cents'),
  maxTurnsPerSession: integer('max_turns_per_session').notNull().default(50),
  allowedModels: jsonb('allowed_models').default(['claude-sonnet-4-5-20250929']),
  messagesPerMinutePerUser: integer('messages_per_minute_per_user').notNull().default(20),
  messagesPerHourPerOrg: integer('messages_per_hour_per_org').notNull().default(200),
  approvalMode: aiApprovalModeEnum('approval_mode').notNull().default('per_step'),
  // #4388 — pre-cap alert ladder. NULL = inherit default [50,80,95]; [] = off.
  // Property name must equal the partner-JSONB key so the AI_BUDGET_FIELDS
  // merge loop in effectiveSettings.ts reads both sides with one name.
  alertThresholdPercents: integer('alert_threshold_pcts').array(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
});

// ============================================
// AI Budget Alert Events (#4388) — durable outbox, one row per threshold
// crossing per (org, period, period_key). RLS shape 1.
// ============================================

export const aiBudgetAlertEvents = pgTable('ai_budget_alert_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  period: text('period', { enum: ['daily', 'monthly'] }).notNull(),
  periodKey: varchar('period_key', { length: 10 }).notNull(),
  thresholdPct: smallint('threshold_pct').notNull(),
  capCents: integer('cap_cents').notNull(),
  usedCents: integer('used_cents').notNull(),
  billingSource: text('billing_source', { enum: ['platform', 'partner_key'] }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  deliveryAttempts: integer('delivery_attempts').notNull().default(0),
  lastDeliveryError: text('last_delivery_error'),
  recipientCount: integer('recipient_count'),
}, (table) => ({
  orgPeriodRungIdx: uniqueIndex('ai_budget_alert_events_org_period_rung_uidx')
    .on(table.orgId, table.period, table.periodKey, table.thresholdPct),
  undeliveredIdx: index('ai_budget_alert_events_undelivered_idx')
    .on(table.createdAt)
    .where(sql`${table.deliveredAt} IS NULL`),
}));

// ============================================
// AI Action Plans (multi-step approval)
// ============================================

export const aiActionPlans = pgTable('ai_action_plans', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id').notNull().references(() => aiSessions.id),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  status: aiPlanStatusEnum('status').notNull().default('pending'),
  steps: jsonb('steps').notNull(),           // Array<ActionPlanStep>
  currentStepIndex: integer('current_step_index').notNull().default(0),
  approvedBy: uuid('approved_by').references(() => users.id),
  approvedAt: timestamp('approved_at'),
  completedAt: timestamp('completed_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  sessionIdIdx: index('ai_action_plans_session_id_idx').on(table.sessionId),
  statusIdx: index('ai_action_plans_status_idx').on(table.status),
}));

// ============================================
// AI Screenshots (temporary storage for vision analysis)
// ============================================

export const aiScreenshots = pgTable('ai_screenshots', {
  id: uuid('id').primaryKey().defaultRandom(),
  deviceId: uuid('device_id').notNull().references(() => devices.id),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  sessionId: uuid('session_id').references(() => aiSessions.id),
  storageKey: varchar('storage_key', { length: 500 }).notNull(),
  width: integer('width').notNull(),
  height: integer('height').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  capturedBy: varchar('captured_by', { length: 50 }).notNull().default('agent'),
  reason: varchar('reason', { length: 200 }),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  deviceIdIdx: index('ai_screenshots_device_id_idx').on(table.deviceId),
  orgIdIdx: index('ai_screenshots_org_id_idx').on(table.orgId),
  expiresAtIdx: index('ai_screenshots_expires_at_idx').on(table.expiresAt),
}));
