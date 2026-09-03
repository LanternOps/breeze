import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { contacts } from './contacts';
import { organizations } from './orgs';
import { portalUsers } from './portal';
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
  // NULL on legacy rows; 'system' on definitions produced without an acting
  // user; 'portal_user' on customer-portal definitions. The execution-scope
  // CHECK permits system and portal principals only for unrestricted scope
  // with no execution_scope_user_id.
  executionScopePrincipalKind: text('execution_scope_principal_kind')
    .$type<'user' | 'system' | 'portal_user'>(),
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
  portalSelfService: boolean('portal_self_service').notNull().default(false),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (table) => ({
  reportsIdOrgIdUniq: uniqueIndex('reports_id_org_id_uniq')
    .on(table.id, table.orgId),
  reportsPortalSelfServiceOrgTypeUniq: uniqueIndex(
    'reports_portal_self_service_org_type_uniq',
  ).on(table.orgId, table.type)
    .where(sql`${table.portalSelfService} = true`),
}));

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
  // See reports.executionScopePrincipalKind — the two tables' shape CHECKs
  // are kept in lockstep by design.
  executionScopePrincipalKind: text('execution_scope_principal_kind')
    .$type<'user' | 'system' | 'portal_user'>(),
  requestedByKind: text('requested_by_kind')
    .$type<'user' | 'system' | 'portal_user'>(),
  requestedByUserId: uuid('requested_by_user_id').references(
    () => users.id,
    { onDelete: 'set null' },
  ),
  requestedByPortalUserId: uuid('requested_by_portal_user_id').references(
    () => portalUsers.id,
    { onDelete: 'set null' },
  ),
  createdAt: timestamp('created_at').defaultNow().notNull()
}, (table) => ({
  requestedByShape: check(
    'report_runs_requested_by_shape_chk',
    sql`(
      (
        ${table.requestedByKind} IS NULL
        AND ${table.requestedByUserId} IS NULL
        AND ${table.requestedByPortalUserId} IS NULL
      )
      OR (
        ${table.requestedByKind} = 'user'
        AND ${table.requestedByPortalUserId} IS NULL
      )
      OR (
        ${table.requestedByKind} = 'portal_user'
        AND ${table.requestedByUserId} IS NULL
      )
      OR (
        ${table.requestedByKind} = 'system'
        AND ${table.requestedByUserId} IS NULL
        AND ${table.requestedByPortalUserId} IS NULL
      )
    ) IS TRUE`,
  ),
}));

export const reportScheduleRecipients = pgTable(
  'report_schedule_recipients',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    reportId: uuid('report_id').notNull(),
    orgId: uuid('org_id').notNull(),
    contactId: uuid('contact_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    reportOrgFk: foreignKey({
      name: 'report_schedule_recipients_report_org_fk',
      columns: [table.reportId, table.orgId],
      foreignColumns: [reports.id, reports.orgId],
    }).onDelete('cascade'),
    contactOrgFk: foreignKey({
      name: 'report_schedule_recipients_contact_org_fk',
      columns: [table.contactId, table.orgId],
      foreignColumns: [contacts.id, contacts.orgId],
    }).onDelete('cascade'),
    reportContactUniq: uniqueIndex(
      'report_schedule_recipients_report_contact_uniq',
    ).on(table.reportId, table.contactId),
    orgIdx: index('report_schedule_recipients_org_idx').on(table.orgId),
  }),
);
