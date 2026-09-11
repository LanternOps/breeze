import { sql } from 'drizzle-orm';
import { pgTable, uuid, varchar, text, timestamp, boolean, jsonb, pgEnum, integer, numeric, index, unique, char, primaryKey, type AnyPgColumn } from 'drizzle-orm/pg-core';
import type { ScriptApprovalMethod, ScriptParameterDefinition } from '@breeze/shared';
import { organizations, partners } from './orgs';
import { devices } from './devices';
import { users } from './users';

export const scriptLanguageEnum = pgEnum('script_language', ['powershell', 'bash', 'python', 'cmd']);
export const scriptRunAsEnum = pgEnum('script_run_as', ['system', 'user', 'elevated']);
// 2026-10-16-100000-script-versions-immutable.sql. The birth record of a
// version row: who or what produced this exact body.
// Values mirror SCRIPT_ORIGINS in @breeze/shared (scriptProposals.ts) —
// scripts.scriptVersions.test.ts pins both to the same order.
export const scriptOriginEnum = pgEnum('script_origin', ['human', 'ai_proposal', 'imported', 'system']);
// #3525: 'cancelling' is TRANSIENT — a cancel is in flight and unresolved. Only
// a PROVEN stop terminalises as 'cancelled'; an unproven one reverts to
// `cancel_prev_status`. Value order mirrors the installed type
// (2026-10-07-110000 adds it AFTER 'running'), which drizzle-kit compares.
export const executionStatusEnum = pgEnum('execution_status', ['pending', 'queued', 'running', 'cancelling', 'completed', 'failed', 'timeout', 'cancelled']);
// #3525: the cancel REQUEST's lifecycle, orthogonal to the execution outcome
// (spec OD8-C). NULL means no cancel was ever requested.
export const scriptCancelStateEnum = pgEnum('script_cancel_state', ['requested', 'confirmed', 'unconfirmed', 'failed']);
export const triggerTypeEnum = pgEnum('trigger_type', ['manual', 'scheduled', 'alert', 'policy', 'automation']);

// Feature #3: severity-by-exit-code mapping. Keys are non-negative integer
// strings (e.g. "0", "1"), values are AlertSeverity literals or null.
// A null value for a given exit code means "no alert"; otherwise the listed
// severity is used when a script execution finishes with that exit code.
export type ScriptExitCodeSeverityMapping = Record<string, 'critical' | 'high' | 'medium' | 'low' | 'info' | null>;

export const scripts = pgTable('scripts', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => organizations.id),
  partnerId: uuid('partner_id').references(() => partners.id),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  category: varchar('category', { length: 100 }),
  osTypes: text('os_types').array().notNull(),
  language: scriptLanguageEnum('language').notNull(),
  content: text('content').notNull(),
  // Parameter DEFINITIONS (the authoring-time contract), validated by
  // `scriptParameterDefinitionsSchema` in @breeze/shared. Note the deliberate
  // asymmetry with `script_executions.parameters` / `script_execution_batches
  // .parameters` below, which hold run-time VALUES and are typed by
  // `scriptParametersSchema` instead.
  parameters: jsonb('parameters').$type<ScriptParameterDefinition[]>(),
  timeoutSeconds: integer('timeout_seconds').notNull().default(300),
  runAs: scriptRunAsEnum('run_as').notNull().default('system'),
  isSystem: boolean('is_system').notNull().default(false),
  version: integer('version').notNull().default(1),
  // NULL = legacy behavior (non-zero exit = error). When set, see
  // ScriptExitCodeSeverityMapping above and deriveSeverityFromScript().
  exitCodeSeverityMapping: jsonb('exit_code_severity_mapping').$type<ScriptExitCodeSeverityMapping>(),
  // #5129 — the agent's STRICT-level danger-pattern DESCRIPTIONS an admin
  // explicitly acknowledged for this script (e.g. "PowerShell HKLM
  // modification"). Dispatched with every run; the agent allows exactly these
  // Strict patterns and still blocks any other match. Basic-level patterns
  // ignore this entirely and can never be acknowledged.
  //
  // A SET, not a boolean, on purpose: a boolean would mean acknowledging an
  // HKLM write permanently disarms Strict checking for the script, so a later
  // edit introducing a credential-dumping pattern would inherit the approval
  // silently. Re-derived on every save as (submitted ∩ patterns the content
  // actually matches) — see services/scriptSecurityAcknowledgement.ts.
  acknowledgedSecurityPatterns: text('acknowledged_security_patterns')
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  // Who granted the most recent acknowledgement, and when. The audit log is
  // the forensic record; these exist so the script record itself can say who
  // accepted the risk without a log query.
  securityAcknowledgedBy: uuid('security_acknowledged_by').references(() => users.id),
  securityAcknowledgedAt: timestamp('security_acknowledged_at'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  // Soft delete. Hard deletes fail with FK violations once a script has any
  // execution history (script_executions / batches reference it), so deleting
  // a script marks it here instead. Listing/lookup read paths filter
  // `deletedAt IS NULL`; execution-history joins intentionally keep it so past
  // runs still show the script name.
  deletedAt: timestamp('deleted_at')
});

