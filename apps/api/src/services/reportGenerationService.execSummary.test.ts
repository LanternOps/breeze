import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({ db: { select: vi.fn() } }));

import { db } from '../db';
import { generateExecutiveSummaryReport } from './reportGenerationService';
import type { OrgReportExecutionAuthority } from './siteScope';
import type { ExecutiveSummary } from '@breeze/shared';

/** Thenable that resolves to `rows` and supports any drizzle chain method. */
function selectChain(rows: unknown[]) {
  const p: any = Promise.resolve(rows);
  for (const m of ['from', 'where', 'innerJoin', 'leftJoin', 'orderBy', 'groupBy', 'limit']) {
    p[m] = () => p;
  }
  return p;
}

const ORG = '00000000-0000-0000-0000-000000000001';
const AUTHORITY: OrgReportExecutionAuthority = {
  principalKind: 'user',
  scope: { version: 1, kind: 'unrestricted', orgId: ORG },
  principalUserId: '11111111-1111-4111-8111-111111111111',
  capturedAt: new Date('2026-07-25T12:00:00.000Z'),
  fingerprint: 'f'.repeat(64),
};

/**
 * The generator issues selects in this fixed order (with perms undefined, so
 * resolveSiteAllowedDeviceIds short-circuits without a query):
 *  1 organizations (org name)   2 devices (counts per status)
 *  3 alerts (alert stats)       4 alerts+devices (notable alerts)
 *  5 devices (os distribution)  6 devices+sites (site breakdown)
 */
function mockGeneratorQueries(
  deviceStatusRows: unknown[] = [
    { status: 'online', count: 3, seen: 3 },
    { status: 'offline', count: 2, seen: 1 },
  ],
  notableAlertRows: unknown[] = [],
) {
  const seq: unknown[][] = [
    /* 1 organizations */   [{ id: ORG, name: 'Acme Corp' }],
    /* 2 device statuses */ deviceStatusRows,
    /* 3 alert stats */     [{ total: 10, critical: 2, high: 3, resolved: 5 }],
    /* 4 notable alerts */  notableAlertRows,
    /* 5 os distribution */ [{ osType: 'windows', count: 5 }],
    /* 6 site breakdown */  [{ siteName: 'HQ', deviceCount: 5 }]
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

    const result = await generateExecutiveSummaryReport(ORG, {}, AUTHORITY);
    expect(result.summary).toBeDefined();
    const summary = result.summary!;

    expect(summary.org).toEqual({ id: ORG, name: 'Acme Corp' });
    expect(summary.devices).toEqual({
      total: 5,
      online: 3,
      offline: 2,
      otherStatuses: {},
      healthPercentage: 60,
      recentWindowDays: 7,
      recentlySeen: 4,
      recentlySeenPercentage: 80,
    });
    expect(summary.alerts).toEqual({
      total: 10,
      critical: 2,
      high: 3,
      resolved: 5,
      resolutionRate: 50
    });
    expect(summary.osDistribution).toEqual({ windows: 5 });
    expect(summary.siteBreakdown).toEqual([{ site: 'HQ', count: 5 }]);
    expect(typeof result.generatedAt).toBe('string');
  });

  it('falls back to an empty org name when the org row is missing', async () => {
    const m = vi.mocked(db.select);
    m.mockReset();
    m.mockReturnValueOnce(selectChain([])); // organizations: no row found
    m.mockReturnValue(selectChain([]));

    const result = await generateExecutiveSummaryReport(ORG, {}, AUTHORITY);
    expect(result.summary).toBeDefined();

    expect(result.summary!.org).toEqual({ id: ORG, name: '' });
  });

  // #12045: a 12-device org rendered "4 online, 4 offline" with four devices
  // in neither bucket, and a headline score of 4/12 online at that instant.
  it('accounts for every managed device and scores the 7-day window, not the instant (#12045)', async () => {
    mockGeneratorQueries([
      { status: 'online', count: 4, seen: 4 },
      { status: 'offline', count: 4, seen: 3 },
      { status: 'maintenance', count: 2, seen: 2 },
      { status: 'pending', count: 2, seen: 0 },
    ]);

    const result = await generateExecutiveSummaryReport(ORG, {}, AUTHORITY);
    const d = (result.summary as ExecutiveSummary).devices!;

    expect(d.total).toBe(12);
    expect(d.online! + d.offline! + Object.values(d.otherStatuses!).reduce((a, b) => a + b, 0)).toBe(d.total);
    expect(d.otherStatuses).toEqual({ maintenance: 2, pending: 2 });
    // The point-in-time share stays for legacy readers...
    expect(d.healthPercentage).toBe(33);
    // ...but the headline is the share seen in the last 7 days.
    expect(d.recentWindowDays).toBe(7);
    expect(d.recentlySeen).toBe(9);
    expect(d.recentlySeenPercentage).toBe(75);
  });

  it('records the alert window it applied (#12045)', async () => {
    mockGeneratorQueries();
    const explicit = await generateExecutiveSummaryReport(
      ORG,
      { dateRange: { start: '2026-10-10T00:00:00.000Z', end: '2026-11-09T00:00:00.000Z' } },
      AUTHORITY,
    );
    expect(explicit.summary!.period).toEqual({ start: '2026-10-10T00:00:00.000Z', end: '2026-11-09T00:00:00.000Z' });

    mockGeneratorQueries();
    const open = await generateExecutiveSummaryReport(ORG, {}, AUTHORITY);
    expect(open.summary!.period).toEqual({ start: null, end: null });
  });

  it('names the critical/high alerts it counts (#12045)', async () => {
    mockGeneratorQueries(undefined, [
      { title: 'Disk C: below 5% free', severity: 'critical', status: 'active', device: 'PC-1', triggeredAt: new Date('2026-11-08T10:00:00.000Z') },
      { title: 'Service stopped', severity: 'high', status: 'resolved', device: null, triggeredAt: new Date('2026-11-07T10:00:00.000Z') },
    ]);
    const result = await generateExecutiveSummaryReport(ORG, {}, AUTHORITY);
    expect(result.summary!.notableAlerts).toEqual([
      { title: 'Disk C: below 5% free', severity: 'critical', status: 'active', device: 'PC-1', triggeredAt: '2026-11-08T10:00:00.000Z' },
      { title: 'Service stopped', severity: 'high', status: 'resolved', device: null, triggeredAt: '2026-11-07T10:00:00.000Z' },
    ]);
  });

  it('caps a filled notable-alert title at a fixed length (#12135)', async () => {
    const longName = 'H'.repeat(5000);
    mockGeneratorQueries(undefined, [
      { title: '{{device}} is down', context: { device: longName }, severity: 'critical', status: 'active', device: longName, triggeredAt: new Date('2026-11-08T10:00:00.000Z') },
      { title: 'Short title', severity: 'high', status: 'active', device: 'PC-1', triggeredAt: new Date('2026-11-08T10:00:00.000Z') },
    ]);
    const result = await generateExecutiveSummaryReport(ORG, {}, AUTHORITY);
    const [long, short] = result.summary!.notableAlerts;
    expect(long.title.length).toBeLessThanOrEqual(200);
    expect(long.title.endsWith('…')).toBe(true);
    expect(short.title).toBe('Short title');
  });
});
