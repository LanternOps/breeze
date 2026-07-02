import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({ db: { select: vi.fn() } }));

import { db } from '../db';
import { generateExecutiveSummaryReport } from './reportGenerationService';

/** Thenable that resolves to `rows` and supports any drizzle chain method. */
function selectChain(rows: unknown[]) {
  const p: any = Promise.resolve(rows);
  for (const m of ['from', 'where', 'innerJoin', 'leftJoin', 'orderBy', 'groupBy', 'limit']) {
    p[m] = () => p;
  }
  return p;
}

const ORG = '00000000-0000-0000-0000-000000000001';

/**
 * The generator issues selects in this fixed order (with perms undefined, so
 * resolveSiteAllowedDeviceIds short-circuits without a query):
 *  1 organizations (org name)   2 devices (device stats)
 *  3 alerts (alert stats)       4 devices (os distribution)
 *  5 devices+sites (site breakdown)
 */
function mockGeneratorQueries() {
  const seq: unknown[][] = [
    /* 1 organizations */   [{ id: ORG, name: 'Acme Corp' }],
    /* 2 device stats */    [{ total: 5, online: 3, offline: 2 }],
    /* 3 alert stats */     [{ total: 10, critical: 2, high: 3, resolved: 5 }],
    /* 4 os distribution */ [{ osType: 'windows', count: 5 }],
    /* 5 site breakdown */  [{ siteName: 'HQ', deviceCount: 5 }]
  ];
  const m = vi.mocked(db.select);
  m.mockReset();
  for (const rows of seq) m.mockReturnValueOnce(selectChain(rows));
  m.mockReturnValue(selectChain([]));
}

describe('generateExecutiveSummaryReport', () => {
  beforeEach(() => vi.clearAllMocks());

  it('populates org identity alongside the existing numeric summary', async () => {
    mockGeneratorQueries();

    const result = await generateExecutiveSummaryReport(ORG, {});

    expect(result.summary.org).toEqual({ id: ORG, name: 'Acme Corp' });
    expect(result.summary.devices).toEqual({
      total: 5,
      online: 3,
      offline: 2,
      healthPercentage: 60
    });
    expect(result.summary.alerts).toEqual({
      total: 10,
      critical: 2,
      high: 3,
      resolved: 5,
      resolutionRate: 50
    });
    expect(result.summary.osDistribution).toEqual({ windows: 5 });
    expect(result.summary.siteBreakdown).toEqual([{ site: 'HQ', count: 5 }]);
    expect(typeof result.generatedAt).toBe('string');
  });

  it('falls back to an empty org name when the org row is missing', async () => {
    const m = vi.mocked(db.select);
    m.mockReset();
    m.mockReturnValueOnce(selectChain([])); // organizations: no row found
    m.mockReturnValue(selectChain([]));

    const result = await generateExecutiveSummaryReport(ORG, {});

    expect(result.summary.org).toEqual({ id: ORG, name: '' });
  });
});
