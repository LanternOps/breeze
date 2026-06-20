import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn() },
}));
vi.mock('../jobs/cisJobs', () => ({ scheduleCisRemediationWithResult: vi.fn() }));
vi.mock('./cisHardening', () => ({ extractFailedCheckIds: vi.fn(() => new Set()) }));

import { db } from '../db';
import { registerCisBenchmarkTools } from './aiToolsCisBenchmark';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';

const mockDb = db as unknown as { select: ReturnType<typeof vi.fn> };

function handlerFor(name: string): AiTool['handler'] {
  const reg = new Map<string, AiTool>();
  registerCisBenchmarkTools(reg);
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
function chain(result: unknown): any {
  const p: any = Promise.resolve(result);
  for (const m of ['from', 'innerJoin', 'leftJoin', 'where', 'orderBy', 'limit', 'groupBy', 'offset', 'as']) {
    p[m] = () => p;
  }
  return p;
}

describe('get_cis_compliance — site narrowing (no deviceId branch)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('site-restricted caller does NOT receive CIS rows for a device in a forbidden site', async () => {
    let cisScanRan = false;
    mockDb.select.mockImplementation((cols?: unknown) => {
      if (isDeviceResolverSelect(cols)) {
        return { from: () => ({ where: () => Promise.resolve([{ id: 'd-siteB', siteId: 'site-B' }]) }) };
      }
      cisScanRan = true;
      return chain([
        { orgId: 'org-1', deviceId: 'd-siteB', baselineName: 'CIS', deviceHostname: 'forbidden-host', checkedAt: new Date(), score: 50, totalChecks: 10, passedChecks: 5, failedChecks: 5, summary: {} },
      ]);
    });

    const r = await handlerFor('get_cis_compliance')({}, makeAuth(['site-A']));
    const parsed = JSON.parse(r);
    expect(parsed.error).toBeUndefined();
    expect(parsed.count).toBe(0);
    expect(parsed.results).toEqual([]);
    expect(cisScanRan).toBe(false);
    expect(JSON.stringify(parsed)).not.toContain('forbidden-host');
  });

  it('unrestricted caller enumerates CIS compliance normally (no regression)', async () => {
    let call = 0;
    mockDb.select.mockImplementation(() => {
      call += 1;
      if (call === 1) {
        // ranked subquery -> .as()
        return chain(null);
      }
      if (call === 2) {
        // summary aggregation
        return chain([{ total: 1, averageScore: 50, failingDevices: 1 }]);
      }
      // rows
      return chain([
        { orgId: 'org-1', baselineId: 'b1', baselineName: 'CIS', baselineBenchmarkVersion: '1', baselineLevel: 1, baselineIsActive: true, baselineOsType: 'windows', deviceId: 'd1', deviceHostname: 'h1', deviceStatus: 'online', deviceOsType: 'windows', checkedAt: new Date(), score: 50, totalChecks: 10, passedChecks: 5, failedChecks: 5, summary: {} },
      ]);
    });

    const r = await handlerFor('get_cis_compliance')({}, makeAuth(undefined));
    const parsed = JSON.parse(r);
    expect(parsed.error).toBeUndefined();
    expect(parsed.count).toBe(1);
  });
});
