// apps/api/src/db/schema/aiAlertVerdicts.ts
import { index, jsonb, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
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
 * migrations/2026-09-20-ai-agents-alert-verdicts.sql, which the
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
  supersededBy: uuid('superseded_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('ai_alert_verdicts_org_alert_idx').on(t.orgId, t.alertId),
  index('ai_alert_verdicts_org_group_idx').on(t.orgId, t.correlationGroupId),
  index('ai_alert_verdicts_run_idx').on(t.runId),
]);

export type AiAlertVerdictRow = typeof aiAlertVerdicts.$inferSelect;
export type NewAiAlertVerdictRow = typeof aiAlertVerdicts.$inferInsert;
