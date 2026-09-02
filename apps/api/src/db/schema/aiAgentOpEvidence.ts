// apps/api/src/db/schema/aiAgentOpEvidence.ts
import { sql } from 'drizzle-orm';
import { foreignKey, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import type {
  AiAgentEvidenceMetric,
  AiAgentEvidenceNamespace,
  AiAgentEvidenceSourceKind,
} from '@breeze/shared';
import { aiAgentRuns, aiAgents } from './aiAgents';
import { organizations } from './orgs';

// P2-5 (#4192) — graduation evidence ledger.
// Migration: 2026-10-01-100000-ai-agents-graduation-evidence.sql.
//
// One immutable row per terminal outcome an agent produces (a released
// action intent, an act-mode manifest execution, a fix-watch verdict, a
// 👍/👎 on an alert verdict), UNIQUE `(source_kind, source_id, metric)` so
// BullMQ redelivery can never double-count — an ON CONFLICT DO NOTHING
// insert means "already counted". `ai_agent_graduation` reads this ledger
// over a rolling window to move an (org, agent, op_key) tuple through
// tracking -> eligible -> promoted -> demoted -> tracking.
//
// The vocabulary is SIX metrics — `AI_AGENT_EVIDENCE_METRICS` and its two
// sibling namespace/source-kind enums are canonical in `@breeze/shared`
// (`aiAgentGraduation.ts`, Task 1), same pattern as `aiAgents.ts` importing
// `AiAgentKind`/`AiAgentMode` rather than redeclaring them here — this file
// imports the TYPES only for `.$type<>()`; the migration's CHECK
// constraints are the runtime source of truth. They are pinned against the
// shared consts by an explicit assertion in aiAgentOpEvidence.registry.test.ts
// (checkConstraintLiterals() reads the migration's CHECK bodies verbatim and
// compares them to the @breeze/shared arrays) — not by construction.
//
// Tenancy Shape 1: direct NOT NULL org_id, `breeze_has_org_access(org_id)`.
export const aiAgentOpEvidence = pgTable(
  'ai_agent_op_evidence',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id').notNull().references(() => aiAgents.id, { onDelete: 'cascade' }),
    namespace: text('namespace').notNull().$type<AiAgentEvidenceNamespace>(),
    opKey: text('op_key').notNull(),
    /**
     * A historical copy of the triggering rule. Deliberately no FK — the
     * same treatment ai_agent_fix_watches.rule_id gets. An ON DELETE SET
     * NULL here would collapse several rows onto a single NULL key and
     * break the uniqueness this table exists for.
     */
    ruleId: uuid('rule_id'),
    sourceKind: text('source_kind').notNull().$type<AiAgentEvidenceSourceKind>(),
    sourceId: text('source_id').notNull(),
    metric: text('metric').notNull().$type<AiAgentEvidenceMetric>(),
    /**
     * The originating run, if any. Composite FK (run_id, org_id) ->
     * ai_agent_runs(id, org_id) declared below, ON DELETE SET NULL (run_id)
     * — a cross-tenant forged pointer is a 23503 even under a system
     * context, and SET NULL keeps the evidence row when a run is erased.
     * The migration pins the PG15 explicit column list (`SET NULL (run_id)`)
     * so only run_id is nulled — the NOT NULL org_id is left untouched.
     * drizzle-orm's `foreignKey(...).onDelete('set null')` below cannot
     * express that column list; it renders bare `ON DELETE SET NULL`, so
     * this comment is the only place the invariant is pinned in TS.
     */
    runId: uuid('run_id'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    runOrgFk: foreignKey({
      columns: [table.runId, table.orgId],
      foreignColumns: [aiAgentRuns.id, aiAgentRuns.orgId],
      name: 'ai_agent_op_evidence_run_org_fk',
    }).onDelete('set null'),
    // Exactly-once under BullMQ redelivery: a no-op INSERT means
    // "already counted".
    sourceMetricUq: uniqueIndex('ai_agent_op_evidence_source_metric_uq').on(
      table.sourceKind, table.sourceId, table.metric,
    ),
    // A re-vote UPDATEs the single feedback row's metric in place; never a
    // negative delta.
    feedbackUq: uniqueIndex('ai_agent_op_evidence_feedback_uq')
      .on(table.sourceId)
      .where(sql`${table.sourceKind} = 'verdict_feedback'`),
    windowIdx: index('ai_agent_op_evidence_window_idx').on(
      table.orgId, table.agentId, table.namespace, table.opKey, table.occurredAt.desc(),
    ),
    pruneIdx: index('ai_agent_op_evidence_prune_idx').on(table.occurredAt),
  }),
);

export type AiAgentOpEvidenceRow = typeof aiAgentOpEvidence.$inferSelect;
export type NewAiAgentOpEvidenceRow = typeof aiAgentOpEvidence.$inferInsert;
