import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

let capturedWhere: SQL | undefined;
vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn((w: SQL) => {
          capturedWhere = w;
          return Promise.resolve([]);
        }),
      })),
    })),
  },
}));

import { selectRingScopedApprovalRows, manualDecisionScope } from './patchManualDecisions';

const RING = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PARTNER = '33333333-3333-3333-3333-333333333333';
const dialect = new PgDialect();

describe('selectRingScopedApprovalRows WHERE clause (#9633)', () => {
  beforeEach(() => {
    capturedWhere = undefined;
  });

  it('scopes to the partner, this ring OR partner-wide NULL ring, and the patch ids', async () => {
    await selectRingScopedApprovalRows(PARTNER, RING, ['p1', 'p2']);
    const { sql, params } = dialect.sqlToQuery(capturedWhere!);
    expect(sql).toContain('"patch_approvals"."partner_id" = $1');
    expect(sql).toMatch(/"patch_approvals"\."ring_id" = \$\d+ or "patch_approvals"\."ring_id" is null/);
    expect(sql).toContain('"patch_approvals"."patch_id" in');
    expect(params).toEqual(expect.arrayContaining([PARTNER, RING, 'p1', 'p2']));
  });

  it('omits the patch filter when no ids are given (whole-partner read)', async () => {
    await selectRingScopedApprovalRows(PARTNER, RING);
    const { sql } = dialect.sqlToQuery(capturedWhere!);
    expect(sql).not.toContain('"patch_id" in');
  });
});

describe('manualDecisionScope', () => {
  const t = (d: string) => new Date(d);
  it('attributes to the newest row with the winning status', () => {
    const rows = [
      { patchId: 'p', status: 'approved', ringId: RING, updatedAt: t('2026-02-01') },
      { patchId: 'p', status: 'approved', ringId: null, updatedAt: t('2026-03-01') },
    ];
    expect(manualDecisionScope(rows, RING, 'p', 'approved')).toBe('partner');
  });
  it('ring row wins attribution when it is newer or tied', () => {
    const rows = [
      { patchId: 'p', status: 'rejected', ringId: null, updatedAt: t('2026-02-01') },
      { patchId: 'p', status: 'rejected', ringId: RING, updatedAt: t('2026-02-01') },
    ];
    expect(manualDecisionScope(rows, RING, 'p', 'rejected')).toBe('ring');
  });
});
