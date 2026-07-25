import { pgTable, uuid, varchar, text, timestamp, jsonb, pgEnum, integer } from 'drizzle-orm/pg-core';
import { organizations } from './orgs';
import { users } from './users';

export const reportTypeEnum = pgEnum('report_type', [
  'device_inventory',
  'software_inventory',
  'alert_summary',
  'compliance',
  'performance',
  'executive_summary',
  'security_compliance_posture'
]);

export const reportScheduleEnum = pgEnum('report_schedule', [
  'one_time',
  'daily',
  'weekly',
  'monthly'
]);

export const reportFormatEnum = pgEnum('report_format', ['csv', 'pdf', 'excel']);

export const reportRunStatusEnum = pgEnum('report_run_status', [
  'pending',
  'running',
  'completed',
  'failed'
]);

export const reports = pgTable('reports', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  name: varchar('name', { length: 255 }).notNull(),
  type: reportTypeEnum('type').notNull(),
  config: jsonb('config').notNull().default({}),
  schedule: reportScheduleEnum('schedule').notNull().default('one_time'),
  format: reportFormatEnum('format').notNull().default('csv'),
  lastGeneratedAt: timestamp('last_generated_at'),
  createdBy: uuid('created_by').references(() => users.id),
  executionScopeVersion: integer('execution_scope_version'),
  executionScopeKind: varchar('execution_scope_kind', { length: 32 }),
  executionScopeSiteIds: uuid('execution_scope_site_ids').array(),
  executionScopeUserId: uuid('execution_scope_user_id'),
  executionScopeFingerprint: varchar('execution_scope_fingerprint', { length: 64 }),
  executionScopeCapturedAt: timestamp('execution_scope_captured_at', { withTimezone: true }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
});

export const reportRuns = pgTable('report_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  reportId: uuid('report_id').notNull().references(() => reports.id),
  status: reportRunStatusEnum('status').notNull().default('pending'),
  startedAt: timestamp('started_at'),
  completedAt: timestamp('completed_at'),
  outputUrl: text('output_url'),
  errorMessage: text('error_message'),
  rowCount: integer('row_count'),
  result: jsonb('result'),
  executionScopeVersion: integer('execution_scope_version'),
  executionScopeKind: varchar('execution_scope_kind', { length: 32 }),
  executionScopeSiteIds: uuid('execution_scope_site_ids').array(),
  executionScopeUserId: uuid('execution_scope_user_id'),
  executionScopeFingerprint: varchar('execution_scope_fingerprint', { length: 64 }),
  executionScopeCapturedAt: timestamp('execution_scope_captured_at', { withTimezone: true }),
  createdAt: timestamp('created_at').defaultNow().notNull()
});
