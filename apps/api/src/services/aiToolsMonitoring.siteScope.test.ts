import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));

import { db } from '../db';
import { registerMonitoringTools } from './aiToolsMonitoring';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';

const mockDb = db as unknown as { select: ReturnType<typeof vi.fn> };

function handlerFor(name: string): AiTool['handler'] {
  const reg = new Map<string, AiTool>();
  registerMonitoringTools(reg);
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
/** Generic chainable query mock that resolves to `result`. */
function chain(result: unknown): any {
  const p: any = Promise.resolve(result);
  for (const m of ['from', 'innerJoin', 'leftJoin', 'where', 'orderBy', 'limit', 'groupBy', 'offset']) {
    p[m] = () => p;
  }
  return p;
}

describe('query_monitors — site narrowing via the linked discovered asset', () => {
  beforeEach(() => vi.clearAllMocks());

  it('site-restricted caller queries monitors through the asset-site join (site filter applied)', async () => {
    let leftJoinCalled = false;
    mockDb.select.mockImplementation(() => ({
      from: () => ({
        leftJoin: () => {
          leftJoinCalled = true;
          return { where: () => ({ orderBy: () => ({ limit: () => Promise.resolve([]) }) }) };
        },
        where: () => ({ orderBy: () => ({ limit: () => Promise.resolve([{ id: 'm1', name: 'forbidden-monitor' }]) }) }),
      }),
    }));

    const r = await handlerFor('query_monitors')({}, makeAuth(['site-A']));
    const parsed = JSON.parse(r);
    expect(parsed.error).toBeUndefined();
    // The restricted path MUST route through the discoveredAssets join (which
    // carries the inArray(siteId) condition) — never the unjoined org-wide scan.
    expect(leftJoinCalled).toBe(true);
    expect(parsed.monitors).toEqual([]);
    expect(JSON.stringify(parsed)).not.toContain('forbidden-monitor');
  });

  it('site-restricted caller with an empty site allowlist gets empty results without scanning', async () => {
    const r = await handlerFor('query_monitors')({}, makeAuth([]));
    const parsed = JSON.parse(r);
    expect(parsed.error).toBeUndefined();
    expect(parsed.monitors).toEqual([]);
    expect(parsed.showing).toBe(0);
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it('unrestricted caller takes the exact pre-existing unjoined query (no regression)', async () => {
    let leftJoinCalled = false;
    mockDb.select.mockImplementation(() => ({
      from: () => ({
        leftJoin: () => {
          leftJoinCalled = true;
          return { where: () => ({ orderBy: () => ({ limit: () => Promise.resolve([]) }) }) };
        },
        where: () => ({ orderBy: () => ({ limit: () => Promise.resolve([{ id: 'm1', name: 'Mon' }]) }) }),
      }),
    }));

    const r = await handlerFor('query_monitors')({}, makeAuth(undefined));
    const parsed = JSON.parse(r);
    expect(parsed.error).toBeUndefined();
    expect(leftJoinCalled).toBe(false);
    expect(parsed.showing).toBe(1);
  });
});

describe('get_service_monitoring_status results — site narrowing (cross-site enumeration)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('site-restricted caller does NOT receive check results for a device in a forbidden site', async () => {
    let resultScanRan = false;
    mockDb.select.mockImplementation((cols?: unknown) => {
      if (isDeviceResolverSelect(cols)) {
        return { from: () => ({ where: () => Promise.resolve([{ id: 'd-siteB', siteId: 'site-B' }]) }) };
      }
      resultScanRan = true;
      return chain([{
        id: 'r1', deviceId: 'd-siteB', watchType: 'service', name: 'secret-svc', status: 'running',
        cpuPercent: null, memoryMb: null, pid: null, details: null,
        autoRestartAttempted: false, autoRestartSucceeded: null, timestamp: new Date('2026-01-01T00:00:00Z'),
      }]);
    });

    const r = await handlerFor('get_service_monitoring_status')({ action: 'results' }, makeAuth(['site-A']));
    const parsed = JSON.parse(r);
    expect(parsed.error).toBeUndefined();
    expect(parsed.data).toEqual([]);
    expect(parsed.showing).toBe(0);
    expect(resultScanRan).toBe(false);
    expect(JSON.stringify(parsed)).not.toContain('secret-svc');
  });

  it('unrestricted caller enumerates check results normally (no regression)', async () => {
    mockDb.select.mockImplementation(() => chain([{
      id: 'r1', deviceId: 'd1', watchType: 'service', name: 'svc', status: 'running',
      cpuPercent: null, memoryMb: null, pid: null, details: null,
      autoRestartAttempted: false, autoRestartSucceeded: null, timestamp: new Date('2026-01-01T00:00:00Z'),
    }]));
    const r = await handlerFor('get_service_monitoring_status')({ action: 'results' }, makeAuth(undefined));
    const parsed = JSON.parse(r);
    expect(parsed.error).toBeUndefined();
    expect(parsed.showing).toBe(1);
  });
});

describe('get_service_monitoring_status known_services — site narrowing', () => {
  beforeEach(() => vi.clearAllMocks());

  it('site-restricted caller with no in-scope devices gets no names without scanning', async () => {
    let nameScanRan = false;
    mockDb.select.mockImplementation((cols?: unknown) => {
      if (isDeviceResolverSelect(cols)) {
        return { from: () => ({ where: () => Promise.resolve([{ id: 'd-siteB', siteId: 'site-B' }]) }) };
      }
      nameScanRan = true;
      return chain([{ subject: 'secret-service-name' }]);
    });

    const r = await handlerFor('get_service_monitoring_status')({ action: 'known_services' }, makeAuth(['site-A']));
    const parsed = JSON.parse(r);
    expect(parsed.error).toBeUndefined();
    expect(parsed.data).toEqual([]);
    expect(nameScanRan).toBe(false);
  });
});
