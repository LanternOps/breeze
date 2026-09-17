import { sql } from 'drizzle-orm';
import {
  bigint,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { AI_ARTIFACT_KINDS, type AiArtifactKind } from '@breeze/shared';
import { aiSessions } from './ai';
import { aiAgentRuns } from './aiAgents';
import { devices } from './devices';
import { organizations } from './orgs';

export type { AiArtifactKind };

/**
 * AI execution plane — artifact store (spec 2026-09-13 §5.2 / §6.1; SQL in
 * migrations/2026-10-16-180400-ai-run-artifacts.sql).
 *
 * `ai_run_artifacts` is Shape 1 (direct NOT NULL org_id, RLS forced). One row
 * per stored blob; `id` IS the handle the model and the UI hold. Rules that
 * must not drift:
 *
 *  - `run_id` is NULLABLE. A chat session can capture an oversized tool result
 *    with no run in flight (spec §5.4: technicians gather live reads in chat
 *    and hand the handles to a workspace analysis run — chat-initiated launch
 *    is currently disabled, #6086, but a preconfigured agent's run still
 *    stages these same handles). The composite
 *    `(run_id, org_id) -> ai_agent_runs(id, org_id)` FK is MATCH SIMPLE, so it
 *    is unchecked while run_id is NULL and binding otherwise. ON DELETE CASCADE
 *    + DEFERRABLE INITIALLY IMMEDIATE (org merge runs SET CONSTRAINTS ALL
 *    DEFERRED; a non-deferrable composite org FK aborts it with 23503).
 *  - The device pointer is `source_device_id`, deliberately NOT `device_id`:
 *    artifacts outlive the device and must not be enrolled in the device
 *    cascade / move-org lists, which key on a `device_id` column
 *    (routes/devices/core.ts, breeze_device_child_orgid_tables()).
 *  - `blob_key` is opaque (`<region>/<yyyy>/<mm>/<uuid>`) and carries no
 *    tenant id. It never leaves the API (toArtifactDto omits it).
 *  - `head_preview` / `tail_preview` hold <= 2048 chars of the RAW bytes
 *    (UTF-8 decoded, NUL-stripped, secret-redacted) — never a compacted view.
 *
 * Export policy: every column `included` (bounded text / ids / counters);
 * there is no jsonb here on purpose — anything open-ended lives in the blob.
 */
export const aiArtifactKind = pgEnum('ai_artifact_kind', AI_ARTIFACT_KINDS);

export const aiRunArtifacts = pgTable(
  'ai_run_artifacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    // Composite FK declared in the table extras below (Drizzle needs both columns).
    runId: uuid('run_id'),
    sessionId: uuid('session_id').references(() => aiSessions.id, { onDelete: 'set null' }),
    kind: aiArtifactKind('kind').notNull(),
    name: text('name').notNull(),
    contentType: text('content_type').notNull(),
    bytes: bigint('bytes', { mode: 'number' }).notNull(),
    sha256: text('sha256').notNull(),
    blobKey: text('blob_key').notNull(),
    headPreview: text('head_preview').notNull().default(''),
    tailPreview: text('tail_preview').notNull().default(''),
    sourceDeviceId: uuid('source_device_id').references(() => devices.id, { onDelete: 'set null' }),
    createdByTool: text('created_by_tool').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true })
      .notNull()
      .default(sql`now() + interval '30 days'`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'ai_run_artifacts_run_org_fk',
      columns: [t.runId, t.orgId],
      foreignColumns: [aiAgentRuns.id, aiAgentRuns.orgId],
    }).onDelete('cascade'),
    index('ai_run_artifacts_org_run_idx').on(t.orgId, t.runId),
    index('ai_run_artifacts_org_expires_idx').on(t.orgId, t.expiresAt),
    index('ai_run_artifacts_org_source_device_idx').on(t.orgId, t.sourceDeviceId),
    // Sweeper scan is cross-org under system scope; the (org_id, expires_at)
    // index cannot serve `WHERE expires_at < now()` on its own.
    index('ai_run_artifacts_expires_idx').on(t.expiresAt),
  ]
);

export type AiRunArtifactRow = typeof aiRunArtifacts.$inferSelect;

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
  /** Deployment-selected reference, not necessarily an immutable/resolved digest. */
  runtimeImage: text('runtime_image'),
  status: text('status').$type<AiWorkspaceStatus>().notNull().default('creating'),

  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  readyAt: timestamp('ready_at', { withTimezone: true }),
  /** Stamped when the reaper claims the row; drives the stalled-claim sweep. */
  destroyingSince: timestamp('destroying_since', { withTimezone: true }),
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
