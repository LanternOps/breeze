import { describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  db: {
    insert: () => ({ values: () => ({ returning: async () => [{ id: 'e1' }] }) }),
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
    update: () => ({ set: () => ({ where: async () => ({ rowCount: 1 }) }) }),
  },
  withSystemDbAccessContext: <T,>(fn: () => Promise<T>) => fn(),
  runOutsideDbContext: <T,>(fn: () => T) => fn(),
}));

import { __testOnly } from './scriptDispatch';

const device = { id: 'd1', orgId: 'org-1' } as never;

describe('script_executions insert', () => {
  it('writes source_kind=proposal with the snapshot and the provenance, and no script_id', () => {
    const values = __testOnly.buildExecutionValues({
      device,
      source: {
        kind: 'proposal',
        proposal: { id: 'p1', language: 'powershell', timeoutSeconds: 300, runAs: 'system', contentDigest: 'a'.repeat(64) },
        snapshot: { proposalId: 'p1', contentDigest: 'a'.repeat(64), language: 'powershell', runAs: 'system', timeoutSeconds: 300, deviceIds: ['d1'], scannerVersion: '2026-09-11.1' },
      },
      runAs: 'system',
      parameters: { a: 1 },
      provenance: { reviewId: 'r1', approvedBy: 'u1', approvalMethod: 'supervised_self', reviewRiskTier: 'medium', reviewSummary: 'restarts the spooler' },
    } as never);

    expect(values.sourceKind).toBe('proposal');
    expect(values.scriptId).toBeNull();
    expect(values.proposalId).toBe('p1');
    expect(values.parameters).toBeNull();
    expect(values.language).toBe('powershell');
    expect(values.timeoutSeconds).toBe(300);
    expect(values.contentDigest).toBe('a'.repeat(64));
    expect(values.reviewId).toBe('r1');
    expect(values.approvalMethod).toBe('supervised_self');
    expect(values.reviewSummary).toBe('restarts the spooler');
  });

  it('writes the SAME snapshot columns for a library run so readers never need the join', () => {
    const values = __testOnly.buildExecutionValues({
      device,
      source: { kind: 'saved', script: { id: 's1', version: 4, language: 'bash', timeoutSeconds: 120, content: 'echo hi' } },
      runAs: 'system',
    } as never);

    expect(values.sourceKind).toBe('library');
    expect(values.scriptId).toBe('s1');
    expect(values.proposalId).toBeNull();
    expect(values.language).toBe('bash');
    expect(values.timeoutSeconds).toBe(120);
    expect(values.contentDigest).toMatch(/^[0-9a-f]{64}$/);
    // The head version is resolved by subquery on the row's own version.
    expect(values.scriptVersionId).toBeDefined();
    expect(values.scriptVersionId).not.toBeNull();
  });

  it('prefers an explicit provenance.scriptVersionId over the head subquery', () => {
    const values = __testOnly.buildExecutionValues({
      device,
      source: { kind: 'saved', script: { id: 's1', version: 4, language: 'bash', timeoutSeconds: 120, content: 'echo hi' } },
      runAs: 'system',
      provenance: { scriptVersionId: 'v9' },
    } as never);
    expect(values.scriptVersionId).toBe('v9');
  });

  it('always takes the DEVICE org, never the proposal org', () => {
    const values = __testOnly.buildExecutionValues({
      device: { id: 'd1', orgId: 'device-org' },
      source: { kind: 'proposal', proposal: { id: 'p1', orgId: 'other-org', language: 'bash', timeoutSeconds: 60, runAs: 'system', contentDigest: 'b'.repeat(64) }, snapshot: { deviceIds: ['d1'] } },
      runAs: 'system',
    } as never);
    expect(values.orgId).toBe('device-org');
  });
});
