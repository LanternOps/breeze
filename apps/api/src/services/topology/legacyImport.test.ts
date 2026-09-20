import { describe, expect, it } from 'vitest';
import { drainTopologyOutbox, importLegacyTopologySite } from './legacyImport';
import { emptyLegacyCounts, readLegacyImportCheckpoint } from './legacyImportState';
const scope = { orgId: '00000000-0000-4000-8000-000000000001', siteId: '00000000-0000-4000-8000-000000000002' };

describe('legacy import operator input and durable checkpoint validation', () => {
  it.each([0, -1, 1.5, 1001])('rejects invalid batch size %s before DB access', async batchSize => {
    await expect(importLegacyTopologySite(scope, { batchSize })).rejects.toThrow();
    await expect(drainTopologyOutbox(scope, { batchSize })).rejects.toThrow();
  });
  it('rejects malformed resume/barrier values before DB access', async () => {
    await expect(importLegacyTopologySite(scope, { resumeToken: 'other-site' })).rejects.toThrow();
    await expect(drainTopologyOutbox(scope, { throughRevision: '9223372036854775808' })).rejects.toThrow();
  });
  it('never interprets corrupt saved state as permission to restart', () => {
    expect(readLegacyImportCheckpoint({ unrelated: { keep: true } })).toBeNull();
    expect(() => readLegacyImportCheckpoint({ legacyImport: { version: 2 } })).toThrow();
    const checkpoint = { version: 1, runId: scope.siteId, capturedThrough: '0', snapshotThrough: '2', deliveredThrough: '1', status: 'staged', snapshotRows: 1, counts: emptyLegacyCounts(), mismatches: [] };
    expect(readLegacyImportCheckpoint({ unrelated: { keep: true }, legacyImport: checkpoint })).toEqual(checkpoint);
    expect(() => readLegacyImportCheckpoint({ legacyImport: { ...checkpoint, counts: { ...checkpoint.counts, imported: -1 } } })).toThrow();
  });
});