export const scriptCategories = pgTable('script_categories', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => organizations.id),
  partnerId: uuid('partner_id').references(() => partners.id),
  name: varchar('name', { length: 100 }).notNull(),
  description: text('description'),
  icon: varchar('icon', { length: 50 }),
  color: varchar('color', { length: 7 }),
  // ON DELETE SET NULL (2026-10-13-120000-script-categories-parent-ownership-guard.sql,
  // #4873): org_id is nullable here (partner-wide categories, epic #2135), so a
  // single `DELETE ... WHERE org_id = $1` during GDPR org erasure does not remove
  // a row set closed under this self-reference. Letting Postgres clear the edge is
  // what keeps erasure from aborting with 23503. A DEFERRABLE constraint trigger
  // (`script_categories_parent_guard`) additionally forbids a child naming a parent
  // on a different owner axis.
  parentId: uuid('parent_id').references((): AnyPgColumn => scriptCategories.id, { onDelete: 'set null' }),
  order: integer('order').notNull().default(0),
  createdAt: timestamp('created_at').defaultNow().notNull()
}, (table) => ({
  orgIdIdx: index('script_categories_org_id_idx').on(table.orgId),
  parentIdIdx: index('script_categories_parent_id_idx').on(table.parentId),
  orgNameIdx: index('script_categories_org_name_idx').on(table.orgId, table.name)
}));

/**
 * An IMMUTABLE, content-addressed definition of one script execution.
 *
 * Append-only by construction: the table carries SELECT + INSERT RLS policies
 * only, plus a BEFORE UPDATE trigger, and rows die solely through the parent's
 * ON DELETE CASCADE (2026-10-16-100000-script-versions-immutable.sql). The one
 * writer is services/scriptVersions.ts `cutScriptVersion` — enforced by
 * services/scriptVersions.writers.contract.test.ts. Do not insert here directly.
 */
