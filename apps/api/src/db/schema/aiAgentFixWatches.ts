// apps/api/src/db/schema/aiAgentFixWatches.ts
import { sql } from 'drizzle-orm';
import { foreignKey, index, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { actionIntents } from './actionIntents';
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
 * P2-5 (#4192): a fix watch is either run-anchored (`act_run`, the
 * original Wave 6 shape — one run's manifest execution) or intent-anchored
 * (`intent` — one independently-released action intent from that run).
 * Mirrors `ai_agent_fix_watches_source_kind_chk` in
 * `2026-09-29-ai-agents-graduation-evidence.sql` — the two must be edited
 * together, same convention as AI_AGENT_FIX_WATCH_STATES above.
 */
export const AI_AGENT_FIX_WATCH_SOURCE_KINDS = ['act_run', 'intent'] as const;
export type AiAgentFixWatchSourceKind = (typeof AI_AGENT_FIX_WATCH_SOURCE_KINDS)[number];

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
 *
 * P2-5 (#4192): `intentId` + `sourceKind` + `opKeys` make a watch also
 * intent-anchored — N independently-released intents from one run each get
 * their own verification episode instead of sharing one run-unique watch
 * (closes #4206). `intentId` composite FK (intent_id, org_id) ->
 * action_intents(id, org_id) ON DELETE CASCADE — an intent-anchored watch's
 * whole purpose dies with its intent. The shipped `run_id` UNIQUE
 * (`ai_agent_fix_watches_run_id_uq`) becomes partial (`WHERE source_kind =
 * 'act_run'`) since an act run may now also spawn N intent watches; the
 * cross-column shape rule `(source_kind = 'intent') = (intent_id IS NOT
 * NULL)` (`ai_agent_fix_watches_intent_shape_chk`) lives in the migration
 * only, same convention as ticketDrafts.ts's DEFERRABLE note — drizzle-orm's
 * builders don't model cross-column CHECKs cleanly here either.
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
  intentId: uuid('intent_id'),
  sourceKind: text('source_kind').$type<AiAgentFixWatchSourceKind>().notNull().default('act_run'),
  opKeys: text('op_keys').array().notNull().default(sql`'{}'::text[]`),
}, (t) => [
  foreignKey({
    columns: [t.intentId, t.orgId],
    foreignColumns: [actionIntents.id, actionIntents.orgId],
    name: 'ai_agent_fix_watches_intent_org_fk',
  }).onDelete('cascade'),
  uniqueIndex('ai_agent_fix_watches_run_id_uq').on(t.runId).where(sql`${t.sourceKind} = 'act_run'`),
  uniqueIndex('ai_agent_fix_watches_intent_uq').on(t.intentId).where(sql`${t.intentId} IS NOT NULL`),
  index('ai_agent_fix_watches_org_created_idx').on(t.orgId, t.createdAt.desc()),
  index('ai_agent_fix_watches_state_due_idx').on(t.state, t.dueAt),
  index('ai_agent_fix_watches_pending_recovery_idx').on(t.createdAt).where(sql`${t.state} = 'pending'`),
]);

export type AiAgentFixWatch = typeof aiAgentFixWatches.$inferSelect;
export type NewAiAgentFixWatch = typeof aiAgentFixWatches.$inferInsert;
