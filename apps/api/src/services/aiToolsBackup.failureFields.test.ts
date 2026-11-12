import { describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn(),
  withDbTransactionIfHeld: vi.fn(),
  db: { select: vi.fn() },
}));

import { withFailureFields } from './aiToolsBackup';
import { RAW_TEXT_FIELDS_BY_TOOL } from './aiToolOutput';

describe('backup AI tools failure fields (#11768)', () => {
  it('returns category, cause and a summary instead of the raw errorLog', () => {
    const out = withFailureFields({
      id: 'j1',
      status: 'failed',
      errorLog: 'file upload failed: storage session: storage answered status 403',
    });
    expect(out).toMatchObject({
      id: 'j1',
      failureCategory: 'storage',
      failureCause: 'storage_access_denied',
      failureSummary: 'file upload failed: storage session: storage answered status 403',
    });
    expect(out).not.toHaveProperty('errorLog');
  });

  it('uses the terminal line, redacts secrets and truncates', () => {
    const out = withFailureFields({
      id: 'j2',
      status: 'failed',
      errorLog: `earlier note\nbackup helper exited unexpectedly password=hunter2 ${'x'.repeat(400)}`,
    });
    expect(out.failureSummary!.length).toBeLessThanOrEqual(200);
    expect(out.failureSummary).not.toContain('hunter2');
    expect(out.failureSummary).not.toContain('earlier note');
    expect(out.failureCause).toBe('helper_stopped');
  });

  it('has nothing to say for a job that did not fail', () => {
    expect(withFailureFields({ id: 'j3', status: 'completed', errorLog: null })).toMatchObject({
      failureCategory: null,
      failureCause: null,
      failureSummary: null,
    });
  });

  it('fences the free-text summary as untrusted data for both tools', () => {
    expect(RAW_TEXT_FIELDS_BY_TOOL.query_backups?.has('failureSummary')).toBe(true);
    expect(RAW_TEXT_FIELDS_BY_TOOL.get_backup_status?.has('failureSummary')).toBe(true);
  });
});
