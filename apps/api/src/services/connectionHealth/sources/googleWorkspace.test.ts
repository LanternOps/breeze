import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

vi.mock('../../../db', async () => {
  const { QueryBuilder } = await import('drizzle-orm/pg-core');
  return { db: new QueryBuilder(), runOutsideDbContext: (fn: () => unknown) => fn(), withSystemDbAccessContext: (fn: () => unknown) => fn() };
});
const runGoogleProbesMock = vi.fn(async (..._a: unknown[]) => ({ claimed: 0, ok: 0, failed: 0, unavailable: 0, discarded: 0, recordErrors: 0 }));
vi.mock('../googleProbe', () => ({ runGoogleProbes: (...a: unknown[]) => runGoogleProbesMock(...a) }));

import { googleWorkspaceObservation, googleWorkspaceSource, type GoogleWorkspaceRow } from './googleWorkspace';

const NOW = new Date('2026-10-17T12:00:00Z');
const OLD = new Date('2026-09-01T00:00:00Z');
const ID = '11111111-1111-4111-8111-111111111111';
const P = '22222222-2222-4222-8222-222222222222';
const O = '33333333-3333-4333-8333-333333333333';
const row: GoogleWorkspaceRow = {
  id: ID, orgId: O, partnerId: P, customerDomain: 'example.com', createdAt: OLD,
  lastProbeStatus: 'failed', lastProbeError: 'Google denied the request (403): Not Authorized to access this resource/api',
};

describe('google_workspace source', () => {
  it('registers as a 30-minute kind on the google tab, covering its table', () => {
    expect(googleWorkspaceSource).toMatchObject({
      kind: 'google_workspace', intervalMinutes: 30, tables: ['google_workspace_connections'], fixHrefs: ['/integrations#google'],
    });
  });

  it('a failed probe is a permanent org incident with the probe error as detail', () => {
    expect(googleWorkspaceObservation(row, NOW)).toEqual({
      sourceKind: 'google_workspace', sourceId: ID, partnerId: P, orgId: O, ownerUserId: null,
      state: 'broken', severity: 'permanent', condition: 'verification_failed',
      detail: 'Google denied the request (403): Not Authorized to access this resource/api',
      displayName: 'Google Workspace (example.com)', fixHref: '/integrations#google', ownerFixHref: null,
      viewPermission: { resource: 'organizations', action: 'read' },
      repairPermission: { resource: 'organizations', action: 'write' },
      observedAt: NOW,
    });
  });

  it('ok and never-probed are healthy; unavailable is unknown', () => {
    expect(googleWorkspaceObservation({ ...row, lastProbeStatus: 'ok' }, NOW).state).toBe('healthy');
    expect(googleWorkspaceObservation({ ...row, lastProbeStatus: null }, NOW).state).toBe('healthy');
    expect(googleWorkspaceObservation({ ...row, lastProbeStatus: 'unavailable' }, NOW).state).toBe('unknown');
  });

  it('prepare() runs the probe batch', async () => {
    await googleWorkspaceSource.prepare!(NOW);
    expect(runGoogleProbesMock).toHaveBeenCalledWith(NOW);
  });

  it('the broken query states the partial-index predicate literally', () => {
    const q = new PgDialect().sqlToQuery((googleWorkspaceSource.brokenQuery(NOW) as unknown as { getSQL(): SQL }).getSQL());
    expect(q.sql).toContain(`"last_probe_status" = 'failed'`);
  });
});
