import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { organizations } from './orgs';
import { devices } from './devices';

/**
 * Wave 6 PR 4 (#3828) — canonical anomaly incident per
 * (org_id, device_id, anomaly_type, bucket_seconds, window_start), collapsing
 * sibling `metric_anomalies` rows (`metric_name` deliberately excluded from
 * the key — mirrors `metricAnomalyPromotion.ts`'s `findDedupeSiblings`).
 *
 * The row IS the transactional dispatch outbox: `dispatchedAt` /
 * `dispatchAttempts` / `agentRunId`. Task 2's detector upsert refreshes ONLY
 * `lastSeenAt` / `peakScore` / `rowCount` / `metricNames` on conflict —
 * `dispatchedAt` is never in that SET list, which is what makes a bulk
 * re-upsert publish-inert by construction.
 *
 * `agentRunId` deliberately has NO FK constraint at all — not in Drizzle,
 * not in the migration either. This table has `orgId` and sits in the
 * org-cascade graph, so a real mutual FK pair with `ai_agent_runs`
 * (this column -> runs, plus `ai_agent_runs.anomalyIncidentId` -> this
 * table) forms a 2-node cycle that `tenantCascade.ts`'s
 * `topologicalCascadeOrder()` cannot resolve (it throws on ANY FK cycle,
 * regardless of ON DELETE action). Breaking the cycle means exactly one
 * direction gets a real constraint; `ai_agent_runs.anomalyIncidentId` keeps
 * it (same treatment as that table's sibling alertId/deviceId/ticketId
 * columns), and this column stays app-level-only — Task 3 sets it
 * best-effort and never depends on DB-enforced integrity for it. See the
 * migration file's header for the full account, including why this is NOT
 * the same situation as `ticket_comments.agent_run_id`'s Drizzle-only
 * `.references()` omission (that table has no org_id and sits outside this
 * graph entirely, so its real SQL-level FK creates no cycle).
 *
 * `peakScore` is unconstrained `numeric` (no precision/scale): the
 * detector's raw `metric_anomalies.score` is an unbounded magnitude, not the
 * 0-1 `confidence` domain — see `AiAgentTriggers.minAnomalyScore`'s
 * docstring in packages/shared for why the trigger filter validates against
 * this same unbounded domain rather than 0-1.
 */
export const metricAnomalyIncidents = pgTable('metric_anomaly_incidents', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  deviceId: uuid('device_id').notNull().references(() => devices.id, { onDelete: 'cascade' }),
  anomalyType: text('anomaly_type').notNull(),
  bucketSeconds: integer('bucket_seconds').notNull(),
  windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
  peakScore: numeric('peak_score').notNull(),
  rowCount: integer('row_count').notNull().default(1),
  metricNames: text('metric_names').array().notNull().default([]),
  /** NULL until Task 2's publisher claims and publishes the row. Never
   *  touched by the detector's re-upsert (DO UPDATE) — see file header. */
  dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
  dispatchAttempts: integer('dispatch_attempts').notNull().default(0),
  /** Set by Task 3's subscriber on successful admission, best-effort. FK is
   *  SQL-only — see file header. */
  agentRunId: uuid('agent_run_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  keyUniq: uniqueIndex('metric_anomaly_incidents_key_uq').on(
    table.orgId,
    table.deviceId,
    table.anomalyType,
    table.bucketSeconds,
    table.windowStart,
  ),
  // Partial index, matching the migration's `WHERE dispatched_at IS NULL`
  // (2026-09-20-ai-agents-anomaly-pilot.sql) — Task 2's publisher claim
  // query (`dispatched_at IS NULL ... FOR UPDATE SKIP LOCKED`) is exactly
  // what this index is for, and the migration's DDL is the source of truth
  // (never edit it — this declaration exists so `db:check-drift` sees the
  // full index shape, not just the columns). Drizzle's index DSL DOES model
  // partial indexes via `.where(sql\`...\`)` — see the same pattern on
  // `invoices.ts`'s `invoices_due_overdue_idx`, `patches.ts`'s
  // `idx_device_patches_pending`, and `vulnerabilityManagement.ts`'s
  // `device_vuln_ticket_id_idx`.
  undispatchedIdx: index('metric_anomaly_incidents_undispatched_idx')
    .on(table.orgId, table.id)
    .where(sql`${table.dispatchedAt} IS NULL`),
  orgLastSeenIdx: index('metric_anomaly_incidents_org_last_seen_idx')
    .on(table.orgId, table.lastSeenAt.desc()),
  deviceIdx: index('metric_anomaly_incidents_device_id_idx').on(table.deviceId),
  agentRunIdx: index('metric_anomaly_incidents_agent_run_id_idx').on(table.agentRunId),
}));

export type MetricAnomalyIncidentRow = typeof metricAnomalyIncidents.$inferSelect;