export const scriptVersions = pgTable('script_versions', {
  id: uuid('id').primaryKey().defaultRandom(),
  scriptId: uuid('script_id').notNull().references(() => scripts.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  content: text('content').notNull(),
  // The full run definition, snapshotted at cut time, so readers never have to
  // join `scripts` to learn what a past body actually ran as.
  language: scriptLanguageEnum('language').notNull(),
  timeoutSeconds: integer('timeout_seconds').notNull(),
  runAs: scriptRunAsEnum('run_as').notNull(),
  // Parameter DEFINITIONS, same contract as `scripts.parameters` above.
  parameters: jsonb('parameters').$type<ScriptParameterDefinition[]>(),
  // sha256 of the canonical content (NFC, CRLF -> LF, no trimming). The SQL
  // twin of services/scriptVersions.ts `sha256Content` — change both or
  // neither.
  contentDigest: char('content_digest', { length: 64 }).notNull(),
  origin: scriptOriginEnum('origin').notNull().default('human'),
  // Provenance. Bare uuids, not FKs: proposals and reviews are org-scoped and
  // left for erasure on a merge (spec §5), so a hard FK would either block
  // erasure or drag history with it. A stale id simply matches nothing and the
  // UI renders "review evidence erased".
  proposalId: uuid('proposal_id'),
  reviewId: uuid('review_id'),
  reviewedAt: timestamp('reviewed_at'),
  approvedBy: uuid('approved_by').references(() => users.id, { onDelete: 'set null' }),
  approvedAt: timestamp('approved_at'),
  approvalMethod: text('approval_method').$type<ScriptApprovalMethod>(),
  changelog: text('changelog'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull()
}, (table) => ({
  scriptIdIdx: index('script_versions_script_id_idx').on(table.scriptId),
  scriptIdVersionKey: unique('script_versions_script_id_version_key').on(table.scriptId, table.version)
}));

export type ScriptVersionRow = typeof scriptVersions.$inferSelect;

export const scriptTags = pgTable('script_tags', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => organizations.id),
  partnerId: uuid('partner_id').references(() => partners.id),
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
  // Definitions, same as `scripts.parameters` — a template is a script
  // blueprint, so what it stores is the parameter contract, not values.
  parameters: jsonb('parameters').$type<ScriptParameterDefinition[]>(),
  isBuiltIn: boolean('is_built_in').notNull().default(false),
  downloads: integer('downloads').notNull().default(0),
  rating: numeric('rating', { precision: 2, scale: 1 })
}, (table) => ({
  categoryIdx: index('script_templates_category_idx').on(table.category),
  languageIdx: index('script_templates_language_idx').on(table.language),
  nameIdx: index('script_templates_name_idx').on(table.name)
}));

/**
 * #2698: what the script custom-field write-back did for one execution.
 * `rejected.reason` is one of the CustomFieldWriteRejection values in
 * services/customFields/scriptWriteBack.ts. Keys only — never values.
 */
export interface ScriptCustomFieldWriteSummary {
  applied: string[];
  rejected: Array<{ key: string; reason: string }>;
}

