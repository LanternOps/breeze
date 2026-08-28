// apps/api/src/db/schema/aiAgentFixWatches.ts
import { sql } from 'drizzle-orm';
import {
  bigint,
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
} from 'drizzle-orm/pg-core';
import { aiAgents, aiAgentRuns } from './aiAgents';
import { alerts } from './alerts';
import { devices } from './devices';
import { organizations } from './orgs';
import { users } from './users';

/**
 * Wave 6.2a (#3828) — "did the fix hold".
 *
 * Two lanes, discriminated by `watchKind`:
 *
 *   - `alert_recurrence` — op-agnostic. Did an alert of the SAME identity
 *     (same device, same rule_id, or same config_item_name when rule_id is
 *     null) trigger again between `baselineAt` and the check? A pure DB read,
 *     so it resolves even while the device is offline, and it is the only
 *     lane that says anything at all about `run_script` or `execute_playbook`.
 *   - `postcondition` — op-specific. Re-runs the op's own `verifySpec`
 *     read-back against the pinned target. `service_running` is the ONLY kind
 *     v1 watches; see the plan doc's "Why only one postcondition kind" for
 *     why `process_absent` and `disk_usage_improved` are excluded (the first
 *     because a name re-check is a broader claim than the postcondition, not
 *     a weaker one; the second because its verification never performs a disk
 *     read, so there is no baseline to compare against).
 */
export const AI_AGENT_FIX_WATCH_KINDS = ['alert_recurrence', 'postcondition'] as const;
export type AiAgentFixWatchKind = (typeof AI_AGENT_FIX_WATCH_KINDS)[number];

/**
 * `checking` is a LEASE, not a terminal state: the sweeper claims a due row by
 * moving it here with a `leaseExpiresAt`, performs the bounded device read
 * OUTSIDE any transaction, then finalizes. A worker that dies mid-check leaves
 * the row reclaimable once the lease expires.
 *
 * `inconclusive` is terminal only after `attempts` exhausts the bounded retry
 * budget — an offline device must never be scored as a regression, and must
 * never increment a circuit counter.
 */
export const AI_AGENT_FIX_WATCH_STATUSES = [
  'pending',
  'checking',
  'held',
  'regressed',
  'inconclusive',
  'cancelled',
] as const;
export type AiAgentFixWatchStatus = (typeof AI_AGENT_FIX_WATCH_STATUSES)[number];

/**
 * Bumped whenever the meaning of a stored watch row changes (which fields the
 * checker reads, or how it interprets them). `verifySpecKind` alone is NOT a
 * sufficient contract: the same kind can be re-checked differently by a later
 * version, and a row written by an older API process must not be re-scored
 * under new rules. The sweeper refuses a row whose `contractVersion` it does
 * not understand rather than guessing.
 */
export const AI_AGENT_FIX_WATCH_CONTRACT_VERSION = 1;

