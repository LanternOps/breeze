// apps/api/src/db/schema/aiUnattendedExposure.ts
import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { aiAgents, aiAgentRuns } from './aiAgents';
import { actionIntents } from './actionIntents';

/**
 * Where an unattended-exposure reservation originated. Mirrors the CHECK
 * constraint in `2026-09-16-ai-agents-policy-decide-foundations.sql` — the
 * two must be edited together.
 */
export const AI_UNATTENDED_EXPOSURE_SOURCES = ['act', 'policy_intent'] as const;
export type AiUnattendedExposureSource = (typeof AI_UNATTENDED_EXPOSURE_SOURCES)[number];

/**
 * Wave 5 Part A (#3827): the org-wide blast-cap ledger shared by the act
 * lane and the policy-decide lane — one row per unattended action a Tier-3
 * agent took (or was authorized to take) without a human in the loop. Part
 * B reads this to enforce a per-org cap on unattended exposure; NOTHING
 * writes it in this PR (the table is created empty and inert — see the
 * migration header).
 *
 * `org_id` is a plain column (RLS shape 1) and the composite
 * `(org_id, partner_id)` FK to `organizations` keeps the two axes
 * consistent, same pattern as `llmEgressEvents`.
 *
 * `agent_id`/`run_id` carry their own single-column FKs (ON DELETE CASCADE)
 * rather than a composite tied to org_id — unlike action_intents'
 * requesting_agent_run_id, there is no cross-tenant attribution risk here
 * to guard against structurally; org_id is asserted directly on this row.
 */
export const aiUnattendedExposure = pgTable('ai_unattended_exposure', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull(),
  partnerId: uuid('partner_id').notNull(),
  agentId: uuid('agent_id').notNull().references(() => aiAgents.id, { onDelete: 'cascade' }),
  runId: uuid('run_id').notNull().references(() => aiAgentRuns.id, { onDelete: 'cascade' }),
  // No FK: device rows are deleted/moved independently of exposure history.
  deviceId: uuid('device_id').notNull(),
  intentId: uuid('intent_id').references(() => actionIntents.id, { onDelete: 'set null' }),
  source: text('source', { enum: AI_UNATTENDED_EXPOSURE_SOURCES }).notNull(),
  reservedAt: timestamp('reserved_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('ai_unattended_exposure_org_reserved_idx').on(t.orgId, t.reservedAt.desc()),
  index('ai_unattended_exposure_agent_reserved_idx').on(t.agentId, t.reservedAt.desc()),
]);

export type AiUnattendedExposure = typeof aiUnattendedExposure.$inferSelect;
export type NewAiUnattendedExposure = typeof aiUnattendedExposure.$inferInsert;
