// apps/api/src/db/schema/llmEgressDailyRollups.ts
import { bigint, date, index, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Long-term daily summary of `llm_egress_events` (#4120). Raw per-request rows
 * are kept for LLM_EGRESS_EVENTS_RETENTION_DAYS (default 90); the retention job
 * (`jobs/llmEgressRetention.ts`) folds each expired row into its
 * (org, UTC day, surface, host) row here in the same statement that deletes it.
 *
 * RLS shape 1 (direct `org_id`), composite `(org_id, partner_id)` FK to
 * `organizations` (DEFERRABLE INITIALLY IMMEDIATE) — see
 * `2026-12-26-200000-llm-egress-daily-rollups.sql`.
 */
export const llmEgressDailyRollups = pgTable('llm_egress_daily_rollups', {
  orgId: uuid('org_id').notNull(),
  partnerId: uuid('partner_id').notNull(),
  /** UTC calendar day (`(created_at AT TIME ZONE 'UTC')::date`), as `YYYY-MM-DD`. */
  day: date('day').notNull(),
  surface: text('surface').notNull(),
  host: text('host').notNull(),
  requestCount: bigint('request_count', { mode: 'number' }).notNull().default(0),
  blockedCount: bigint('blocked_count', { mode: 'number' }).notNull().default(0),
  firstEventAt: timestamp('first_event_at', { withTimezone: true }).notNull(),
  lastEventAt: timestamp('last_event_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ name: 'llm_egress_daily_rollups_pkey', columns: [t.orgId, t.day, t.surface, t.host] }),
  index('llm_egress_daily_rollups_partner_idx').on(t.partnerId, t.day),
]);

export type LlmEgressDailyRollup = typeof llmEgressDailyRollups.$inferSelect;
