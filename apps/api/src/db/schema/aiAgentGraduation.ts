// apps/api/src/db/schema/aiAgentGraduation.ts
import { foreignKey, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import type { AiAgentGraduationState } from '@breeze/shared';
import { actionIntents } from './actionIntents';
import { aiAgents } from './aiAgents';
import { organizations } from './orgs';

// P2-5 (#4192) — per-(org, agent, op_key) graduation state.
// Migration: 2026-09-29-ai-agents-graduation-evidence.sql.
//
// Tracks one colon-key's journey through `tracking -> eligible -> promoted
// -> demoted -> tracking`, read from the ai_agent_op_evidence ledger over a
// rolling window. Promotion is never automatic — it always carries a
// `promoted_intent_id` pointing at the Tier-3 four-eyes
// `manage_ai_agents:authorize_supervised_key` intent that granted the key.
// Demotion is automatic and always on; it records which run/watch produced
// the disqualifying evidence.
//
// `AI_AGENT_GRADUATION_STATES` is canonical in `@breeze/shared`
// (`aiAgentGraduation.ts`, Task 1) — this file imports the TYPE only for
// `.$type<>()`, same pattern as `aiAgentOpEvidence.ts`.
//
// Tenancy Shape 1: direct NOT NULL org_id, `breeze_has_org_access(org_id)`.
export const aiAgentGraduation = pgTable(
  'ai_agent_graduation',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id').notNull().references(() => aiAgents.id, { onDelete: 'cascade' }),
    opKey: text('op_key').notNull(),
    state: text('state').notNull().default('tracking').$type<AiAgentGraduationState>(),
    firstVerifiedAt: timestamp('first_verified_at', { withTimezone: true }),
    promotedAt: timestamp('promoted_at', { withTimezone: true }),
    /**
     * The four-eyes `manage_ai_agents:authorize_supervised_key` intent that
     * granted the key. Composite FK (promoted_intent_id, org_id) ->
     * action_intents(id, org_id) declared below, ON DELETE SET NULL
     * (promoted_intent_id). The migration pins the PG15 explicit column
     * list so only promoted_intent_id is nulled — the NOT NULL org_id is
     * left untouched. drizzle-orm's `foreignKey(...).onDelete('set null')`
     * below cannot express that column list; it renders bare
     * `ON DELETE SET NULL`, so this comment is the only place the
     * invariant is pinned in TS.
     */
    promotedIntentId: uuid('promoted_intent_id'),
    demotedAt: timestamp('demoted_at', { withTimezone: true }),
    demoteReason: text('demote_reason'),
    demoteRunId: uuid('demote_run_id'),
    demoteWatchId: uuid('demote_watch_id'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    intentOrgFk: foreignKey({
      columns: [table.promotedIntentId, table.orgId],
      foreignColumns: [actionIntents.id, actionIntents.orgId],
      name: 'ai_agent_graduation_intent_org_fk',
    }).onDelete('set null'),
    keyUq: uniqueIndex('ai_agent_graduation_key_uq').on(table.orgId, table.agentId, table.opKey),
  }),
);

export type AiAgentGraduationRow = typeof aiAgentGraduation.$inferSelect;
export type NewAiAgentGraduationRow = typeof aiAgentGraduation.$inferInsert;
