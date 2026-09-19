import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));

import { db } from '../db';
import { registerAnalyticsTools } from './aiToolsAnalytics';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';

const mockDb = db as unknown as { select: ReturnType<typeof vi.fn> };

function handlerFor(name: string): AiTool['handler'] {
  const reg = new Map<string, AiTool>();
  registerAnalyticsTools(reg);
  return reg.get(name)!.handler;
}
function makeAuth(allowedSiteIds?: string[]): AuthContext {
  return {
    user: { id: 'u1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
    token: {} as any, partnerId: null, orgId: 'org-1', scope: 'organization',
    accessibleOrgIds: ['org-1'], orgCondition: () => undefined, canAccessOrg: () => true,
    allowedSiteIds, canAccessSite: (s: string | null | undefined) => (!allowedSiteIds ? true : !!s && allowedSiteIds.includes(s)),
  } as unknown as AuthContext;
}
function isDeviceResolverSelect(cols: unknown): boolean {
  return (
    !!cols && typeof cols === 'object' &&
    'id' in (cols as object) && 'siteId' in (cols as object) &&
    Object.keys(cols as object).length === 2
  );
}

describe('query_analytics capacity_predictions — site narrowing', () => {
  beforeEach(() => vi.clearAllMocks());

  it('site-restricted caller does NOT receive predictions for a device in a forbidden site', async () => {
    let predictionScanRan = false;
    const forbidden = { id: 'p1', deviceId: 'd-siteB', metricType: 'disk', metricName: 'C:' };
    mockDb.select.mockImplementation((cols?: unknown) => {
      if (isDeviceResolverSelect(cols)) {
        return { from: () => ({ where: () => Promise.resolve([{ id: 'd-siteB', siteId: 'site-B' }]) }) };
      }
      predictionScanRan = true;
      return { from: () => ({ where: () => ({ orderBy: () => ({ limit: () => Promise.resolve([forbidden]) }) }) }) };
    });

    const r = await handlerFor('query_analytics')({ action: 'capacity_predictions' }, makeAuth(['site-A']));
    const parsed = JSON.parse(r);
    expect(parsed.error).toBeUndefined();
    expect(parsed.showing).toBe(0);
    expect(parsed.capacityPredictions).toEqual([]);
    expect(predictionScanRan).toBe(false);
  });

  it('unrestricted caller reads predictions normally (no regression)', async () => {
    mockDb.select.mockReturnValue({
      from: () => ({ where: () => ({ orderBy: () => ({ limit: () => Promise.resolve([{ id: 'p1', deviceId: 'd1', metricType: 'disk' }]) }) }) }),
    });
    const r = await handlerFor('query_analytics')({ action: 'capacity_predictions' }, makeAuth(undefined));
    const parsed = JSON.parse(r);
    expect(parsed.showing).toBe(1);
  });

  it('falls back to daily metric rollups when stored predictions are empty', async () => {
    mockDb.select
      .mockReturnValueOnce({
        from: () => ({ where: () => ({ orderBy: () => ({ limit: () => Promise.resolve([]) }) }) }),
      })
      .mockReturnValueOnce({
        from: () => ({
          where: () => ({
            groupBy: () => ({
              orderBy: () => Promise.resolve([
                { timestamp: new Date('2026-06-17T00:00:00.000Z'), value: 10 },
                { timestamp: new Date('2026-06-18T00:00:00.000Z'), value: 20 },
              ]),
            }),
          }),
        }),
      });

    const r = await handlerFor('query_analytics')(
      { action: 'capacity_predictions', metricType: 'disk', limit: 3 },
      makeAuth(undefined),
    );
    const parsed = JSON.parse(r);

    expect(parsed.source).toBe('metric_rollups');
    expect(parsed.showing).toBe(3);
    expect(parsed.capacityPredictions[0]).toMatchObject({
      metricType: 'disk',
      metricName: 'disk_percent',
      currentValue: 20,
      predictedValue: 30,
      predictionDate: '2026-06-19T00:00:00.000Z',
      modelType: 'rollup_linear_projection',
      trainingDataDays: 2,
    });
    expect(mockDb.select).toHaveBeenCalledTimes(2);
  });
});

describe('query_analytics sla_definitions / sla_compliance — site narrowing (audit §1.1)', () => {
  beforeEach(() => vi.clearAllMocks());

  const ORG_WIDE = { id: 'sla-org', name: 'Org SLA', targetType: null, targetIds: null };
  const SITE_IN = { id: 'sla-in', name: 'Site 1 SLA', targetType: 'site', targetIds: ['site-1'] };
  const SITE_OUT = { id: 'sla-out', name: 'Site 2 SLA', targetType: 'site', targetIds: ['site-2'] };
  const DEVICE_OUT = { id: 'sla-dev', name: 'Device SLA', targetType: 'device', targetIds: ['d-out'] };

  function mockDefs(rows: unknown[], orgDevices: Array<{ id: string; siteId: string }> = []) {
    mockDb.select.mockImplementation((cols?: unknown) => {
      if (isDeviceResolverSelect(cols)) {
        return { from: () => ({ where: () => Promise.resolve(orgDevices) }) };
      }
      return { from: () => ({ where: () => ({ orderBy: () => ({ limit: () => Promise.resolve(rows) }) }) }) };
    });
  }

  it('sla_definitions hides site- and device-targeted definitions outside the caller scope', async () => {
    mockDefs([ORG_WIDE, SITE_IN, SITE_OUT, DEVICE_OUT], [{ id: 'd-out', siteId: 'site-2' }]);
    const r = await handlerFor('query_analytics')({ action: 'sla_definitions' }, makeAuth(['site-1'])) as string;
    const parsed = JSON.parse(r);
    expect(parsed.slaDefinitions.map((d: any) => d.id)).toEqual(['sla-org', 'sla-in']);
    expect(parsed.showing).toBe(2);
    // the out-of-scope site/device UUIDs must not leak either
    expect(r).not.toContain('site-2');
    expect(r).not.toContain('d-out');
  });

  it('sla_definitions is unchanged for an unrestricted caller', async () => {
    mockDefs([ORG_WIDE, SITE_IN, SITE_OUT, DEVICE_OUT]);
    const r = await handlerFor('query_analytics')({ action: 'sla_definitions' }, makeAuth(undefined)) as string;
    expect(JSON.parse(r).showing).toBe(4);
    // and pays no device-resolution query
    expect(mockDb.select).toHaveBeenCalledTimes(1);
  });

  it('sla_compliance hides rows whose definition targets another site', async () => {
    const rows = [
      { id: 'c1', slaId: 'sla-in', slaName: 'Site 1 SLA', targetType: 'site', targetIds: ['site-1'], overallCompliant: true },
      { id: 'c2', slaId: 'sla-out', slaName: 'Site 2 SLA', targetType: 'site', targetIds: ['site-2'], overallCompliant: false },
    ];
    mockDb.select.mockImplementation((cols?: unknown) => {
      if (isDeviceResolverSelect(cols)) return { from: () => ({ where: () => Promise.resolve([]) }) };
      return { from: () => ({ innerJoin: () => ({ where: () => ({ orderBy: () => ({ limit: () => Promise.resolve(rows) }) }) }) }) };
    });
    const r = await handlerFor('query_analytics')({ action: 'sla_compliance' }, makeAuth(['site-1'])) as string;
    const parsed = JSON.parse(r);
    expect(parsed.slaCompliance.map((c: any) => c.id)).toEqual(['c1']);
    expect(r).not.toContain('site-2');
    // the target columns are a gating input, not part of the compliance payload
    expect(parsed.slaCompliance[0].targetIds).toBeUndefined();
  });

  it('sla_compliance is unchanged for an unrestricted caller', async () => {
    const rows = [
      { id: 'c1', slaId: 'sla-in', targetType: 'site', targetIds: ['site-1'] },
      { id: 'c2', slaId: 'sla-out', targetType: 'site', targetIds: ['site-2'] },
    ];
    mockDb.select.mockImplementation(() => ({
      from: () => ({ innerJoin: () => ({ where: () => ({ orderBy: () => ({ limit: () => Promise.resolve(rows) }) }) }) }),
    }));
    const r = await handlerFor('query_analytics')({ action: 'sla_compliance' }, makeAuth(undefined)) as string;
    expect(JSON.parse(r).showing).toBe(2);
    expect(mockDb.select).toHaveBeenCalledTimes(1);
  });
});

describe('query_analytics SLA — page completeness and the null-vs-[] collapse (review #6110)', () => {
  beforeEach(() => vi.clearAllMocks());

  /** Same as makeAuth but with NO orgId — the device allowlist cannot be resolved. */
  function orglessSiteAuth(allowedSiteIds: string[]): AuthContext {
    return {
      user: { id: 'u1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
      token: {} as any, partnerId: null, orgId: null, scope: 'organization',
      accessibleOrgIds: [], orgCondition: () => undefined, canAccessOrg: () => true,
      allowedSiteIds, canAccessSite: (s: string | null | undefined) => !!s && allowedSiteIds.includes(s),
    } as unknown as AuthContext;
  }

  it('sla_definitions denies a device-targeted definition when the device set cannot be resolved', async () => {
    // No orgId -> no device resolution is possible. The previous code passed
    // `null`, which the gate read as "unrestricted", and the definition (with
    // its out-of-scope device UUIDs) came straight back.
    mockDb.select.mockImplementation(() => ({
      from: () => ({ where: () => ({ orderBy: () => ({ limit: () => Promise.resolve([
        { id: 'sla-dev', name: 'Device SLA', targetType: 'device', targetIds: ['d-secret'] },
      ]) }) }) }),
    }));
    const r = await handlerFor('query_analytics')({ action: 'sla_definitions' }, orglessSiteAuth(['site-1'])) as string;
    const parsed = JSON.parse(r);
    expect(parsed.slaDefinitions).toEqual([]);
    expect(r).not.toContain('d-secret');
  });

  it('sla_compliance denies a device-targeted row when the device set cannot be resolved', async () => {
    mockDb.select.mockImplementation(() => ({
      from: () => ({ innerJoin: () => ({ where: () => ({ orderBy: () => ({ limit: () => Promise.resolve([
        { id: 'c1', slaId: 'sla-dev', targetType: 'device', targetIds: ['d-secret'], overallCompliant: false },
      ]) }) }) }) }),
    }));
    const r = await handlerFor('query_analytics')({ action: 'sla_compliance' }, orglessSiteAuth(['site-1'])) as string;
    expect(JSON.parse(r).slaCompliance).toEqual([]);
  });

  it('sla_definitions over-scans so a restricted caller still fills a page', async () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({
      id: `sla-${i}`, name: `S${i}`, targetType: 'site', targetIds: [i < 25 ? 'site-2' : 'site-1'],
    }));
    let requestedLimit = 0;
    mockDb.select.mockImplementation((cols?: unknown) => {
      if (isDeviceResolverSelect(cols)) return { from: () => ({ where: () => Promise.resolve([]) }) };
      return { from: () => ({ where: () => ({ orderBy: () => ({ limit: (n: number) => { requestedLimit = n; return Promise.resolve(rows.slice(0, n)); } }) }) }) };
    });
    const r = await handlerFor('query_analytics')({ action: 'sla_definitions', limit: 5 }, makeAuth(['site-1'])) as string;
    const parsed = JSON.parse(r);
    expect(requestedLimit).toBeGreaterThan(5);
    expect(parsed.slaDefinitions.map((d: any) => d.id)).toEqual(['sla-25', 'sla-26', 'sla-27', 'sla-28', 'sla-29']);
    expect(parsed.showing).toBe(5);
  });

  it('sla_definitions annotates an emptied page for a restricted caller', async () => {
    mockDb.select.mockImplementation((cols?: unknown) => {
      if (isDeviceResolverSelect(cols)) return { from: () => ({ where: () => Promise.resolve([]) }) };
      return { from: () => ({ where: () => ({ orderBy: () => ({ limit: () => Promise.resolve([
        { id: 'sla-out', name: 'Other', targetType: 'site', targetIds: ['site-2'] },
      ]) }) }) }) };
    });
    const r = await handlerFor('query_analytics')({ action: 'sla_definitions' }, makeAuth(['site-1'])) as string;
    const parsed = JSON.parse(r);
    expect(parsed.showing).toBe(0);
    expect(parsed.scopeNote).toBeTruthy();
  });

  it('sla_compliance annotates a narrowed page for a restricted caller', async () => {
    mockDb.select.mockImplementation((cols?: unknown) => {
      if (isDeviceResolverSelect(cols)) return { from: () => ({ where: () => Promise.resolve([]) }) };
      return { from: () => ({ innerJoin: () => ({ where: () => ({ orderBy: () => ({ limit: () => Promise.resolve([
        { id: 'c1', slaId: 'sla-in', targetType: 'site', targetIds: ['site-1'] },
        { id: 'c2', slaId: 'sla-out', targetType: 'site', targetIds: ['site-2'] },
      ]) }) }) }) }) };
    });
    const r = await handlerFor('query_analytics')({ action: 'sla_compliance' }, makeAuth(['site-1'])) as string;
    const parsed = JSON.parse(r);
    expect(parsed.showing).toBe(1);
    expect(parsed.scopeNote).toBeTruthy();
  });

  it('neither action over-scans or annotates for an unrestricted caller', async () => {
    let requestedLimit = 0;
    mockDb.select.mockImplementation(() => ({
      from: () => ({ where: () => ({ orderBy: () => ({ limit: (n: number) => { requestedLimit = n; return Promise.resolve([
        { id: 'sla-1', name: 'S', targetType: 'site', targetIds: ['site-2'] },
      ]); } }) }) }),
    }));
    const r = await handlerFor('query_analytics')({ action: 'sla_definitions', limit: 5 }, makeAuth(undefined)) as string;
    const parsed = JSON.parse(r);
    expect(requestedLimit).toBe(5);
    expect(parsed.showing).toBe(1);
    expect(parsed.scopeNote).toBeUndefined();
  });
});
