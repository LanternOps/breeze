import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import type {
  AiAgentActAssets,
  AiAgentKind,
  AiAgentLimits,
  AiAgentMode,
  AiAgentPolicySnapshot,
  AiAgentProtectedResources,
  AiAgentRecipients,
  AiAgentRunProfile,
  AiAgentRunStatus,
  AiAgentTriggerKind,
  AiAgentTriggers,
} from '@breeze/shared';
import { alertCorrelationGroups, alerts } from './alerts';
import { aiSessions } from './ai';
import { aiAgentSchedules } from './aiAgentSchedules';
import { devices } from './devices';
import { metricAnomalyIncidents } from './metricAnomalyIncidents';
import { organizations, partners } from './orgs';
import { tickets } from './portal';
import { reportRuns } from './reports';
import { users } from './users';

// Dual-ownership (#2135, spec §4.1): an agent belongs to EITHER one org
// (org_id set) OR a whole partner (partner_id set, org_id NULL). The XOR
// CHECK `ai_agents_one_owner_chk` lives in 2026-09-02-ai-agents.sql.
// Never hard-deleted: `disabled_at` is the soft delete and the partial
// unique indexes only consider live rows.
export const aiAgents = pgTable('ai_agents', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => organizations.id),
  partnerId: uuid('partner_id').references(() => partners.id),
  kind: text('kind').$type<AiAgentKind>().notNull(),
  name: varchar('name', { length: 120 }).notNull(),
  enabled: boolean('enabled').notNull().default(false),
  mode: text('mode').$type<AiAgentMode>().notNull().default('off'),
  model: varchar('model', { length: 100 }),
  toolAllowlist: jsonb('tool_allowlist').$type<string[]>().notNull().default([]),
  protectedResources: jsonb('protected_resources').$type<Partial<AiAgentProtectedResources>>().notNull().default({}),
  limits: jsonb('limits').$type<Partial<AiAgentLimits>>().notNull().default({}),
  triggers: jsonb('triggers').$type<Partial<AiAgentTriggers>>().notNull().default({}),
  recipients: jsonb('recipients').$type<Partial<AiAgentRecipients>>().notNull().default({}),
  // Wave 4 Part B (Task 6, #3826): per-script act-mode authorization — see
  // AiAgentActAssets's docstring. New column (migrations/2026-09-15-ai-agents-act-assets.sql);
  // registered CORE_TENANT_EXPORT_POLICY excludedOpen (open jsonb container,
  // same bucket as every other policy column on this table).
  actAssets: jsonb('act_assets').$type<Partial<AiAgentActAssets>>().notNull().default({}),
  instructions: text('instructions'),
  cooldownSeconds: integer('cooldown_seconds').notNull().default(900),
  disabledAt: timestamp('disabled_at', { withTimezone: true }),
  disabledBy: uuid('disabled_by').references(() => users.id),
  createdBy: uuid('created_by').notNull().references(() => users.id),
  lastUpdatedBy: uuid('last_updated_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  partnerKindUq: uniqueIndex('ai_agents_partner_kind_uq').on(table.partnerId, table.kind)
    .where(sql`${table.orgId} IS NULL AND ${table.disabledAt} IS NULL`),
  orgKindUq: uniqueIndex('ai_agents_org_kind_uq').on(table.orgId, table.kind)
    .where(sql`${table.disabledAt} IS NULL`),
  partnerIdx: index('ai_agents_partner_id_idx').on(table.partnerId),
  orgIdx: index('ai_agents_org_id_idx').on(table.orgId),
}));

