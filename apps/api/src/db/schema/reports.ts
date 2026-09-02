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
  'security_compliance_posture',
  // Phase 2 wave P2-3 (#4187 / #4190): the weekly AI org narrative. Its
  // definition row is system-managed — see reports.sourceAiAgentScheduleId.
  'ai_org_narrative'
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
  // P2-3 (#4190): NULL on legacy/user rows (semantics unchanged); 'system' on
  // a definition produced by a scheduled agent run, which has no acting user.
  // reports_execution_scope_shape_chk ties this to execution_scope_user_id:
  // 'system' is only ever 'unrestricted' + user_id NULL.
  executionScopePrincipalKind: text('execution_scope_principal_kind').$type<'user' | 'system'>(),
  // P2-3 (#4190): typed identity of the ai_agent_schedules row that owns this
  // system-managed definition (never a config-jsonb key). The FK
  // (ON DELETE SET NULL) and the partial unique index
  // reports_source_ai_agent_schedule_uniq are declared in SQL ONLY
  // (migrations/2026-09-24-b-ai-agents-org-narrative.sql) — a `.references()`
  // here would make this module import aiAgentSchedules.ts, which imports
  // aiAgents.ts, which (for aiAgentRuns.reportRunId) imports this file: a
  // three-module cycle. Drizzle's lazy `AnyPgColumn` trick fixes the value
  // cycle but not the import cycle, so the FK stays SQL-side and the cascade
  // contract reads it from pg_constraint at runtime anyway.
  sourceAiAgentScheduleId: uuid('source_ai_agent_schedule_id'),
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
  // P2-3 (#4190): see reports.executionScopePrincipalKind — the two tables'
  // shape CHECKs are kept in lockstep by design.
  executionScopePrincipalKind: text('execution_scope_principal_kind').$type<'user' | 'system'>(),
  createdAt: timestamp('created_at').defaultNow().notNull()
});
