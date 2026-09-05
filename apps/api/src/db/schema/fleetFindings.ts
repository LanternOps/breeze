import { pgTable, uuid, varchar, text, integer, bigint, jsonb, timestamp, index, uniqueIndex, foreignKey, primaryKey } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations } from './orgs';
import { users } from './users';
import { scriptRunAsEnum } from './scripts';

export type FleetFindingKind = 'metric_anomaly_pattern' | 'log_correlation' | 'reliability_offenders';
export type FleetFindingStatus = 'open' | 'acknowledged' | 'dismissed' | 'resolved';
export type FleetFindingSeverity = 'info' | 'warning' | 'error' | 'critical';
// `cancelled` is RESERVED for a future "cancel this run" affordance — no code
// path writes it today (isTerminalRunStatus accepts it, the UI renders a chip
// for it, nothing produces it). Kept in the union so adding cancellation is a
// behaviour change, not a schema+i18n+chip migration.
export type FleetRunStatus = 'queued' | 'running' | 'partial' | 'succeeded' | 'failed' | 'cancelled';
export type FleetTargetStatus = 'pending' | 'queued' | 'succeeded' | 'failed' | 'skipped';

export const fleetFindings = pgTable('fleet_findings', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  kind: varchar('kind', { length: 40 }).$type<FleetFindingKind>().notNull(),
  semanticKey: text('semantic_key').notNull(),
  algorithmVersion: integer('algorithm_version').notNull().default(1),
  status: varchar('status', { length: 20 }).$type<FleetFindingStatus>().notNull().default('open'),
  severity: varchar('severity', { length: 20 }).$type<FleetFindingSeverity>().notNull().default('warning'),
  title: varchar('title', { length: 300 }).notNull(),
  summary: text('summary'),
  evidence: jsonb('evidence').notNull().default({}),
  deviceCount: integer('device_count').notNull().default(0),
  revision: bigint('revision', { mode: 'number' }).notNull().default(1),
  firstSeenAt: timestamp('first_seen_at').notNull(),
  lastSeenAt: timestamp('last_seen_at').notNull(),
  lastReconciledAt: timestamp('last_reconciled_at'),
  acknowledgedAt: timestamp('acknowledged_at'),
  acknowledgedBy: uuid('acknowledged_by').references(() => users.id, { onDelete: 'set null' }),
  dismissedAt: timestamp('dismissed_at'),
  dismissedBy: uuid('dismissed_by').references(() => users.id, { onDelete: 'set null' }),
  dismissNotes: text('dismiss_notes'),
  resolvedAt: timestamp('resolved_at'),
  resolutionReason: varchar('resolution_reason', { length: 40 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  idOrgUq: uniqueIndex('fleet_findings_id_org_uq').on(t.id, t.orgId),
  liveEpisodeUq: uniqueIndex('fleet_findings_live_episode_uq')
    .on(t.orgId, t.kind, t.semanticKey, t.algorithmVersion)
    .where(sql`resolved_at IS NULL`),
  feedIdx: index('fleet_findings_feed_idx').on(t.orgId, t.status, t.severity, t.lastSeenAt),
}));

export const fleetFindingDevices = pgTable('fleet_finding_devices', {
  findingId: uuid('finding_id').notNull(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  deviceId: uuid('device_id').notNull(),          // live membership — device-move trigger re-tenants it, reconciler prunes
  sourceKind: varchar('source_kind', { length: 40 }).notNull(),
  sourceRowId: uuid('source_row_id'),
  memberEvidence: jsonb('member_evidence').notNull().default({}),
  firstSeenAt: timestamp('first_seen_at').notNull(),
  lastSeenAt: timestamp('last_seen_at').notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.findingId, t.deviceId] }),
  // Single-column FK on finding_id ONLY (no same-org composite FK): the
  // device-move trigger rewrites this table's org_id when a device changes
  // orgs; a composite (finding_id, org_id) FK would break mid-move. The
  // transient org mismatch is pruned by the next reconcile pass.
  findingFk: foreignKey({ columns: [t.findingId], foreignColumns: [fleetFindings.id], name: 'fleet_finding_devices_finding_fk' }),
  orgIdx: index('fleet_finding_devices_org_idx').on(t.orgId),
  deviceIdx: index('fleet_finding_devices_device_idx').on(t.deviceId),
}));

export const fleetRemediationRuns = pgTable('fleet_remediation_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  findingId: uuid('finding_id').notNull(),
  findingRevision: bigint('finding_revision', { mode: 'number' }).notNull(),
  actionKind: varchar('action_kind', { length: 20 }).$type<'script' | 'command'>().notNull(),
  scriptId: uuid('script_id'),
  commandType: varchar('command_type', { length: 60 }),
  parameterSnapshot: jsonb('parameter_snapshot').notNull().default({}),
  // #4888 — the operator-chosen run context for this run. NULL means "use the
  // script's saved default", which is what every run did before this column
  // existed. Only meaningful when `action_kind = 'script'`; a command run has
  // no script row to override.
  runAs: scriptRunAsEnum('run_as'),
  status: varchar('status', { length: 20 }).$type<FleetRunStatus>().notNull().default('queued'),
  targetCount: integer('target_count').notNull().default(0),
  succeededCount: integer('succeeded_count').notNull().default(0),
  failedCount: integer('failed_count').notNull().default(0),
  skippedCount: integer('skipped_count').notNull().default(0),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  startedAt: timestamp('started_at'),
  completedAt: timestamp('completed_at'),
}, (t) => ({
  findingFk: foreignKey({ columns: [t.findingId, t.orgId], foreignColumns: [fleetFindings.id, fleetFindings.orgId], name: 'fleet_remediation_runs_finding_org_fk' }),
  orgStatusIdx: index('fleet_remediation_runs_org_status_idx').on(t.orgId, t.status, t.createdAt),
  findingIdx: index('fleet_remediation_runs_finding_idx').on(t.findingId),
}));

export const fleetRemediationRunTargets = pgTable('fleet_remediation_run_targets', {
  runId: uuid('run_id').notNull().references(() => fleetRemediationRuns.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  targetDeviceUuid: uuid('target_device_uuid').notNull(), // SNAPSHOT — no FK, must not be named device_id (org-rewrite trigger)
  hostnameSnapshot: varchar('hostname_snapshot', { length: 255 }),
  siteIdSnapshot: uuid('site_id_snapshot'),
  status: varchar('status', { length: 20 }).$type<FleetTargetStatus>().notNull().default('pending'),
  deviceCommandId: uuid('device_command_id'),
  resultSummary: text('result_summary'),
  skipReason: varchar('skip_reason', { length: 80 }),
  queuedAt: timestamp('queued_at'),
  completedAt: timestamp('completed_at'),
}, (t) => ({
  pk: primaryKey({ columns: [t.runId, t.targetDeviceUuid] }),
  orgIdx: index('fleet_remediation_run_targets_org_idx').on(t.orgId),
  statusIdx: index('fleet_remediation_run_targets_status_idx').on(t.runId, t.status),
}));
