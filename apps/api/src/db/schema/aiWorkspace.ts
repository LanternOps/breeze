import { sql } from 'drizzle-orm';
import { bigint, foreignKey, index, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
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
 *    and hand the handles to workspace_launch_analysis). The composite
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

// ---------------------------------------------------------------------------
// W02 export slot — `aiRunWorkspaces` (spec §6.2) and the enums
// `aiWorkspaceBackend` ('vercel'|'gvisor_pool'|'agentcore'|'fake'),
// `aiWorkspaceStatus` ('creating'|'ready'|'destroying'|'destroyed'|'destroy_failed'),
// `aiWorkspaceRegion` ('eu'|'us') are added BELOW this line by wave W02. Do not
// add them here in W01.
// ---------------------------------------------------------------------------
