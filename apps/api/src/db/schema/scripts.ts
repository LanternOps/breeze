import { pgTable, uuid, varchar, text, timestamp, boolean, jsonb, pgEnum, integer } from 'drizzle-orm/pg-core';
import { organizations } from './orgs';
import { devices } from './devices';
import { users } from './users';

export const scriptLanguageEnum = pgEnum('script_language', ['powershell', 'bash', 'python', 'cmd']);
export const scriptRunAsEnum = pgEnum('script_run_as', ['system', 'user', 'elevated']);
export const executionStatusEnum = pgEnum('execution_status', ['pending', 'queued', 'running', 'completed', 'failed', 'timeout', 'cancelled']);
export const triggerTypeEnum = pgEnum('trigger_type', ['manual', 'scheduled', 'alert', 'policy']);

export const scripts = pgTable('scripts', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => organizations.id),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  category: varchar('category', { length: 100 }),
  osTypes: text('os_types').array().notNull(),
  language: scriptLanguageEnum('language').notNull(),
  content: text('content').notNull(),
  parameters: jsonb('parameters'),
  timeoutSeconds: integer('timeout_seconds').notNull().default(300),
  runAs: scriptRunAsEnum('run_as').notNull().default('system'),
  isSystem: boolean('is_system').notNull().default(false),
  version: integer('version').notNull().default(1),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
});

export const scriptExecutions = pgTable('script_executions', {
  id: uuid('id').primaryKey().defaultRandom(),
  scriptId: uuid('script_id').notNull().references(() => scripts.id),
  deviceId: uuid('device_id').notNull().references(() => devices.id),
  triggeredBy: uuid('triggered_by').references(() => users.id),
  triggerType: triggerTypeEnum('trigger_type').notNull().default('manual'),
  parameters: jsonb('parameters'),
  status: executionStatusEnum('status').notNull().default('pending'),
  startedAt: timestamp('started_at'),
  completedAt: timestamp('completed_at'),
  exitCode: integer('exit_code'),
  stdout: text('stdout'),
  stderr: text('stderr'),
  errorMessage: text('error_message'),
  createdAt: timestamp('created_at').defaultNow().notNull()
});

export const scriptExecutionBatches = pgTable('script_execution_batches', {
  id: uuid('id').primaryKey().defaultRandom(),
  scriptId: uuid('script_id').notNull().references(() => scripts.id),
  triggeredBy: uuid('triggered_by').references(() => users.id),
  triggerType: triggerTypeEnum('trigger_type').notNull().default('manual'),
  parameters: jsonb('parameters'),
  devicesTargeted: integer('devices_targeted').notNull(),
  devicesCompleted: integer('devices_completed').notNull().default(0),
  devicesFailed: integer('devices_failed').notNull().default(0),
  status: executionStatusEnum('status').notNull().default('pending'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  completedAt: timestamp('completed_at')
});