export const scriptExecutions = pgTable('script_executions', {
  id: uuid('id').primaryKey().defaultRandom(),
  scriptId: uuid('script_id').notNull().references(() => scripts.id),
  deviceId: uuid('device_id').notNull().references(() => devices.id),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  triggeredBy: uuid('triggered_by').references(() => users.id),
  triggerType: triggerTypeEnum('trigger_type').notNull().default('manual'),
  // The automation run that queued this execution, when trigger_type is
  // 'automation' (#3162). Deliberately NOT a Drizzle `.references()`:
  // schema/automations.ts already imports this module, so pointing back at
  // `automationRuns` would close an import cycle between the two schema
  // modules. Consistent with `automation_runs.config_policy_id`, which is also
  // a bare uuid. Readers filter on it (`WHERE automation_run_id = $run`), so a
  // stale id left behind by a purged run simply matches nothing.
  automationRunId: uuid('automation_run_id'),
  // Run-time VALUES supplied by the caller, NOT definitions — do not annotate
  // this with ScriptParameterDefinition[]. Shape: `scriptParametersSchema`.
  parameters: jsonb('parameters'),
  status: executionStatusEnum('status').notNull().default('pending'),
  startedAt: timestamp('started_at'),
  completedAt: timestamp('completed_at'),
  exitCode: integer('exit_code'),
  stdout: text('stdout'),
  stderr: text('stderr'),
  errorMessage: text('error_message'),
  // #2698: per-run summary of the script custom-field write-back.
  customFieldResult: jsonb('custom_field_result').$type<ScriptCustomFieldWriteSummary>(),
  // #3525 cancellation lifecycle, orthogonal to `status` (spec OD8-C).
  // `status` says what happened to the PROCESS; these say what happened to the
  // CANCEL REQUEST. A NULL cancel_state means no cancel was ever requested —
  // enforced against cancel_requested_at by script_executions_cancel_state_chk.
  cancelRequestedAt: timestamp('cancel_requested_at'),
  // The AI-agent actor id is an ai_agents id, not a user id; the caller
  // probes-and-degrades to NULL before writing here, as triggered_by already does.
  cancelledBy: uuid('cancelled_by').references(() => users.id, { onDelete: 'set null' }),
  cancelState: scriptCancelStateEnum('cancel_state'),
  // The `device_commands.id` of the queued script_cancel. Bare uuid for the same
  // reason as automation_run_id: command rows are reaped independently and a
  // stale id must simply match nothing rather than block a delete.
  cancelCommandId: uuid('cancel_command_id'),
  // The status held when the cancel was requested. An unconfirmed or failed
  // cancel reverts to it, so the row never claims an outcome we cannot prove
  // and reapStaleScriptExecutions keeps ownership of the deadline.
  cancelPrevStatus: executionStatusEnum('cancel_prev_status'),
  // #4888 — the run context this execution ACTUALLY used, resolved at dispatch
  // as `override ?? script.runAs`. Before this column the answer lived only in
  // the transient `device_commands.payload` (sanitised out of every history
  // read), so execution history could not say whether a run went to SYSTEM or
  // to the logged-in user. NULLABLE ON PURPOSE: rows written before #4888 do
  // not know, and 'system' would be an assertion we cannot back.
  runAs: scriptRunAsEnum('run_as'),
  // The Windows session a `run_as = 'user'` run was pinned to (RDS session
  // targeting). NULL = any interactive session.
  targetSessionId: integer('target_session_id'),
  createdAt: timestamp('created_at').defaultNow().notNull()
}, (table) => ({
  automationRunIdIdx: index('script_executions_automation_run_id_idx')
    .on(table.automationRunId)
    .where(sql`automation_run_id IS NOT NULL`),
  // #3525: the cancellation sweep scans only in-flight cancels.
  cancellingIdx: index('script_executions_cancelling_idx')
    .on(table.cancelRequestedAt)
    .where(sql`status = 'cancelling'`),
  // #3525: closers resolve the execution from the cancel command's id.
  cancelCommandIdx: index('script_executions_cancel_command_idx')
    .on(table.cancelCommandId)
    .where(sql`cancel_command_id IS NOT NULL`)
}));

export const scriptExecutionBatches = pgTable('script_execution_batches', {
  id: uuid('id').primaryKey().defaultRandom(),
  scriptId: uuid('script_id').notNull().references(() => scripts.id),
  // Denormalized tenant axis (set to the executing org at insert). Nullable
  // only to allow backfill of legacy rows whose system-script parent has no
  // org_id; new rows always carry it. Enables a direct org RLS policy instead
  // of a nested-RLS join through `scripts` (which the system-script `is_system`
  // carve-out could not satisfy under bound-parameter INSERTs).
  orgId: uuid('org_id').references(() => organizations.id),
  triggeredBy: uuid('triggered_by').references(() => users.id),
  triggerType: triggerTypeEnum('trigger_type').notNull().default('manual'),
  // Run-time VALUES, as on script_executions above — not definitions.
  parameters: jsonb('parameters'),
  devicesTargeted: integer('devices_targeted').notNull(),
  devicesCompleted: integer('devices_completed').notNull().default(0),
  devicesFailed: integer('devices_failed').notNull().default(0),
  status: executionStatusEnum('status').notNull().default('pending'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  completedAt: timestamp('completed_at')
}, (table) => ({
  orgIdIdx: index('script_execution_batches_org_id_idx').on(table.orgId)
}));
