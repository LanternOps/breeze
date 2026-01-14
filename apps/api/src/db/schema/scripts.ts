import { pgTable, uuid, varchar, text, timestamp, boolean, jsonb, pgEnum, integer, numeric, index, primaryKey, type AnyPgColumn } from 'drizzle-orm/pg-core';
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

export const scriptCategories = pgTable('script_categories', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => organizations.id),
  name: varchar('name', { length: 100 }).notNull(),
  description: text('description'),
  icon: varchar('icon', { length: 50 }),
  color: varchar('color', { length: 7 }),
  parentId: uuid('parent_id').references((): AnyPgColumn => scriptCategories.id),
  order: integer('order').notNull().default(0),
  createdAt: timestamp('created_at').defaultNow().notNull()
}, (table) => ({
  orgIdIdx: index('script_categories_org_id_idx').on(table.orgId),
  parentIdIdx: index('script_categories_parent_id_idx').on(table.parentId),
  orgNameIdx: index('script_categories_org_name_idx').on(table.orgId, table.name)
}));

export const scriptVersions = pgTable('script_versions', {
  id: uuid('id').primaryKey().defaultRandom(),
  scriptId: uuid('script_id').notNull().references(() => scripts.id),
  version: integer('version').notNull(),
  content: text('content').notNull(),
  changelog: text('changelog'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull()
}, (table) => ({
  scriptIdIdx: index('script_versions_script_id_idx').on(table.scriptId),
  scriptIdVersionIdx: index('script_versions_script_id_version_idx').on(table.scriptId, table.version)
}));

export const scriptTags = pgTable('script_tags', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => organizations.id),
  name: varchar('name', { length: 50 }).notNull(),
  color: varchar('color', { length: 7 })
}, (table) => ({
  orgIdIdx: index('script_tags_org_id_idx').on(table.orgId),
  orgNameIdx: index('script_tags_org_name_idx').on(table.orgId, table.name)
}));

export const scriptToTags = pgTable('script_to_tags', {
  scriptId: uuid('script_id').notNull().references(() => scripts.id),
  tagId: uuid('tag_id').notNull().references(() => scriptTags.id)
}, (table) => ({
  pk: primaryKey({ columns: [table.scriptId, table.tagId] }),
  tagIdIdx: index('script_to_tags_tag_id_idx').on(table.tagId)
}));

export const scriptTemplates = pgTable('script_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 200 }).notNull(),
  description: text('description'),
  category: varchar('category', { length: 100 }),
  language: scriptLanguageEnum('language'),
  content: text('content').notNull(),
  parameters: jsonb('parameters'),
  isBuiltIn: boolean('is_built_in').notNull().default(false),
  downloads: integer('downloads').notNull().default(0),
  rating: numeric('rating', { precision: 2, scale: 1 })
}, (table) => ({
  categoryIdx: index('script_templates_category_idx').on(table.category),
  languageIdx: index('script_templates_language_idx').on(table.language),
  nameIdx: index('script_templates_name_idx').on(table.name)
}));

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
