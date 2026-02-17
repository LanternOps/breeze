import { pgTable, uuid, varchar, text, timestamp, boolean, jsonb, pgEnum, integer, real, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { organizations } from './orgs';
import { users } from './users';
import { devices } from './devices';

// ============================================
// Enums
// ============================================

export const aiSessionStatusEnum = pgEnum('ai_session_status', ['active', 'closed', 'expired']);
export const aiMessageRoleEnum = pgEnum('ai_message_role', ['user', 'assistant', 'system', 'tool_use', 'tool_result']);
export const aiToolStatusEnum = pgEnum('ai_tool_status', ['pending', 'approved', 'executing', 'completed', 'failed', 'rejected']);

// ============================================
// AI Sessions
// ============================================

export const aiSessions = pgTable('ai_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  userId: uuid('user_id').references(() => users.id),
  deviceId: uuid('device_id').references(() => devices.id),
  status: aiSessionStatusEnum('status').notNull().default('active'),
  title: varchar('title', { length: 255 }),
  model: varchar('model', { length: 100 }).notNull().default('claude-sonnet-4-5-20250929'),
  systemPrompt: text('system_prompt'),
  contextSnapshot: jsonb('context_snapshot'),
  totalInputTokens: integer('total_input_tokens').notNull().default(0),
  totalOutputTokens: integer('total_output_tokens').notNull().default(0),
  totalCostCents: real('total_cost_cents').notNull().default(0),
  turnCount: integer('turn_count').notNull().default(0),
  maxTurns: integer('max_turns').notNull().default(50),
  sdkSessionId: varchar('sdk_session_id', { length: 255 }),
  lastActivityAt: timestamp('last_activity_at').defaultNow().notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (table) => ({
  orgIdIdx: index('ai_sessions_org_id_idx').on(table.orgId),
  userIdIdx: index('ai_sessions_user_id_idx').on(table.userId),
  statusIdx: index('ai_sessions_status_idx').on(table.status)
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
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
});

// ============================================
// AI Screenshots (temporary storage for vision analysis)
// ============================================

export const aiScreenshots = pgTable('ai_screenshots', {
  id: uuid('id').primaryKey().defaultRandom(),
  deviceId: uuid('device_id').notNull(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  sessionId: uuid('session_id'),
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