export const aiAgentFixWatches = pgTable('ai_agent_fix_watches', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  // ON DELETE CASCADE, unlike ai_agent_runs.device_id's SET NULL: a watch
  // against a deleted device has nothing left to re-check, so it dies with the
  // device rather than lingering as an un-runnable row.
  deviceId: uuid('device_id').notNull().references(() => devices.id, { onDelete: 'cascade' }),
  agentId: uuid('agent_id').notNull().references(() => aiAgents.id, { onDelete: 'cascade' }),
  // Composite, not a bare run_id FK: (run_id, org_id) -> ai_agent_runs(id,
  // org_id) makes it structurally impossible for a watch to name a run from a
  // different tenant. `ai_agent_runs_id_org_id_key` exists for exactly this.
  runId: uuid('run_id').notNull(),
  watchKind: text('watch_kind').$type<AiAgentFixWatchKind>().notNull(),
  contractVersion: integer('contract_version').notNull(),
  /** Manifest op key the watched action came from (e.g. `manage_services.restart`). */
  opKey: text('op_key').notNull(),
  /**
   * Canonical, stable identity of WHAT was remediated — the same fingerprint
   * the circuit ledger is keyed on. Per-target, never per-op: a failed restart
   * of service A must not implicate service B.
   */
  targetFingerprint: text('target_fingerprint').notNull(),
  /** Scalar, so it stays queryable and export-classifiable as `included`. */
  verifySpecKind: text('verify_spec_kind'),
  /** Structured ActTarget. jsonb -> `excludedOpen` in the export policy. */
  target: jsonb('target').$type<Record<string, unknown>>().notNull().default({}),
  // Captured alert IDENTITY, not just the FK: the originating alert row may be
  // resolved, or deleted, long before the watch falls due, and the recurrence
  // question is about the identity, not that particular row.
  alertId: uuid('alert_id').references(() => alerts.id, { onDelete: 'set null' }),
  alertRuleId: uuid('alert_rule_id'),
  alertConfigItemName: varchar('alert_config_item_name', { length: 200 }),
  /** Start of the recurrence window — the moment the remediation finished. */
  baselineAt: timestamp('baseline_at', { withTimezone: true }).notNull(),
  dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
  status: text('status').$type<AiAgentFixWatchStatus>().notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
  checkedAt: timestamp('checked_at', { withTimezone: true }),
  /** Short, human-readable — never a raw tool input/output blob. */
  detail: text('detail'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // The sweeper's due-scan. Partial on the two claimable states so the index
  // stays small as terminal rows accumulate ahead of retention.
  index('ai_agent_fix_watches_due_idx').on(t.status, t.dueAt)
    .where(sql`${t.status} IN ('pending', 'checking')`),
  index('ai_agent_fix_watches_run_idx').on(t.runId),
  index('ai_agent_fix_watches_org_created_idx').on(t.orgId, t.createdAt.desc()),
  // One watch per (run, kind, target) — makes `scheduleFixWatches` idempotent
  // under a retried finishRun.
  unique('ai_agent_fix_watches_run_kind_target_uq')
    .on(t.runId, t.watchKind, t.targetFingerprint),
]);

/**
 * Live breaker state, keyed per TARGET rather than per op.
 *
 * INERT IN WAVE 6.2a: this table is written (counters accumulate as watches
 * regress and as immediate verifications fail) but NO code path reads it to
 * make a decision. Wave 6.2b adds the enforcing gate — in three places, not
 * one, because "downgrade to propose" does not mean "a human must approve":
 * a tier-3 proposal becomes an action intent, which `attemptPolicyDecision`
 * can authorize unattended. See the 6.2a plan doc, decision 11.
 *
 * `epoch` is what keeps a stale watch from resurrecting a manually-reset
 * circuit: a finalizing sweeper writes only if the epoch it read still holds.
 */
export const AI_AGENT_CIRCUIT_STATES = ['closed', 'open'] as const;
export type AiAgentCircuitState = (typeof AI_AGENT_CIRCUIT_STATES)[number];

export const aiAgentCircuits = pgTable('ai_agent_circuits', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  deviceId: uuid('device_id').notNull().references(() => devices.id, { onDelete: 'cascade' }),
  agentId: uuid('agent_id').notNull().references(() => aiAgents.id, { onDelete: 'cascade' }),
  opKey: text('op_key').notNull(),
  targetFingerprint: text('target_fingerprint').notNull(),
  epoch: bigint('epoch', { mode: 'number' }).notNull().default(0),
  state: text('state').$type<AiAgentCircuitState>().notNull().default('closed'),
  failureCount: integer('failure_count').notNull().default(0),
  /** How many times this circuit has opened — the backoff input for 6.2b. */
  consecutiveOpens: integer('consecutive_opens').notNull().default(0),
  windowStartedAt: timestamp('window_started_at', { withTimezone: true }).notNull().defaultNow(),
  lastFailureAt: timestamp('last_failure_at', { withTimezone: true }),
  /** Short, human-readable — never a raw tool input/output blob. */
  lastFailureReason: text('last_failure_reason'),
  openedAt: timestamp('opened_at', { withTimezone: true }),
  openReason: text('open_reason'),
  resetAt: timestamp('reset_at', { withTimezone: true }),
  resetByUserId: uuid('reset_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('ai_agent_circuits_target_uq')
    .on(t.orgId, t.agentId, t.deviceId, t.opKey, t.targetFingerprint),
  index('ai_agent_circuits_org_state_idx').on(t.orgId, t.state),
  index('ai_agent_circuits_device_idx').on(t.deviceId),
]);

export type AiAgentFixWatchRow = typeof aiAgentFixWatches.$inferSelect;
export type NewAiAgentFixWatch = typeof aiAgentFixWatches.$inferInsert;
export type AiAgentCircuitRow = typeof aiAgentCircuits.$inferSelect;
export type NewAiAgentCircuit = typeof aiAgentCircuits.$inferInsert;
