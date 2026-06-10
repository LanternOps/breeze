import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));

import { db } from '../db';
import { registerSLABackupTools } from './aiToolsSLABackup';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';

const mockDb = db as unknown as { select: ReturnType<typeof vi.fn> };

function handlerFor(name: string): AiTool['handler'] {
  const reg = new Map<string, AiTool>();
  registerSLABackupTools(reg);
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

describe('get_sla_breaches — site narrowing (cross-site enumeration)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('site-restricted caller does NOT receive breach rows/hostnames for a device in a forbidden site', async () => {
    let breachScanRan = false;
    const forbiddenBreach = {
      id: 'b1', slaConfigId: 'c1', slaName: 'SLA', deviceId: 'd-siteB',
      hostname: 'forbidden-host', eventType: 'rpo_breach', details: null,
      detectedAt: new Date('2026-01-01T00:00:00Z'), resolvedAt: null,
    };
    mockDb.select.mockImplementation((cols?: unknown) => {
      if (isDeviceResolverSelect(cols)) {
        return { from: () => ({ where: () => Promise.resolve([{ id: 'd-siteB', siteId: 'site-B' }]) }) };
      }
      breachScanRan = true;
      return chain([forbiddenBreach]);
    });

    const r = await handlerFor('get_sla_breaches')({}, makeAuth(['site-A']));
    const parsed = JSON.parse(r);
    expect(parsed.error).toBeUndefined();
    expect(parsed.breaches).toEqual([]);
    expect(parsed.showing).toBe(0);
    // The empty result must be annotated as scope-limited, not "no data exists".
    expect(parsed.scopeNote).toBeTruthy();
    expect(breachScanRan).toBe(false);
    expect(JSON.stringify(parsed)).not.toContain('forbidden-host');
  });

  it('unrestricted caller enumerates breaches normally (no regression)', async () => {
    mockDb.select.mockImplementation(() => chain([{
      id: 'b1', slaConfigId: 'c1', slaName: 'SLA', deviceId: 'd1',
      hostname: 'h1', eventType: 'rpo_breach', details: null,
      detectedAt: new Date('2026-01-01T00:00:00Z'), resolvedAt: null,
    }]));
    const r = await handlerFor('get_sla_breaches')({}, makeAuth(undefined));
    const parsed = JSON.parse(r);
    expect(parsed.error).toBeUndefined();
    expect(parsed.showing).toBe(1);
  });
});

describe('get_sla_compliance_report — site narrowing', () => {
  beforeEach(() => vi.clearAllMocks());

  it('site-restricted caller with no in-scope devices gets an indeterminate report (configs counted, no device scans)', async () => {
    let deviceLinkedScanRan = false;
    let countQueries = 0;
    mockDb.select.mockImplementation((cols?: unknown) => {
      if (isDeviceResolverSelect(cols)) {
        return { from: () => ({ where: () => Promise.resolve([{ id: 'd-siteB', siteId: 'site-B' }]) }) };
      }
      if (cols && typeof cols === 'object' && 'avgRpo' in (cols as object)) {
        deviceLinkedScanRan = true; // recoveryReadiness scan must not run
        return chain([{ avgRpo: 60, avgRto: 120 }]);
      }
      countQueries += 1;
      return chain([{ count: 7 }]);
    });

    const r = await handlerFor('get_sla_compliance_report')({}, makeAuth(['site-A']));
    const parsed = JSON.parse(r);
    expect(parsed.error).toBeUndefined();
    // Org-level config metadata stays visible (configs are not device-linked)…
    expect(parsed.activeConfigs).toBe(7);
    expect(countQueries).toBe(1); // only the config count — no breach/event scans
    // …but device-derived compliance is indeterminate — never a fabricated 100%.
    expect(parsed.compliancePercent).toBeNull();
    expect(parsed.compliantConfigs).toBeNull();
    expect(parsed.configsWithBreaches).toBeNull();
    expect(parsed.activeBreaches).toBe(0);
    expect(parsed.totalEventsInWindow).toBe(0);
    expect(parsed.avgEstimatedRpoMinutes).toBeNull();
    expect(parsed.avgEstimatedRtoMinutes).toBeNull();
    expect(parsed.scopeNote).toBeTruthy();
    expect(deviceLinkedScanRan).toBe(false);
  });

  it('unrestricted caller reads the report normally (no regression)', async () => {
    mockDb.select.mockImplementation((cols?: unknown) => {
      if (cols && typeof cols === 'object' && 'avgRpo' in (cols as object)) {
        return chain([{ avgRpo: 60, avgRto: 120 }]);
      }
      return chain([{ count: 2 }]);
    });
    const r = await handlerFor('get_sla_compliance_report')({}, makeAuth(undefined));
    const parsed = JSON.parse(r);
    expect(parsed.error).toBeUndefined();
    expect(parsed.activeConfigs).toBe(2);
    expect(parsed.activeBreaches).toBe(2);
    expect(parsed.avgEstimatedRpoMinutes).toBe(60);
    expect(parsed.avgEstimatedRtoMinutes).toBe(120);
  });
});

describe('query_backup_sla — site narrowing of breach counts', () => {
  beforeEach(() => vi.clearAllMocks());

  it('site-restricted caller with no in-scope devices sees configs with indeterminate compliance (no breach scan)', async () => {
    let breachScanRan = false;
    const config = {
      id: 'c1', orgId: 'org-1', name: 'SLA Config', targetDevices: ['d-siteB'], targetGroups: [],
      isActive: true, createdAt: new Date('2026-01-01T00:00:00Z'),
    };
    mockDb.select.mockImplementation((cols?: unknown) => {
      if (isDeviceResolverSelect(cols)) {
        return { from: () => ({ where: () => Promise.resolve([{ id: 'd-siteB', siteId: 'site-B' }]) }) };
      }
      if (cols === undefined) {
        return chain([config]); // config listing (org-level, not device-linked)
      }
      breachScanRan = true; // breach-count aggregation must not run
      return chain([{ slaConfigId: 'c1', count: 5 }]);
    });

    const r = await handlerFor('query_backup_sla')({}, makeAuth(['site-A']));
    const parsed = JSON.parse(r);
    expect(parsed.error).toBeUndefined();
    expect(parsed.showing).toBe(1);
    // Compliance must be indeterminate — never a fabricated healthy 'compliant'.
    expect(parsed.configs[0].activeBreaches).toBeNull();
    expect(parsed.configs[0].complianceStatus).toBe('unknown');
    expect(parsed.scopeNote).toBeTruthy();
    expect(breachScanRan).toBe(false);
  });

  it('unrestricted caller sees real breach counts (no regression)', async () => {
    const config = {
      id: 'c1', orgId: 'org-1', name: 'SLA Config', targetDevices: [], targetGroups: [],
      isActive: true, createdAt: new Date('2026-01-01T00:00:00Z'),
    };
    mockDb.select.mockImplementation((cols?: unknown) => {
      if (cols === undefined) return chain([config]);
      return chain([{ slaConfigId: 'c1', count: 5 }]);
    });
    const r = await handlerFor('query_backup_sla')({}, makeAuth(undefined));
    const parsed = JSON.parse(r);
    expect(parsed.error).toBeUndefined();
    expect(parsed.configs[0].activeBreaches).toBe(5);
    expect(parsed.configs[0].complianceStatus).toBe('breach');
  });
});
