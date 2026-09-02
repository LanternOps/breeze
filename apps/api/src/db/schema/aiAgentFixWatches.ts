// apps/api/src/db/schema/aiAgentFixWatches.ts
import { sql } from 'drizzle-orm';
import { index, pgTable, text, timestamp, unique, uuid, varchar } from 'drizzle-orm/pg-core';
import { aiAgents, aiAgentRuns } from './aiAgents';
import { alerts } from './alerts';

/**
 * Verdict lifecycle for a fix-held watch. Mirrors the CHECK constraint in
 * `2026-09-18-ai-agents-safety-controls.sql` — the two must be edited
 * together.
 */
export const AI_AGENT_FIX_WATCH_STATES = [
  'pending', 'watching', 'recurred', 'held_qualified', 'inconclusive', 'cancelled',
] as const;
export type AiAgentFixWatchState = (typeof AI_AGENT_FIX_WATCH_STATES)[number];

/**
 * Wave 6 PR 2 (#3828): after an act-lane remediation verifies, watch
 * whether the triggering alert recovers (phase 1) and then, if it does,
 * whether it recurs within FIX_HOLD_MINUTES (phase 2). Recurrence pages the
 * operators; absence of recurrence is `held_qualified` — NEVER an
 * unconditional "held", since alert dedupe/cooldown can suppress a
 * would-be recurrence row.
 *
 * `org_id` is a plain column (RLS shape 1) and the composite
 * `(org_id, partner_id)` FK to `organizations` keeps the two axes
 * consistent, same pattern as `llmEgressEvents` / `aiUnattendedExposure`.
 *
 * `device_id` carries no FK (device rows are deleted/moved independently of
 * watch history, same exposure precedent as `aiUnattendedExposure`).
 * `ruleId` is a denormalized plain copy of the triggering alert's rule_id
 * (no FK) — it must survive the alert row being deleted so a later
 * recurrence check can still classify against it.
 */
export const aiAgentFixWatches = pgTable('ai_agent_fix_watches', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull(),
  partnerId: uuid('partner_id').notNull(),
  agentId: uuid('agent_id').notNull().references(() => aiAgents.id, { onDelete: 'cascade' }),
  runId: uuid('run_id').notNull().references(() => aiAgentRuns.id, { onDelete: 'cascade' }),
  alertId: uuid('alert_id').references(() => alerts.id, { onDelete: 'set null' }),
  ruleId: uuid('rule_id'),
  deviceId: uuid('device_id').notNull(),
  configItemName: varchar('config_item_name', { length: 200 }),
  state: text('state').$type<AiAgentFixWatchState>().notNull().default('pending'),
  recoveryObservedAt: timestamp('recovery_observed_at', { withTimezone: true }),
  dueAt: timestamp('due_at', { withTimezone: true }),
  evaluatedAt: timestamp('evaluated_at', { withTimezone: true }),
  recurrenceAlertId: uuid('recurrence_alert_id').references(() => alerts.id, { onDelete: 'set null' }),
  notifiedAt: timestamp('notified_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  unique('ai_agent_fix_watches_run_id_uq').on(t.runId),
  index('ai_agent_fix_watches_org_created_idx').on(t.orgId, t.createdAt.desc()),
  index('ai_agent_fix_watches_state_due_idx').on(t.state, t.dueAt),
  // P2-6 (#4193, migrations/2026-09-30-ai-agents-impact.sql): the rollup's
  // fix_watches_held/fix_watches_recurred scans — neither existing index
  // above covers evaluated_at.
  index('ai_agent_fix_watches_org_evaluated_idx').on(t.orgId, t.evaluatedAt)
    .where(sql`${t.evaluatedAt} IS NOT NULL`),
]);

export type AiAgentFixWatch = typeof aiAgentFixWatches.$inferSelect;
export type NewAiAgentFixWatch = typeof aiAgentFixWatches.$inferInsert;
