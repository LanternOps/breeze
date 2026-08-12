// W3: productized ingest — delta-triggered incremental ingest job state.
// NOTE: the SQL in migrations/ is the DDL source of truth (FKs, RLS
// policies, the partial unique index) — see
// migrations/2026-07-25-ingest-jobs.sql. Do not generate migrations from
// this definition with drizzle-kit.
import {
  pgTable, uuid, text, boolean, integer, timestamp, jsonb, pgEnum, index,
} from 'drizzle-orm/pg-core';
import { workspaceSources, workspaceCrawlRuns } from './workspace';

export const workspaceIngestTrigger = pgEnum('workspace_ingest_trigger', [
  'crawl_complete', 'manual', 'reingest',
]);
export const workspaceIngestPhase = pgEnum('workspace_ingest_phase', [
  'ingest', 'enrich', 'crosswalk',
]);
export const workspaceIngestJobStatus = pgEnum('workspace_ingest_job_status', [
  'pending', 'running', 'complete', 'failed',
]);

export type IngestTrigger = 'crawl_complete' | 'manual' | 'reingest';
export type IngestPhase = 'ingest' | 'enrich' | 'crosswalk';
export type IngestJobStatus = 'pending' | 'running' | 'complete' | 'failed';

// One live job per (org, source-partition) — enforced by the partial unique
// index wsp_ingest_jobs_one_active_idx (org_id, COALESCE(source_id,
// zero-uuid)) WHERE status IN ('pending', 'running'); source_id NULL means
// org-wide. Advancement is in-request batch continuation
// (src/services/ingestJobRunner.ts), never a background worker.
export const workspaceIngestJobs = pgTable('workspace_ingest_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull(),
  sourceId: uuid('source_id').references(() => workspaceSources.id, { onDelete: 'cascade' }),
  crawlRunId: uuid('crawl_run_id').references(() => workspaceCrawlRuns.id, { onDelete: 'set null' }),
  trigger: workspaceIngestTrigger('trigger').notNull(),
  phase: workspaceIngestPhase('phase').notNull().default('ingest'),
  status: workspaceIngestJobStatus('status').notNull().default('pending'),
  force: boolean('force').notNull().default(false),
  attempts: integer('attempts').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull().default(8),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
  cursor: text('cursor'),
  stats: jsonb('stats').$type<Record<string, unknown>>().notNull().default({}),
  lastError: text('last_error'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('wsp_ingest_jobs_org_status_idx').on(t.orgId, t.status, t.nextAttemptAt),
]);
