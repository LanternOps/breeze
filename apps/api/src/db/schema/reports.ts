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
import { organizations, partners } from './orgs';
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
  'ai_org_narrative',
  // Fleet Designer W01 (#5651): one system-managed definition per org, keyed
  // by type (see reportsAiFleetDesignOrgUniq below) rather than by schedule —
  // manual design runs have no schedule to key on.
  'ai_fleet_design',
  // Hardware Lifecycle report: device replacement plan from purchase +
  // warranty dates (ported from the LanternOps portal PDF).
  'hardware_lifecycle',
  // Service-plan evidence #5784: W02 threat_detection_review (Huntress
  // incidents for an occurrence's period, with an explicit coverage window;
  // see services/threatDetectionReport.ts), W03 endpoint_management_review
  // (over the #5327 M365 Intune sync tables — enrolment coverage, compliance
  // breakdown, stale enrolments and licence seats; generated on demand, zero
  // new tables), W04 vulnerability_management (the vulnerability DETAIL
  // artifact — findings, exceptions and remediation ranking;
  // `security_compliance_posture` keeps its single vulnerability control
  // line; neither replaces the other), and W06 identity_access_review
  // (interactive sign-in review, identity inventory, conditional access
  // posture and remote-access client presence; org-wide by construction; see
  // services/identityAccessReport.ts).
  'threat_detection_review',
  'endpoint_management_review',
  'vulnerability_management',
  'identity_access_review',
  // #3198 W01: business report types (generators land in W02).
  'ticket_sla_attainment',
  'technician_time_billability',
  'ar_aging',
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
  // #3198 W01: org XOR partner ownership (reports_one_owner_chk). A partner-
  // owned definition (partner_id set, org_id NULL) is a cross-org aggregate
  // legible only to partner-scope callers with org_access = 'all'.
  orgId: uuid('org_id').references(() => organizations.id),
  partnerId: uuid('partner_id').references(() => partners.id),
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
  reportsPartnerIdIdx: index('reports_partner_id_idx').on(table.partnerId),
  reportsPortalSelfServiceOrgTypeUniq: uniqueIndex(
    'reports_portal_self_service_org_type_uniq',
  ).on(table.orgId, table.type)
    .where(sql`${table.portalSelfService} = true`),
  // Fleet Designer W01 (#5651): one Fleet Design definition per org. See
  // migrations/2026-10-16-170500-ai-agents-fleet-designer.sql.
  aiFleetDesignOrgUniq: uniqueIndex('reports_ai_fleet_design_org_uniq')
    .on(table.orgId)
    .where(sql`${table.type} = 'ai_fleet_design'`),
}));

export const reportRuns = pgTable('report_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  // #3198 W01: ON DELETE CASCADE since migration 2026-10-26-140100.
  reportId: uuid('report_id').notNull().references(() => reports.id, { onDelete: 'cascade' }),
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
  /**
   * An `ai_run_artifacts` row attached to this report run by reference
   * (execution-plane spec §6.3). `ON DELETE SET NULL`: an expired artifact
   * leaves the run intact with nothing attached.
   *
   * The FK is created in SQL only (2026-10-16-192900-artifact-attachments.sql),
   * not declared with `.references()`, to dodge an import cycle: `aiWorkspace`
   * imports `aiAgents`, which imports THIS module for `reportRuns`. Same
   * technique as `contracts.ts`'s catalog_item_id / site_id.
   */
  artifactId: uuid('artifact_id'),
  createdAt: timestamp('created_at').defaultNow().notNull()
}, (table) => ({
  // (id, report_id) key so service_deliverable_evidence can prove a run belongs to
  // a report of the same org (report_runs has no org_id of its own). Spec #5573 §4.3.
  reportRunsIdReportIdUniq: uniqueIndex('report_runs_id_report_id_uniq').on(table.id, table.reportId),
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

export const REPORT_RUN_DELIVERY_STATES = ['pending', 'claimed', 'sent', 'failed', 'unknown'] as const;
export type ReportRunDeliveryState = (typeof REPORT_RUN_DELIVERY_STATES)[number];

/**
 * #4248 W03 — one durable delivery record per (run, recipient, channel) for the
 * weekly AI org narrative. Claimed (`pending -> claimed`) in its own committed
 * write BEFORE any network call, settled to `sent` / `failed` / `unknown`
 * afterwards; `unknown` is never auto-reset. See
 * migrations/2026-10-16-183300-report-run-deliveries.sql for the tenancy and
 * registration rationale (parent-FK-join RLS via `reports`; ON DELETE CASCADE
 * is why it is in no cascade/export/merge registry). `state` and `channel` are
 * plain text -- the migration's CHECK constraints are the source of truth.
 *
 * NEVER add the recipient's email address here: it is resolved from `users`
 * at send time. This table sits outside the export and erasure registries.
 */
export const reportRunDeliveries = pgTable(
  'report_run_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    reportRunId: uuid('report_run_id')
      .notNull()
      .references(() => reportRuns.id, { onDelete: 'cascade' }),
    recipientUserId: uuid('recipient_user_id').notNull(),
    channel: text('channel').$type<'email'>().notNull(),
    state: text('state').$type<ReportRunDeliveryState>().notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    runRecipientChannelUniq: uniqueIndex('report_run_deliveries_run_recipient_channel_uq')
      .on(table.reportRunId, table.recipientUserId, table.channel),
    unsettledIdx: index('report_run_deliveries_unsettled_idx')
      .on(table.state, table.claimedAt)
      .where(sql`${table.state} IN ('pending', 'claimed')`),
    runIdx: index('report_run_deliveries_run_idx').on(table.reportRunId),
    channelChk: check('report_run_deliveries_channel_chk', sql`${table.channel} IN ('email')`),
    stateChk: check(
      'report_run_deliveries_state_chk',
      sql`${table.state} IN ('pending', 'claimed', 'sent', 'failed', 'unknown')`,
    ),
  }),
);

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
