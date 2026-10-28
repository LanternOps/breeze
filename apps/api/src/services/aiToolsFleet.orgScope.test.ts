import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { eq, inArray } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

/**
 * #10396: `manage_patches` list / compliance took the org from
 * `auth.orgId ?? accessibleOrgIds[0]`. A partner login has no `auth.orgId`, so
 * a partner-wide Wisp session silently got whichever customer org sorts first
 * and presented it as "the fleet". Without an explicit `orgId` these reads now
 * cover every org the caller reaches (never wider); with one they narrow to it.
 */
const { patchHelperMocks } = vi.hoisted(() => ({
  patchHelperMocks: {
    upsertPatchApproval: vi.fn(async () => undefined),
    resolvePartnerIdForOrg: vi.fn(async () => 'partner-1'),
    declineAllRingApprovals: vi.fn(async () => ({ ringIds: [], failedRingIds: [] })),
  },
}));
vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn() },
}));
vi.mock('../jobs/peripheralJobs', () => ({ schedulePeripheralPolicyDevice: vi.fn(async () => undefined) }));
vi.mock('../routes/patches/helpers', () => patchHelperMocks);

import { db } from '../db';
import { registerFleetTools } from './aiToolsFleet';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';

const mockDb = db as unknown as { select: ReturnType<typeof vi.fn> };
const dialect = new PgDialect();
const render = (cond: unknown) => dialect.sqlToQuery(cond as SQL);

function handler(): AiTool['handler'] {
  const reg = new Map<string, AiTool>();
  registerFleetTools(reg);
  return reg.get('manage_patches')!.handler;
}

function partnerAuth(accessibleOrgIds: string[] | null = ['org-first', 'org-second'], overrides: Record<string, unknown> = {}): AuthContext {
  return {
    principal: { kind: 'user' },
    user: { id: 'u1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
    token: null,
    partnerId: accessibleOrgIds === null ? null : 'partner-1',
    orgId: null,
    scope: accessibleOrgIds === null ? 'system' : 'partner',
    accessibleOrgIds,
    partnerOrgAccess: 'all',
    orgCondition: (col: any) => accessibleOrgIds === null
      ? undefined
      : accessibleOrgIds.length === 1 ? eq(col, accessibleOrgIds[0]!) : inArray(col, accessibleOrgIds),
    canAccessOrg: (id: string) => accessibleOrgIds === null || accessibleOrgIds.includes(id),
    ...overrides,
  } as unknown as AuthContext;
}

beforeEach(() => {
  vi.clearAllMocks();
  patchHelperMocks.resolvePartnerIdForOrg.mockResolvedValue('partner-1');
});

describe('manage_patches list — org scope without a device (#10396)', () => {
  function mockList() {
    const where = vi.fn((_cond: SQL) => ({
      groupBy: () => ({ orderBy: () => ({ limit: () => ({ offset: () => Promise.resolve([{ id: 'patch-1' }]) }) }) }),
    }));
    mockDb.select.mockImplementation(() => ({ from: () => ({ innerJoin: () => ({ where }) }) }));
    return where;
  }

  it('reads every org the partner caller reaches, not accessibleOrgIds[0]', async () => {
    const where = mockList();
    const body = JSON.parse(await handler()({ action: 'list' }, partnerAuth()));
    expect(body.error).toBeUndefined();
    const { sql: text, params } = render(where.mock.calls[0]![0]);
    expect(text).toMatch(/"device_patches"\."org_id" in \(\$\d+, \$\d+\)/);
    expect(params).toEqual(expect.arrayContaining(['org-first', 'org-second']));
    expect(body.scope).toEqual({ allAccessibleOrgs: true, orgCount: 2 });
  });

  it('narrows to an explicit accessible orgId', async () => {
    const where = mockList();
    const body = JSON.parse(await handler()({ action: 'list', orgId: 'org-second' }, partnerAuth()));
    const { params } = render(where.mock.calls[0]![0]);
    expect(params).toContain('org-second');
    expect(params).not.toContain('org-first');
    expect(body.scope).toEqual({ orgId: 'org-second' });
  });

  it('refuses an orgId outside the caller reach without querying', async () => {
    const body = JSON.parse(await handler()({ action: 'list', orgId: 'org-elsewhere' }, partnerAuth()));
    expect(body.error).toBe('Access denied to this organization');
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it('keeps the exact-device axis across orgs for a device-LESS run', async () => {
    const listWhere = vi.fn((_cond: SQL) => ({
      groupBy: () => ({ orderBy: () => ({ limit: () => ({ offset: () => Promise.resolve([]) }) }) }),
    }));
    const scanWhere = vi.fn((_cond: SQL) => Promise.resolve([
      { id: 'dev-a', siteId: 'site-1' }, { id: 'dev-b', siteId: 'site-2' },
    ]));
    mockDb.select.mockImplementation((cols?: Record<string, unknown>) => (
      cols && Object.keys(cols).length === 2 && 'siteId' in cols
        ? { from: () => ({ where: scanWhere }) }
        : { from: () => ({ innerJoin: () => ({ where: listWhere }) }) }
    ));
    await handler()({ action: 'list' }, partnerAuth(['org-first', 'org-second'], { allowedDeviceIds: ['dev-a'] }));
    expect(render(scanWhere.mock.calls[0]![0]).params).toEqual(expect.arrayContaining(['org-first', 'org-second']));
    const { params } = render(listWhere.mock.calls[0]![0]);
    expect(params).toContain('dev-a');
    expect(params).not.toContain('dev-b');
  });

  it('refuses an orgId that disagrees with the device it names', async () => {
    mockDb.select.mockImplementation(() => ({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([{ id: 'dev-1', siteId: null, orgId: 'org-first' }]) }) }),
    }));
    const body = JSON.parse(await handler()({ action: 'list', deviceId: 'dev-1', orgId: 'org-second' }, partnerAuth()));
    expect(body.error).toMatch(/does not belong to organization/);
  });

  it('fails closed for an unrestricted caller that names no org', async () => {
    const body = JSON.parse(await handler()({ action: 'list' }, partnerAuth(null)));
    expect(body.error).toMatch(/orgId is required/);
    expect(mockDb.select).not.toHaveBeenCalled();
  });
});

