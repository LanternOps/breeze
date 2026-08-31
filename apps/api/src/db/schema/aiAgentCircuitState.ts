// apps/api/src/db/schema/aiAgentCircuitState.ts
import { index, integer, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { aiAgents } from './aiAgents';

/**
 * Mirrors the CHECK constraint in `2026-09-18-ai-agents-safety-controls.sql`
 * — the two must be edited together.
 */
export const AI_AGENT_CIRCUIT_STATES = ['closed', 'open'] as const;
export type AiAgentCircuitStateValue = (typeof AI_AGENT_CIRCUIT_STATES)[number];

/**
 * Wave 6 PR 2 (#3828): per-org circuit breaker. Repeated agent failures in
 * an org auto-open a circuit that skips new admissions until a human
 * resets it with MFA. `centralized in transitionRunStatus` (runService.ts)
 * via agentCircuit.ts's `recordRunTerminal`.
 *
 * PRIMARY KEY is the `(org_id, agent_id)` tuple itself — this is per-org,
 * per-agent STATE, deliberately NEVER `ai_agents.enabled` (a partner-level
 * column the wave-6 quorum ruled out, 2026-08-28).
 *
 * `org_id` is a plain column (RLS shape 1) and the composite
 * `(org_id, partner_id)` FK to `organizations` keeps the two axes
 * consistent, same pattern as `llmEgressEvents` / `aiUnattendedExposure`.
 *
 * `lastRunId` and `resetBy` carry no FK — both are informational pointers
 * (the run that last transitioned the circuit, the admin who last reset
 * it), not live references this row's lifecycle depends on, same
 * reasoning as `aiKillState.updatedBy`.
 */
export const aiAgentCircuitState = pgTable('ai_agent_circuit_state', {
  orgId: uuid('org_id').notNull(),
  agentId: uuid('agent_id').notNull().references(() => aiAgents.id, { onDelete: 'cascade' }),
  partnerId: uuid('partner_id').notNull(),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  state: text('state').$type<AiAgentCircuitStateValue>().notNull().default('closed'),
  openedAt: timestamp('opened_at', { withTimezone: true }),
  openedReason: text('opened_reason'),
  lastRunId: uuid('last_run_id'),
  lastTransitionAt: timestamp('last_transition_at', { withTimezone: true }).defaultNow().notNull(),
  resetBy: uuid('reset_by'),
  resetAt: timestamp('reset_at', { withTimezone: true }),
}, (t) => [
  primaryKey({ columns: [t.orgId, t.agentId] }),
  index('ai_agent_circuit_state_agent_idx').on(t.agentId),
]);

export type AiAgentCircuitStateRow = typeof aiAgentCircuitState.$inferSelect;
export type NewAiAgentCircuitStateRow = typeof aiAgentCircuitState.$inferInsert;
