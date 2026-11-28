import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ rows: [] as unknown[], selects: 0 }));
vi.mock('../../db', () => ({
  db: {
    select: vi.fn(() => {
      state.selects += 1;
      const chain: Record<string, unknown> = {};
      for (const m of ['from', 'where']) chain[m] = vi.fn(() => chain);
      chain.limit = vi.fn(async () => state.rows);
      return chain;
    }),
  },
}));

import { PgDialect } from 'drizzle-orm/pg-core';
import { edrEndpointProtectedSql, edrReportEvidenceAllowed, isEdrVisibilityEnabled } from './edrVisibility';

describe('portal EDR visibility (#8166)', () => {
  beforeEach(() => { state.rows = []; state.selects = 0; });

  it('isEdrVisibilityEnabled fails closed: missing row or anything but true is off', async () => {
    expect(await isEdrVisibilityEnabled('org-1')).toBe(false);
    state.rows = [{ enabled: false }];
    expect(await isEdrVisibilityEnabled('org-1')).toBe(false);
    state.rows = [{ enabled: true }];
    expect(await isEdrVisibilityEnabled('org-1')).toBe(true);
  });

  it('MSP-side report runs (user / system) may always use EDR evidence, without reading the flag', async () => {
    expect(await edrReportEvidenceAllowed('org-1', { principalKind: 'user' })).toBe(true);
    expect(await edrReportEvidenceAllowed('org-1', { principalKind: 'system' })).toBe(true);
    expect(state.selects).toBe(0);
  });

  it('a portal-user report run honours the strict flag', async () => {
    expect(await edrReportEvidenceAllowed('org-1', { principalKind: 'portal_user' })).toBe(false);
    state.rows = [{ enabled: true }];
    expect(await edrReportEvidenceAllowed('org-1', { principalKind: 'portal_user' })).toBe(true);
  });

  // #12825: the portal shares the posture report's rule. A detail-owned provider's healthy + online
  // value counts only when its details were read within the freshness bound of `now`.
  it('protected requires healthy, online and, for a detail-owned provider, a details read within the bound', () => {
    const q = new PgDialect().sqlToQuery(edrEndpointProtectedSql('org-1', new Date('2026-11-27T12:00:00.000Z')));
    expect(q.sql).toMatch(/e\.health = 'healthy'/);
    expect(q.sql).toMatch(/e\.online is true/);
    expect(q.sql).toMatch(/\(e\.provider not in \(\$\d+, \$\d+\) or e\.vendor_detail_synced_at >= \$\d+::timestamptz\)/);
    expect(q.params).toEqual(['org-1', 'bitdefender', 'emsisoft', '2026-11-26T12:00:00.000Z']);
  });
});