describe('manage_patches compliance — org scope (#10396)', () => {
  /** approvals → (device scan, narrowed callers only) → patch stats → device count. */
  function mockCompliance(opts: { orgDevices?: Array<{ id: string; siteId: string | null }>; deviceCount?: number } = {}) {
    const wheres: Record<string, SQL> = {};
    mockDb.select.mockImplementation((cols?: Record<string, unknown>) => {
      const keys = cols ? Object.keys(cols) : [];
      const kind = keys.includes('approved') ? 'approvals'
        : keys.includes('devicesNeedingPatches') ? 'stats'
          : keys.includes('deviceCount') ? 'count'
            : 'devices';
      const rows = kind === 'approvals' ? [{ total: 4, pending: 1, approved: 3, rejected: 0, deferred: 0 }]
        : kind === 'stats' ? [{ pending: 5, installed: 7, failed: 1, missing: 0, devicesNeedingPatches: 2 }]
          : kind === 'count' ? [{ deviceCount: opts.deviceCount ?? 6 }]
            : opts.orgDevices ?? [];
      const where = (cond: SQL) => { wheres[kind] = cond; return Promise.resolve(rows); };
      // The patch stats join `devices` for the tech-facing population (#9611).
      return { from: () => (kind === 'stats' ? { innerJoin: () => ({ where }) } : { where }) };
    });
    return wheres;
  }

  it('computes fleet compliance across every reachable org instead of one org\'s (absent) snapshot', async () => {
    const wheres = mockCompliance({ deviceCount: 6 });
    const body = JSON.parse(await handler()({ action: 'compliance' }, partnerAuth()));
    expect(body.message).toBeUndefined();
    expect(body.scope).toEqual({ allAccessibleOrgs: true, orgCount: 2 });
    expect(body.snapshot).toEqual({
      totalDevices: 6,
      compliantDevices: 4,
      nonCompliantDevices: 2,
      pendingPatches: 5,
      installedPatches: 7,
      failedPatches: 1,
      missingPatches: 0,
    });
    for (const kind of ['approvals', 'stats', 'count']) {
      const { params } = render(wheres[kind]);
      expect(params, kind).toEqual(expect.arrayContaining(['org-first', 'org-second']));
    }
    expect(render(wheres.approvals!).params).toContain('partner-1');
    // Same tech-facing population as GET /patches/compliance (#9611).
    for (const kind of ['stats', 'count']) {
      const { sql: text } = render(wheres[kind]);
      expect(text, kind).toContain('"devices"."is_ephemeral"');
      expect(text, kind).toContain("!= 'decommissioned'");
    }
  });

  it('narrows to an explicit accessible orgId', async () => {
    const wheres = mockCompliance();
    const body = JSON.parse(await handler()({ action: 'compliance', orgId: 'org-second' }, partnerAuth()));
    expect(body.scope).toEqual({ orgId: 'org-second' });
    for (const kind of ['approvals', 'stats', 'count']) {
      const { params } = render(wheres[kind]);
      expect(params, kind).toContain('org-second');
      expect(params, kind).not.toContain('org-first');
    }
  });

  it('keeps the site axis across orgs: a site-restricted caller counts only its in-scope devices', async () => {
    const wheres = mockCompliance({
      orgDevices: [{ id: 'dev-a', siteId: 'site-ok' }, { id: 'dev-b', siteId: 'site-other' }],
    });
    const auth = partnerAuth(['org-first', 'org-second'], {
      allowedSiteIds: ['site-ok'],
      canAccessSite: (id: string | null) => id === 'site-ok',
    });
    const body = JSON.parse(await handler()({ action: 'compliance' }, auth));
    expect(body.snapshot.siteScoped).toBe(true);
    const deviceScan = render(wheres.devices!);
    expect(deviceScan.params).toEqual(expect.arrayContaining(['org-first', 'org-second']));
    for (const kind of ['stats', 'count']) {
      const { params } = render(wheres[kind]);
      expect(params, kind).toContain('dev-a');
      expect(params, kind).not.toContain('dev-b');
    }
  });

  it('keeps the exact-device axis across orgs: a device-LESS run counts only its frozen devices', async () => {
    const wheres = mockCompliance({
      orgDevices: [{ id: 'dev-a', siteId: 'site-1' }, { id: 'dev-b', siteId: 'site-2' }],
    });
    const auth = partnerAuth(['org-first', 'org-second'], { allowedDeviceIds: ['dev-a'] });
    const body = JSON.parse(await handler()({ action: 'compliance' }, auth));
    expect(body.snapshot.siteScoped).toBe(true);
    for (const kind of ['stats', 'count']) {
      const { params } = render(wheres[kind]);
      expect(params, kind).toContain('dev-a');
      expect(params, kind).not.toContain('dev-b');
    }
  });

  it('a device-LESS run with no frozen devices gets zeroed figures, not the fleet', async () => {
    const wheres = mockCompliance({ orgDevices: [{ id: 'dev-a', siteId: 'site-1' }] });
    const auth = partnerAuth(['org-first', 'org-second'], { allowedDeviceIds: [] });
    const body = JSON.parse(await handler()({ action: 'compliance' }, auth));
    expect(body.snapshot).toMatchObject({ totalDevices: 0, siteScoped: true });
    expect(wheres.stats).toBeUndefined();
    expect(wheres.count).toBeUndefined();
  });

  it('fails closed for an unrestricted caller that names no org', async () => {
    const body = JSON.parse(await handler()({ action: 'compliance' }, partnerAuth(null)));
    expect(body.error).toMatch(/orgId is required/);
    expect(mockDb.select).not.toHaveBeenCalled();
  });
});
