import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  boolean,
  jsonb,
  pgEnum,
  integer,
  index,
} from 'drizzle-orm/pg-core';
import { organizations } from './orgs';
import { devices } from './devices';
import { users } from './users';

export const playbookExecutionStatusEnum = pgEnum('playbook_execution_status', [
  'pending',
  'running',
  'waiting',
  'completed',
  'failed',
  'rolled_back',
  'cancelled',
]);

export const playbookStepTypeEnum = pgEnum('playbook_step_type', [
  'diagnose',
  'act',
  'wait',
  'verify',
  'rollback',
]);

export type PlaybookExecutionStatus = typeof playbookExecutionStatusEnum.enumValues[number];
export type PlaybookStepType = typeof playbookStepTypeEnum.enumValues[number];
export type PlaybookStepFailureBehavior = 'stop' | 'continue' | 'rollback';
export type PlaybookStepResultStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export interface PlaybookVerificationCondition {
  metric: string;
  operator: 'lt' | 'gt' | 'eq' | 'ne' | 'contains';
  value: unknown;
}

export interface PlaybookStep {
  type: PlaybookStepType;
  name: string;
  description: string;
  tool?: string;
  toolInput?: Record<string, unknown>;
  waitSeconds?: number;
  verifyCondition?: PlaybookVerificationCondition;
  onFailure?: PlaybookStepFailureBehavior;
}

export interface PlaybookStepResult {
  stepIndex: number;
  stepName: string;
  status: PlaybookStepResultStatus;
  toolUsed?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: string;
  error?: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
}

export interface PlaybookTriggerConditions {
  alertTypes?: string[];
  deviceTags?: string[];
  autoExecute?: boolean;
  minSeverity?: 'low' | 'medium' | 'high' | 'critical';
}

export interface PlaybookExecutionContext {
  alertId?: string;
  conversationId?: string;
  userInput?: string;
  variables?: Record<string, unknown>;
}

export const playbookDefinitions = pgTable('playbook_definitions', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => organizations.id),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description').notNull(),
  steps: jsonb('steps').$type<PlaybookStep[]>().notNull(),
  triggerConditions: jsonb('trigger_conditions').$type<PlaybookTriggerConditions>(),
  isBuiltIn: boolean('is_built_in').notNull().default(false),
  isActive: boolean('is_active').notNull().default(true),
  category: varchar('category', { length: 50 }),
  requiredPermissions: jsonb('required_permissions').$type<string[]>().notNull().default([]),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  orgIdIdx: index('playbook_definitions_org_id_idx').on(table.orgId),
  activeIdx: index('playbook_definitions_active_idx').on(table.isActive),
  categoryIdx: index('playbook_definitions_category_idx').on(table.category),
}));

export const playbookExecutions = pgTable('playbook_executions', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  deviceId: uuid('device_id').notNull().references(() => devices.id),
  playbookId: uuid('playbook_id').notNull().references(() => playbookDefinitions.id),
  status: playbookExecutionStatusEnum('status').notNull().default('pending'),
  currentStepIndex: integer('current_step_index').notNull().default(0),
  steps: jsonb('steps').$type<PlaybookStepResult[]>().notNull().default([]),
  context: jsonb('context').$type<PlaybookExecutionContext>(),
  errorMessage: text('error_message'),
  rollbackExecuted: boolean('rollback_executed').notNull().default(false),
  startedAt: timestamp('started_at'),
  completedAt: timestamp('completed_at'),
  triggeredBy: varchar('triggered_by', { length: 50 }).notNull(),
  triggeredByUserId: uuid('triggered_by_user_id').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  orgIdIdx: index('playbook_executions_org_id_idx').on(table.orgId),
  deviceIdIdx: index('playbook_executions_device_id_idx').on(table.deviceId),
  playbookIdIdx: index('playbook_executions_playbook_id_idx').on(table.playbookId),
  statusIdx: index('playbook_executions_status_idx').on(table.status),
  createdAtIdx: index('playbook_executions_created_at_idx').on(table.createdAt),
}));
