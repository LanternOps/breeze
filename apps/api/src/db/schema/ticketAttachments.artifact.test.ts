import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getTableColumns } from 'drizzle-orm';
import { ticketAttachments } from './ticketAttachments';
import { reportRuns } from './reports';
import { CORE_TENANT_EXPORT_POLICY } from '../../services/tenantExportPolicyRegistry';

const MIGRATION = readFileSync(
  join(__dirname, '..', '..', '..', 'migrations', '2026-10-16-192900-artifact-attachments.sql'),
  'utf8',
);

describe('artifact attachments (execution-plane spec §6.3)', () => {
  it('adds a nullable artifact_id to both tables', () => {
    expect(getTableColumns(ticketAttachments).artifactId).toBeDefined();
    expect(getTableColumns(ticketAttachments).artifactId.notNull).toBe(false);
    expect(getTableColumns(reportRuns).artifactId).toBeDefined();
    expect(getTableColumns(reportRuns).artifactId.notNull).toBe(false);
  });

  it('classifies the new ticket_attachments column in the export policy', () => {
    const policy = CORE_TENANT_EXPORT_POLICY.ticket_attachments;
    expect(policy?.columns.artifact_id).toMatchObject({ decision: 'include' });
  });

  it('does not add a report_runs export-policy entry — that table has no org_id', () => {
    expect(CORE_TENANT_EXPORT_POLICY.report_runs).toBeUndefined();
  });

  it('gives both foreign keys ON DELETE SET NULL, so an expired artifact degrades to a gap', () => {
    expect(MIGRATION).toMatch(
      /ticket_attachments[\s\S]*REFERENCES ai_run_artifacts\(id\) ON DELETE SET NULL/,
    );
    expect(MIGRATION).toMatch(
      /report_runs[\s\S]*REFERENCES ai_run_artifacts\(id\) ON DELETE SET NULL/,
    );
  });

  it('keeps the artifact CHECK arm tolerant of a null artifact_id', () => {
    // The ON DELETE SET NULL above and a `artifact_id IS NOT NULL` arm are
    // contradictory: the retention sweeper's DELETE FROM ai_run_artifacts would
    // fail with 23514 and wedge, silently. The row stays with a null pointer
    // and the content route answers 410.
    expect(MIGRATION).not.toMatch(/storage_backend = 'artifact'[^)]*artifact_id IS NOT NULL/);
  });

  it('is idempotent and opens no transaction of its own', () => {
    expect(MIGRATION).toContain('ADD COLUMN IF NOT EXISTS');
    expect(MIGRATION).toContain('DROP CONSTRAINT IF EXISTS');
    expect(MIGRATION).not.toMatch(/^\s*BEGIN;/m);
    expect(MIGRATION).not.toMatch(/^\s*COMMIT;/m);
  });

  it('writes no rows, so it needs no breeze.scope elevation', () => {
    expect(MIGRATION).not.toMatch(/\b(UPDATE|DELETE FROM|INSERT INTO|MERGE)\b/);
  });
});
