// apps/api/src/db/schema/aiAlertVerdicts.ts
import { sql } from 'drizzle-orm';
import { index, jsonb, numeric, pgTable, text, timestamp, uniqueIndex, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';
import type { AiAlertVerdictClassification, AiAlertVerdictPattern } from '@breeze/shared';
import { organizations } from './orgs';
import { users } from './users';
import { alerts, alertCorrelationGroups } from './alerts';
import { actionIntents } from './actionIntents';
import { aiAgentRuns } from './aiAgents';

/**
 * Phase 2 wave P2-1 (alert verdicts). One row per verdict an ai-agent
 * `verdict`-profile run produced for an alert or a correlation group —
 * exactly one of `alert_id` / `correlation_group_id` is set (see the
 * `ai_alert_verdicts_target_chk` CHECK in
 * migrations/2026-09-21-ai-agents-alert-verdicts.sql, which the
 * `classification` / `confidence` / `feedback` CHECKs also live in and must
 * be edited together with the enums below).
 *
 * `org_id` is a plain column (RLS shape 1), same pattern as
 * `aiUnattendedExposure`.
 */
export const aiAlertVerdicts = pgTable('ai_alert_verdicts', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  runId: uuid('run_id').notNull().references(() => aiAgentRuns.id, { onDelete: 'cascade' }),
  alertId: uuid('alert_id').references(() => alerts.id, { onDelete: 'cascade' }),
  correlationGroupId: uuid('correlation_group_id')
    .references(() => alertCorrelationGroups.id, { onDelete: 'cascade' }),
  classification: text('classification').$type<AiAlertVerdictClassification>().notNull(),
  confidence: numeric('confidence', { precision: 3, scale: 2 }).notNull(),
  rationale: text('rationale').notNull(),
  pattern: jsonb('pattern').$type<AiAlertVerdictPattern | null>(),
  suggestedIntentId: uuid('suggested_intent_id').references(() => actionIntents.id, { onDelete: 'set null' }),
  feedback: text('feedback').$type<'up' | 'down' | null>(),
  feedbackBy: uuid('feedback_by').references(() => users.id, { onDelete: 'set null' }),
  feedbackAt: timestamp('feedback_at', { withTimezone: true }),
  // Self-FK: lazy reference (repo pattern — see ticketCategories.parentId,
  // scriptCategories.parentId) since aiAlertVerdicts isn't defined yet at
  // this point in the object literal.
  //
  // migrations/2026-09-22-ai-alert-verdicts-live-unique.sql additionally
  // alters this constraint DEFERRABLE INITIALLY DEFERRED — drizzle-orm's
  // `.references()` builder has no deferrable option (same limitation
  // documented on `deviceMtlsCertificates.ts`'s composite FK), so that detail
  // lives in the migration only; db:check-drift does not compare FK options
  // against the DB. `persistAlertVerdict` (services/aiAgents/alertVerdicts.ts)
  // depends on the deferral to supersede an existing live row by pointing it
  // at a not-yet-inserted id within one transaction — see that file's
  // "Write ordering, part 2" docstring.
  supersededBy: uuid('superseded_by').references((): AnyPgColumn => aiAlertVerdicts.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('ai_alert_verdicts_org_alert_idx').on(t.orgId, t.alertId).where(sql`${t.alertId} IS NOT NULL`),
  index('ai_alert_verdicts_org_group_idx').on(t.orgId, t.correlationGroupId).where(sql`${t.correlationGroupId} IS NOT NULL`),
  index('ai_alert_verdicts_latest_idx').on(t.orgId, t.createdAt.desc()).where(sql`${t.supersededBy} IS NULL`),
  index('ai_alert_verdicts_run_idx').on(t.runId),
  // Carry-in C (P2-1 Task 14) — at most one LIVE (superseded_by IS NULL)
  // verdict per alert / per correlation group. Mirrors
  // migrations/2026-09-22-ai-alert-verdicts-live-unique.sql; see
  // `persistAlertVerdict`'s docstring for the write-ordering this forces.
  uniqueIndex('ai_alert_verdicts_live_alert_uq').on(t.alertId)
    .where(sql`${t.supersededBy} IS NULL AND ${t.alertId} IS NOT NULL`),
  uniqueIndex('ai_alert_verdicts_live_group_uq').on(t.correlationGroupId)
    .where(sql`${t.supersededBy} IS NULL AND ${t.correlationGroupId} IS NOT NULL`),
]);

export type AiAlertVerdictRow = typeof aiAlertVerdicts.$inferSelect;
export type NewAiAlertVerdictRow = typeof aiAlertVerdicts.$inferInsert;
