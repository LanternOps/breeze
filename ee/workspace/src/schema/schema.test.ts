import { describe, it, expect } from 'vitest';
import { getTableColumns, getTableName } from 'drizzle-orm';
import {
  workspaceSources, workspaceFileIndex, workspaceFileActivity, workspaceCrawlRuns,
} from './workspace';
import { memoryBlocks } from './memoryBlocks';
import {
  workspaceFileContent, workspaceContentEntities, workspaceFileEnrichment,
  workspaceProjects, workspaceProjectCrosswalk, workspaceEmailFilings,
  workspaceContentChunks,
} from './content';

describe('schema ↔ migration parity (names)', () => {
  it('table names match the migration', () => {
    expect(getTableName(workspaceSources)).toBe('workspace_sources');
    expect(getTableName(workspaceCrawlRuns)).toBe('workspace_crawl_runs');
    expect(getTableName(workspaceFileIndex)).toBe('workspace_file_index');
    expect(getTableName(workspaceFileActivity)).toBe('workspace_file_activity');
    expect(getTableName(memoryBlocks)).toBe('memory_blocks');
  });
  it('memory_blocks has no actor/user column ("track work, not workers")', () => {
    const cols = Object.values(getTableColumns(memoryBlocks)).map((c) => c.name);
    expect(cols).not.toContain('user_id');
    expect(cols).toContain('subject_key');
    expect(cols).toContain('superseded_by_id');
  });
  it('file index carries the browser-view columns', () => {
    const cols = Object.values(getTableColumns(workspaceFileIndex)).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining([
      'is_dir', 'parent_path', 'rel_path', 'deleted_at', 'device_id', 'device_key',
    ]));
  });
  it('sources carry crawler credentials and configuration columns', () => {
    const cols = Object.values(getTableColumns(workspaceSources)).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining([
      'credential_enc', 'exclude_globs', 'watch', 'error_reason', 'last_complete_run_at',
    ]));
    expect(cols).not.toContain('credential_ref');
  });
  it('file activity is helper-compatible (nullable user_id, helper_user label)', () => {
    const columns = getTableColumns(workspaceFileActivity);
    expect(Object.values(columns).map((c) => c.name)).toContain('helper_user');
    expect(columns.helperUser.name).toBe('helper_user');
    expect(columns.helperUser.notNull).toBe(false);
    expect(columns.userId.notNull).toBe(false);
  });
  it('content tables carry the migration names', () => {
    expect(getTableName(workspaceFileContent)).toBe('workspace_file_content');
    expect(getTableName(workspaceContentEntities)).toBe('workspace_content_entities');
    expect(getTableName(workspaceFileEnrichment)).toBe('workspace_file_enrichment');
    expect(getTableName(workspaceProjects)).toBe('workspace_projects');
    expect(getTableName(workspaceProjectCrosswalk)).toBe('workspace_project_crosswalk');
    expect(getTableName(workspaceEmailFilings)).toBe('workspace_email_filings');
  });
  it('file content carries the idempotency snapshot and status', () => {
    const columns = getTableColumns(workspaceFileContent);
    const names = Object.values(columns).map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining([
      'org_id', 'file_index_id', 'content_hash', 'source_size', 'source_mtime',
      'extracted_text', 'status', 'error_reason', 'extracted_at',
    ]));
    expect(columns.status.enumValues).toEqual([
      'extracted', 'failed', 'skipped_too_large', 'skipped_binary', 'blocked_dlp',
    ]);
  });
  it('enrichment stores declared vs inferred (Beat 3 disagreement)', () => {
    const names = Object.values(getTableColumns(workspaceFileEnrichment)).map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining([
      'inferred_project_key', 'inferred_project_label', 'inferred_doc_type', 'doc_date',
      'declared_project_key', 'declared_project_label', 'email_meta', 'confidence',
      'model', 'enriched_at',
    ]));
  });
  it('entities are typed and normalized', () => {
    const names = Object.values(getTableColumns(workspaceContentEntities)).map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining([
      'org_id', 'file_index_id', 'entity_type', 'value_norm',
    ]));
  });
  it('crosswalk rows carry distinct-file evidence, filings carry decisions', () => {
    const xw = Object.values(getTableColumns(workspaceProjectCrosswalk)).map((c) => c.name);
    expect(xw).toEqual(expect.arrayContaining([
      'entity_type', 'value_norm', 'project_key', 'project_label', 'evidence_count',
      'sample_file_ids', 'mined_at',
    ]));
    const filings = getTableColumns(workspaceEmailFilings);
    const names = Object.values(filings).map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining([
      'status', 'suggested_project_key', 'suggested_project_label', 'matched_entity_type',
      'matched_entity_value', 'confidence', 'rationale', 'decided_project_key',
      'decided_label', 'decided_at', 'updated_at',
    ]));
    expect(filings.status.enumValues).toEqual(['suggested', 'confirmed', 'reassigned']);
    expect(filings.confidence.enumValues).toEqual(['high', 'low']);
    // Filing decisions are labeled with the device-local helper label, never identity.
    expect(names).not.toContain('user_id');
  });
  it('content chunks carry 1024-dim embeddings keyed by (file, chunk_index)', () => {
    expect(getTableName(workspaceContentChunks)).toBe('workspace_content_chunks');
    const columns = getTableColumns(workspaceContentChunks);
    const names = Object.values(columns).map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining([
      'org_id', 'file_index_id', 'chunk_index', 'text', 'embedding',
    ]));
  });
  it('projects registry keys are per-org', () => {
    const names = Object.values(getTableColumns(workspaceProjects)).map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(['org_id', 'project_key', 'label', 'aliases']));
  });
  it('crawl runs match the crawler migration columns and status enum', () => {
    const columns = getTableColumns(workspaceCrawlRuns);
    expect(Object.values(columns).map((c) => c.name)).toEqual([
      'id', 'org_id', 'source_id', 'device_id', 'device_key', 'status', 'started_at',
      'last_activity_at', 'completed_at', 'cursor', 'stats', 'error_reason',
    ]);
    expect(columns.status.enumValues).toEqual(['running', 'complete', 'failed', 'abandoned']);
  });
});
