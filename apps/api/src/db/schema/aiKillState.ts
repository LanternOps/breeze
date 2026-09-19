// apps/api/src/db/schema/aiKillState.ts
import { bigint, boolean, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Wave 5 Part A (#3827): a system-scoped, single-row (id='global'), epoch'd
 * kill switch for AI agent execution — the DB-backed sibling of the
 * existing env-flag kill switch. Mirrors `abuseSweepState` verbatim
 * (forced RLS, single system-only policy, no tenant column) — see
 * `2026-09-16-ai-agents-policy-decide-foundations.sql`.
 *
 * Seeded not-killed, epoch 0. Nothing in THIS PR flips it: the only write
 * surface is a direct SQL UPDATE by ops (Task 2's `bumpAiKillState` service
 * function exists but is called by nobody yet). The guardrail gate this PR
 * adds is therefore a pure pass-through until Part B (or ops) uses it.
 */
export const aiKillState = pgTable('ai_kill_state', {
  id: text('id').primaryKey().default('global'),
  killed: boolean('killed').notNull().default(false),
  epoch: bigint('epoch', { mode: 'number' }).notNull().default(0),
  reason: text('reason'),
  // No FK: may be flipped via SQL directly by ops.
  updatedBy: uuid('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type AiKillStateRow = typeof aiKillState.$inferSelect;
export type NewAiKillStateRow = typeof aiKillState.$inferInsert;
