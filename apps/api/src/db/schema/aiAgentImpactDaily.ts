// apps/api/src/db/schema/aiAgentImpactDaily.ts
import { sql } from 'drizzle-orm';
import { check, date, index, integer, pgTable, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './orgs';

/**
 * Phase 2 wave P2-6 (#4193): per-org, per-UTC-day rollup of AI-agent outcome
 * counters, rebuilt idempotently by `aiAgentImpactRollup` from
 * `ai_agent_runs` / `ai_alert_verdicts` / `action_intents` /
 * `ai_agent_fix_watches` / `ticket_drafts`.
 *
 * `est_seconds_saved` is deliberately NOT a column here — it is computed at
 * read time from these counters and the partner's effective
 * `ImpactWeights` (see `@breeze/shared` `resolveImpactWeights` /
 * `estimateSecondsSaved`), so re-pricing a weight re-prices history instead
 * of forking it.
 *
 * Every bucket boundary is UTC calendar-day: `day` is populated from
 * `(<source timestamp> AT TIME ZONE 'UTC')::date`, never `date_trunc`,
 * which follows the session timezone a self-hoster can change.
 */
export const aiAgentImpactDaily = pgTable('ai_agent_impact_daily', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  day: date('day').notNull(),
  alertsJudged: integer('alerts_judged').notNull().default(0),
  noiseFlagged: integer('noise_flagged').notNull().default(0),
  suppressionsApplied: integer('suppressions_applied').notNull().default(0),
  ticketsTriaged: integer('tickets_triaged').notNull().default(0),
  draftsSent: integer('drafts_sent').notNull().default(0),
  fixesProposed: integer('fixes_proposed').notNull().default(0),
  fixesExecuted: integer('fixes_executed').notNull().default(0),
  fixWatchesHeld: integer('fix_watches_held').notNull().default(0),
  fixWatchesRecurred: integer('fix_watches_recurred').notNull().default(0),
  narrativesDelivered: integer('narratives_delivered').notNull().default(0),
  llmCents: integer('llm_cents').notNull().default(0),
  rebuiltAt: timestamp('rebuilt_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // ON CONFLICT (org_id, day) target for the rollup's single UPSERT.
  unique('ai_agent_impact_daily_org_day_uq').on(t.orgId, t.day),
  // Partner-window scan: a 90-day partner read filters on `day` FIRST and
  // then intersects with the caller's accessible org list. Leading with
  // org_id (the unique above) makes that an N-org index scan; leading with
  // day makes it one range. Both are kept.
  index('ai_agent_impact_daily_day_org_idx').on(t.day, t.orgId),
  check('ai_agent_impact_daily_alerts_judged_chk', sql`${t.alertsJudged} >= 0`),
  check('ai_agent_impact_daily_noise_flagged_chk', sql`${t.noiseFlagged} >= 0`),
  check('ai_agent_impact_daily_suppressions_chk', sql`${t.suppressionsApplied} >= 0`),
  check('ai_agent_impact_daily_tickets_triaged_chk', sql`${t.ticketsTriaged} >= 0`),
  check('ai_agent_impact_daily_drafts_sent_chk', sql`${t.draftsSent} >= 0`),
  check('ai_agent_impact_daily_fixes_proposed_chk', sql`${t.fixesProposed} >= 0`),
  check('ai_agent_impact_daily_fixes_executed_chk', sql`${t.fixesExecuted} >= 0`),
  check('ai_agent_impact_daily_watches_held_chk', sql`${t.fixWatchesHeld} >= 0`),
  check('ai_agent_impact_daily_watches_recurred_chk', sql`${t.fixWatchesRecurred} >= 0`),
  check('ai_agent_impact_daily_narratives_chk', sql`${t.narrativesDelivered} >= 0`),
  check('ai_agent_impact_daily_llm_cents_chk', sql`${t.llmCents} >= 0`),
]);

export type AiAgentImpactDailyRow = typeof aiAgentImpactDaily.$inferSelect;
export type NewAiAgentImpactDailyRow = typeof aiAgentImpactDaily.$inferInsert;