// Ledger (spec §4.2). org_id is ALWAYS the target org (the device's org), even
// for a partner-wide agent. Shape 1 RLS + device cascade + org-denormalized.
export const aiAgentRuns = pgTable('ai_agent_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  agentId: uuid('agent_id').notNull().references(() => aiAgents.id, { onDelete: 'restrict' }),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'set null' }),
  alertId: uuid('alert_id').references(() => alerts.id, { onDelete: 'set null' }),
  // Phase 2 wave P2-1 (alert verdicts, migrations/2026-09-21-ai-agents-alert-verdicts.sql):
  // 'full' is the pre-existing run shape; 'verdict' scopes the run to
  // producing one ai_alert_verdicts row instead of a full triage/patch/
  // helpdesk turn. correlationGroupId is set only for a verdict run
  // evaluating a correlation group rather than a single alert.
  profile: text('profile').$type<AiAgentRunProfile>().notNull().default('full'),
  correlationGroupId: uuid('correlation_group_id')
    .references(() => alertCorrelationGroups.id, { onDelete: 'set null' }),
  // P2-2: the partner schedule whose occurrence admitted this sweep run.
  // ON DELETE SET NULL — a deleted schedule keeps its historical runs.
  // Lazy `(): AnyPgColumn =>` reference (not a plain `() =>` typed one):
  // aiAgentSchedules.ts imports `aiAgents` from this file for its own
  // agentId FK, so this is a genuine cross-file cycle, not merely a
  // same-file self-reference like `aiAlertVerdicts.supersededBy` — same
  // workaround, applied across the module boundary this time.
  scheduleId: uuid('schedule_id').references((): AnyPgColumn => aiAgentSchedules.id, { onDelete: 'set null' }),
  // P2-3 (#4190): the narrative ARTIFACT (`report_runs`), not the definition —
  // the trace links to something downloadable; the definition is
  // `report_runs.report_id`. ON DELETE SET NULL, same treatment as
  // scheduleId/alertId: run history survives artifact deletion. A plain
  // `() =>` reference is safe here: reports.ts imports only orgs/users, so
  // this edge introduces no cycle (and reports.sourceAiAgentScheduleId is
  // deliberately SQL-only for exactly that reason — see its comment).
  reportRunId: uuid('report_run_id').references(() => reportRuns.id, { onDelete: 'set null' }),
  sessionId: uuid('session_id').references(() => aiSessions.id, { onDelete: 'set null' }),
  // Wave 6 PR 3 (#3828): the triggering ticket for a `triggerKind==='ticket'`
  // run. ON DELETE SET NULL (run history survives ticket deletion — mirrors
  // alertId/deviceId's set-null-on-delete treatment, not action_intents'
  // ON DELETE RESTRICT composite FK, which exists for a different reason:
  // preserving requesting_agent_run_id attribution on an approval record).
  ticketId: uuid('ticket_id').references(() => tickets.id, { onDelete: 'set null' }),
  // Wave 6 PR 4 (#3828): the triggering incident for a `triggerKind==='anomaly'`
  // run. ON DELETE SET NULL — run history survives incident deletion, same
  // treatment as alertId/deviceId/ticketId above. This is the ONE direction
  // of the ai_agent_runs <-> metric_anomaly_incidents relationship that gets
  // a real FK constraint (Drizzle AND SQL) — the reverse column,
  // metricAnomalyIncidents.agentRunId, deliberately has none, because both
  // tables are org-cascade members and a real mutual FK pair would be a
  // 2-node cycle tenantCascade.ts's topologicalCascadeOrder() cannot resolve
  // (see metricAnomalyIncidents.ts's docstring and the migration header for
  // the full account). No import-cycle concern either way:
  // metricAnomalyIncidents.ts imports neither this file nor `tickets`.
  anomalyIncidentId: uuid('anomaly_incident_id')
    .references(() => metricAnomalyIncidents.id, { onDelete: 'set null' }),
  triggerKind: text('trigger_kind').$type<AiAgentTriggerKind>().notNull(),
  triggerEventId: varchar('trigger_event_id', { length: 64 }),
  triggerRef: jsonb('trigger_ref').$type<Record<string, unknown>>().notNull().default({}),
  dedupeKey: varchar('dedupe_key', { length: 255 }).notNull(),
  modeAtStart: text('mode_at_start').$type<Exclude<AiAgentMode, 'off'>>().notNull(),
  policySnapshot: jsonb('policy_snapshot').$type<AiAgentPolicySnapshot>().notNull(),
  status: text('status').$type<AiAgentRunStatus>().notNull().default('queued'),
  summary: text('summary'),
  outcome: jsonb('outcome').$type<Record<string, unknown>>().notNull().default({}),
  intentIds: uuid('intent_ids').array().notNull().default(sql`'{}'::uuid[]`),
  turnCount: integer('turn_count').notNull().default(0),
  costCents: integer('cost_cents').notNull().default(0),
  errorCode: varchar('error_code', { length: 64 }),
  correlationId: varchar('correlation_id', { length: 64 }),
  queuedAt: timestamp('queued_at', { withTimezone: true }).defaultNow().notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
}, (table) => ({
  // Tenant-scoped (see 2026-09-02-ai-agents.sql): a global unique on
  // dedupe_key is enforced below RLS and leaks cross-tenant existence.
  dedupeUq: unique('ai_agent_runs_org_dedupe_key_uq').on(table.orgId, table.dedupeKey),
  // Declares the tuple the action_intents AND ticket_drafts composite
  // tenant FKs reference. `id` is already PK, so this adds no new tenancy
  // invariant on its own — it exists so (requesting_agent_run_id, org_id) /
  // (run_id, org_id) have a target. Renamed from the original
  // ai_agent_runs_id_org_id_key (2026-09-05-a-agent-originated-intents.sql)
  // to ai_agent_runs_id_org_uq by 2026-09-25-ai-agents-ticket-triage.sql —
  // same physical index, new name only — see that migration's comment for
  // why (a second composite-FK dependent forced the rename).
  idOrgUq: unique('ai_agent_runs_id_org_uq').on(table.id, table.orgId),
  agentQueuedIdx: index('ai_agent_runs_agent_queued_idx').on(table.agentId, table.queuedAt.desc()),
  orgQueuedIdx: index('ai_agent_runs_org_queued_idx').on(table.orgId, table.queuedAt.desc()),
  // Wave 6 PR 1 (#3828, migrations/2026-09-17-ai-agent-runs-keyset-index.sql):
  // covers the org-wide keyset list's (org_id, queued_at DESC, id DESC) walk.
  // orgQueuedIdx above lacks the id tiebreaker a keyset needs and is kept
  // (not dropped) — see the migration header for why.
  orgQueuedIdIdx: index('ai_agent_runs_org_queued_id_idx').on(table.orgId, table.queuedAt.desc(), table.id.desc()),
  deviceIdx: index('ai_agent_runs_device_id_idx').on(table.deviceId),
  ticketIdx: index('ai_agent_runs_ticket_id_idx').on(table.ticketId),
  anomalyIncidentIdx: index('ai_agent_runs_anomaly_incident_id_idx').on(table.anomalyIncidentId),
  // Phase 2 wave P2-1: verdict admission counts only verdict-profile rows
  // (runService step 6b) — mirrors migrations/2026-09-21-ai-agents-alert-verdicts.sql's
  // ai_agent_runs_agent_profile_queued_idx.
  agentProfileQueuedIdx: index('ai_agent_runs_agent_profile_queued_idx')
    .on(table.agentId, table.orgId, table.profile, table.queuedAt.desc()),
  correlationGroupIdx: index('ai_agent_runs_correlation_group_idx')
    .on(table.correlationGroupId).where(sql`${table.correlationGroupId} IS NOT NULL`),
  // P2-2: mirrors migrations/2026-09-23-ai-agents-scheduled-sweeps.sql's
  // ai_agent_runs_schedule_idx.
  scheduleIdx: index('ai_agent_runs_schedule_idx')
    .on(table.scheduleId).where(sql`${table.scheduleId} IS NOT NULL`),
}));

export type AiAgentRow = typeof aiAgents.$inferSelect;
export type AiAgentRunRow = typeof aiAgentRuns.$inferSelect;
