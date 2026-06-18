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
