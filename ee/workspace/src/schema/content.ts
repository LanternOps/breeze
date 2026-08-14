// Content layer table mirrors. As with workspace.ts, the SQL in
// migrations/ is the DDL source of truth — FKs, RLS policies, FTS/trigram
// indexes, and the vector column (later migration) do not appear here.
// All readers/writers of these tables sit behind the per-org content flag.
// DLP runs at ingest, between extraction and persistence: stored extracted_text
// is post-redaction, and files a 'block' detector trips persist no text
// (status = blocked_dlp).
import {
  pgTable, uuid, text, varchar, bigint, integer, timestamp, jsonb, pgEnum, date,
  index, uniqueIndex, vector,
} from 'drizzle-orm/pg-core';
import { workspaceFileIndex } from './workspace';

// W2: 'blocked_dlp' added by migrations/2026-07-24-org-settings-dlp.sql
// (ALTER TYPE ... ADD VALUE) — content that DLP blocked at ingest time.
export const workspaceContentStatus = pgEnum('workspace_content_status', [
  'extracted', 'failed', 'skipped_too_large', 'skipped_binary', 'blocked_dlp',
]);
export const workspaceFilingStatus = pgEnum('workspace_filing_status', [
  'suggested', 'confirmed', 'reassigned',
]);
export const workspaceFilingConfidence = pgEnum('workspace_filing_confidence', ['high', 'low']);

// "Pending" is the absence of a row (or a stale source_size/source_mtime
// snapshot vs workspace_file_index) — there is no pending enum value.
// W2: dlp_findings (added by migrations/2026-07-24-org-settings-dlp.sql)
// carries the detector hits behind a 'blocked_dlp' status decision.
export const workspaceFileContent = pgTable('workspace_file_content', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull(),
  fileIndexId: uuid('file_index_id').notNull()
    .references(() => workspaceFileIndex.id, { onDelete: 'cascade' }),
  contentHash: text('content_hash'),
  sourceSize: bigint('source_size', { mode: 'number' }),
  sourceMtime: timestamp('source_mtime', { withTimezone: true }),
  extractedText: text('extracted_text'),
  status: workspaceContentStatus('status').notNull(),
  errorReason: text('error_reason'),
  dlpFindings: jsonb('dlp_findings').$type<unknown[]>().notNull().default([]),
  extractedAt: timestamp('extracted_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('wsp_file_content_file_unique').on(t.fileIndexId),
  index('wsp_file_content_org_idx').on(t.orgId),
]);

// value_norm is canonical (uppercased, '#'/whitespace stripped); query-side
// detection must use the same normalizer (src/content/entities.ts).
export const workspaceContentEntities = pgTable('workspace_content_entities', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull(),
  fileIndexId: uuid('file_index_id').notNull()
    .references(() => workspaceFileIndex.id, { onDelete: 'cascade' }),
  entityType: text('entity_type').notNull(),
  valueNorm: text('value_norm').notNull(),
  valueRaw: text('value_raw'),
  origin: text('origin').notNull().default('regex'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('wsp_content_entities_unique').on(t.orgId, t.fileIndexId, t.entityType, t.valueNorm),
  index('wsp_content_entities_lookup_idx').on(t.orgId, t.entityType, t.valueNorm),
]);

// Declared location is stored NEXT TO the inferred metadata so the finder can
// show disagreement, never silently "fix" it. email_meta comes from the
// mailparser extraction step, not the LLM.
export const workspaceFileEnrichment = pgTable('workspace_file_enrichment', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull(),
  fileIndexId: uuid('file_index_id').notNull()
    .references(() => workspaceFileIndex.id, { onDelete: 'cascade' }),
  inferredProjectKey: text('inferred_project_key'),
  inferredProjectLabel: text('inferred_project_label'),
  inferredDocType: text('inferred_doc_type'),
  docDate: date('doc_date'),
  declaredProjectKey: text('declared_project_key'),
  declaredProjectLabel: text('declared_project_label'),
  emailMeta: jsonb('email_meta').$type<{
    from?: string; to?: string[]; cc?: string[]; subject?: string; date?: string;
  } | null>(),
  confidence: varchar('confidence', { length: 16 }),
  model: text('model'),
  enrichedAt: timestamp('enriched_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('wsp_file_enrichment_file_unique').on(t.fileIndexId),
  index('wsp_file_enrichment_org_idx').on(t.orgId),
  index('wsp_file_enrichment_inferred_project_idx').on(t.orgId, t.inferredProjectKey),
]);

export const workspaceProjects = pgTable('workspace_projects', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull(),
  projectKey: text('project_key').notNull(),
  label: text('label').notNull(),
  aliases: jsonb('aliases').$type<string[]>().notNull().default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('wsp_projects_org_key_unique').on(t.orgId, t.projectKey)]);

// evidence_count counts DISTINCT files, never mentions (re-runs must not
// inflate it — the miner recomputes rather than increments).
export const workspaceProjectCrosswalk = pgTable('workspace_project_crosswalk', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull(),
  entityType: text('entity_type').notNull(),
  valueNorm: text('value_norm').notNull(),
  projectKey: text('project_key').notNull(),
  projectLabel: text('project_label'),
  evidenceCount: integer('evidence_count').notNull().default(0),
  sampleFileIds: jsonb('sample_file_ids').$type<string[]>().notNull().default([]),
  minedAt: timestamp('mined_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('wsp_project_crosswalk_unique').on(t.orgId, t.entityType, t.valueNorm, t.projectKey),
  index('wsp_project_crosswalk_org_idx').on(t.orgId),
]);

// Vector chunks (part-2 migration; requires the pgvector image). Embeddings
// are 1024-dim voyage-3 by convention (src/content/embedder.ts).
export const workspaceContentChunks = pgTable('workspace_content_chunks', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull(),
  fileIndexId: uuid('file_index_id').notNull()
    .references(() => workspaceFileIndex.id, { onDelete: 'cascade' }),
  chunkIndex: integer('chunk_index').notNull(),
  text: text('text').notNull(),
  embedding: vector('embedding', { dimensions: 1024 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('wsp_content_chunks_file_chunk_unique').on(t.fileIndexId, t.chunkIndex),
  index('wsp_content_chunks_org_idx').on(t.orgId),
]);

// decided_label mirrors workspace_file_activity.helper_user semantics: a
// device-local display label, never authorization. No user FK by design.
export const workspaceEmailFilings = pgTable('workspace_email_filings', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull(),
  fileIndexId: uuid('file_index_id').notNull()
    .references(() => workspaceFileIndex.id, { onDelete: 'cascade' }),
  status: workspaceFilingStatus('status').notNull().default('suggested'),
  suggestedProjectKey: text('suggested_project_key'),
  suggestedProjectLabel: text('suggested_project_label'),
  matchedEntityType: text('matched_entity_type'),
  matchedEntityValue: text('matched_entity_value'),
  confidence: workspaceFilingConfidence('confidence').notNull().default('low'),
  rationale: text('rationale'),
  decidedProjectKey: text('decided_project_key'),
  decidedLabel: varchar('decided_label', { length: 100 }),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('wsp_email_filings_file_unique').on(t.fileIndexId),
  index('wsp_email_filings_org_status_idx').on(t.orgId, t.status),
]);
