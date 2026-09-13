/**
 * AI execution-plane workspaces (spec §6.2) — one row per sandbox instance.
 *
 * Shape 1 (direct NOT NULL `org_id`). Created by
 * migrations/2026-10-16-180300-ai-run-workspaces-compute.sql, which also
 * carries the RLS enable/force/policies, the composite deferrable FK to
 * `ai_agent_runs(id, org_id)`, and the compute columns added to
 * `ai_agent_runs`, `ai_cost_usage`, `ai_sessions` and `ai_budgets`.
 *
 * `backend`, `status` and `region` are `text` + CHECK, NOT pgEnum: under forced
 * RLS enum equality is not leakproof and would demote the reaper's
 * `status`/`deadline_at` poll to a post-policy filter over the whole table.
 * Same reasoning, same words, as ai_operator_tasks.state — see the header of
 * 2026-10-14-100000-ai-operator-thin-slice.sql.
 *
 * The tuples below are the single source of truth for the vocabulary; the SQL
 * CHECK constraints must list exactly the same members, and
 * aiRunWorkspaces.enums.test.ts asserts they do.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { organizations } from './orgs';

export const aiWorkspaceBackend = ['vercel', 'gvisor_pool', 'agentcore', 'fake'] as const;
export type AiWorkspaceBackend = (typeof aiWorkspaceBackend)[number];

export const aiWorkspaceStatus = [
  'creating',
  'ready',
  'destroying',
  'destroyed',
  'destroy_failed',
] as const;
export type AiWorkspaceStatus = (typeof aiWorkspaceStatus)[number];

export const aiWorkspaceRegion = ['eu', 'us'] as const;
export type AiWorkspaceRegion = (typeof aiWorkspaceRegion)[number];

/** One step of a run's transcript (spec §5.8), stored in `steps` jsonb. */
export interface AiWorkspaceStep {
  ordinal: number;
  language: 'bash' | 'python' | 'node';
  scriptArtifactHandle: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdoutHandle?: string;
}

export const aiRunWorkspaces = pgTable('ai_run_workspaces', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  // Composite FK (run_id, org_id) -> ai_agent_runs(id, org_id), ON DELETE
  // CASCADE, DEFERRABLE INITIALLY IMMEDIATE, is SQL-only: aiAgents.ts would
  // otherwise have to import this module for the reverse edge and the two
  // files would form an import cycle. Same technique as
  // ai_agent_runs.task_id -> ai_operator_tasks.
  runId: uuid('run_id').notNull(),

  backend: text('backend').$type<AiWorkspaceBackend>().notNull(),
  /** Vendor sandbox id. Opaque, carries no tenant identifier. */
  providerRef: text('provider_ref').notNull(),
  region: text('region').$type<AiWorkspaceRegion>().notNull(),
  bootstrapHash: text('bootstrap_hash'),
  status: text('status').$type<AiWorkspaceStatus>().notNull().default('creating'),

  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  readyAt: timestamp('ready_at', { withTimezone: true }),
  destroyedAt: timestamp('destroyed_at', { withTimezone: true }),
  /** Provider-side hard stop. The reaper's key: anything past this + 120s dies. */
  deadlineAt: timestamp('deadline_at', { withTimezone: true }).notNull(),

  cpuMs: bigint('cpu_ms', { mode: 'number' }),
  wallMs: bigint('wall_ms', { mode: 'number' }),
  memAllocatedMb: integer('mem_allocated_mb'),
  computeCents: integer('compute_cents'),

  stagedBytes: bigint('staged_bytes', { mode: 'number' }).notNull().default(0),
  artifactBytes: bigint('artifact_bytes', { mode: 'number' }).notNull().default(0),
  stepCount: integer('step_count').notNull().default(0),

  /** Step transcript (spec §5.8). jsonb => excludedOpen in the export policy. */
  steps: jsonb('steps').$type<AiWorkspaceStep[]>().notNull().default(sql`'[]'::jsonb`),

  destroyAttempts: integer('destroy_attempts').notNull().default(0),
  /** Last destroy failure, for the paged `destroy_failed` row. No secrets. */
  lastError: text('last_error'),
}, (table) => ({
  orgRunIdx: index('ai_run_workspaces_org_run_idx').on(table.orgId, table.runId),
  // Spec §6.2: "a run has at most one live" workspace. Partial so a destroyed
  // row never blocks anything; predicate is a literal constant so the planner
  // can prove it.
  orgRunLiveUq: uniqueIndex('ai_run_workspaces_org_run_live_uq')
    .on(table.orgId, table.runId)
    .where(sql`status <> 'destroyed'`),
  // The reaper's poll. Literal-constant predicate, leakproof text equality.
  reaperIdx: index('ai_run_workspaces_reaper_idx')
    .on(table.deadlineAt)
    .where(sql`status <> 'destroyed'`),
}));

export type AiRunWorkspaceRow = typeof aiRunWorkspaces.$inferSelect;
