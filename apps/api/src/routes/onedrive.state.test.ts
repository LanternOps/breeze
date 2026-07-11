import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';
const DEVICE_1 = '33333333-3333-3333-3333-333333333333';

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
  },
}));

const ORG_C = '44444444-4444-4444-4444-444444444444';

// --- mutable auth state, set per-test ---
let authState: {
  scope: 'organization' | 'partner' | 'system';
  orgId?: string | null;
  accessibleOrgIds?: string[] | null;
  canAccessOrg?: (orgId: string) => boolean;
  orgCondition?: (col: unknown) => unknown;
  user?: { id: string } | null;
};

// Site-scope permissions context, set per-test. null allowedSiteIds =
// unrestricted (the common case); the site-restriction tests narrow it.
let permsState: { allowedSiteIds: string[] | null };

// Mock only authMiddleware + requirePermission (thin passthrough); requireScope
// and resolveScopedOrgId (./c2c/helpers) are left as the REAL implementations so
// the cross-tenant test exercises actual org-access enforcement, not a stub.
vi.mock('../middleware/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../middleware/auth')>();
  return {
    ...actual,
    authMiddleware: vi.fn((c: any, next: any) => {
      c.set('auth', authState);
      return next();
    }),
    // The real requirePermission populates c.get('permissions'), which the
    // canonical site-scope gate (getDeviceWithOrgAndSiteCheck) requires and
    // fails loud (500) without — mirror that here.
    requirePermission: vi.fn(() => (c: any, next: any) => {
      c.set('permissions', permsState);
      return next();
    }),
  };
});

import { db } from '../db';
import { onedriveRoutes } from './onedrive';

describe('GET /onedrive/devices/:deviceId/state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    permsState = { allowedSiteIds: null };
    authState = {
      scope: 'organization',
      orgId: ORG_A,
      accessibleOrgIds: [ORG_A],
      canAccessOrg: (orgId: string) => orgId === ORG_A,
      user: { id: 'user-1' },
    };
  });

  it('returns the state row for an accessible device', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ id: DEVICE_1, orgId: ORG_A }]),
          }),
        }),
      } as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              {
                deviceId: DEVICE_1,
                orgId: ORG_A,
                signedIn: true,
                filesOnDemandOn: true,
                oneDriveVersion: '24.100',
                kfmFolderStates: { Desktop: 'redirected' },
                mountedLibraries: [],
                entitledLibraries: [],
                driftEntries: [],
                lastReportedAt: new Date('2026-07-01T00:00:00Z'),
              },
            ]),
          }),
        }),
      } as any);

    const res = await onedriveRoutes.request(`/devices/${DEVICE_1}/state`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.state).toMatchObject({ signedIn: true, deviceId: DEVICE_1 });
  });

  it('returns state:null when the agent has not reported yet', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ id: DEVICE_1, orgId: ORG_A }]),
          }),
        }),
      } as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as any);

    const res = await onedriveRoutes.request(`/devices/${DEVICE_1}/state`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.state).toBeNull();
  });

  it('404s for a device in an inaccessible org', async () => {
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{ id: DEVICE_1, orgId: ORG_B }]),
        }),
      }),
    } as any);

    const res = await onedriveRoutes.request(`/devices/${DEVICE_1}/state`);
    expect(res.status).toBe(404);
    expect(db.select).toHaveBeenCalledTimes(1); // no second (state) query
  });

  it('403s for a site-restricted tech when the device is in another site', async () => {
    permsState = { allowedSiteIds: ['site-allowed'] };
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{ id: DEVICE_1, orgId: ORG_A, siteId: 'site-other' }]),
        }),
      }),
    } as any);

    const res = await onedriveRoutes.request(`/devices/${DEVICE_1}/state`);
    expect(res.status).toBe(403);
    expect(db.select).toHaveBeenCalledTimes(1); // no second (state) query
  });
});

describe('GET /onedrive/state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    permsState = { allowedSiteIds: null };
    authState = {
      scope: 'organization',
      orgId: ORG_A,
      accessibleOrgIds: [ORG_A],
      canAccessOrg: (orgId: string) => orgId === ORG_A,
      user: { id: 'user-1' },
    };
  });

  it('returns per-device rows + stats for an explicitly-requested org', async () => {
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            {
              deviceId: 'device-1',
              hostname: 'host-1',
              signedIn: true,
              filesOnDemandOn: true,
              oneDriveVersion: '24.100',
              kfmFolderStates: { Desktop: 'redirected', Documents: 'redirected' },
              mountedLibraries: [],
              entitledLibraries: [],
              driftEntries: [{ library: 'Documents', reason: 'missing' }],
              lastReportedAt: new Date('2026-07-01T00:00:00Z'),
            },
            {
              deviceId: 'device-2',
              hostname: 'host-2',
              signedIn: false,
              filesOnDemandOn: false,
              oneDriveVersion: null,
              kfmFolderStates: {},
              mountedLibraries: [],
              entitledLibraries: [],
              driftEntries: [],
              lastReportedAt: new Date('2026-07-01T00:00:00Z'),
            },
          ]),
        }),
      }),
    } as any);

    const res = await onedriveRoutes.request(`/state?orgId=${ORG_A}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.devices).toHaveLength(2);
    expect(body.stats).toEqual({ total: 2, signedIn: 1, kfmProtected: 1, withDrift: 1 });
  });

  it('narrows the rollup to the allowed sites for a site-restricted tech (stats follow)', async () => {
    permsState = { allowedSiteIds: ['site-allowed'] };
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            {
              deviceId: 'device-1',
              hostname: 'host-1',
              siteId: 'site-allowed',
              signedIn: true,
              filesOnDemandOn: true,
              oneDriveVersion: '24.100',
              kfmFolderStates: {},
              mountedLibraries: [],
              entitledLibraries: [],
              driftEntries: [],
              lastReportedAt: new Date('2026-07-01T00:00:00Z'),
            },
            {
              deviceId: 'device-2',
              hostname: 'host-2',
              siteId: 'site-other',
              signedIn: true,
              filesOnDemandOn: false,
              oneDriveVersion: null,
              kfmFolderStates: {},
              mountedLibraries: [],
              entitledLibraries: [],
              driftEntries: [],
              lastReportedAt: new Date('2026-07-01T00:00:00Z'),
            },
          ]),
        }),
      }),
    } as any);

    const res = await onedriveRoutes.request(`/state?orgId=${ORG_A}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.devices).toHaveLength(1);
    expect(body.devices[0].deviceId).toBe('device-1');
    expect(body.stats.total).toBe(1); // stats computed AFTER narrowing
  });

  it('400s when an explicitly-requested org is inaccessible', async () => {
    const res = await onedriveRoutes.request(`/state?orgId=${ORG_B}`);
    expect(res.status).toBe(400);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('aggregates across all accessible orgs when no orgId is given (partner scope, multi-org)', async () => {
    const cond = { sentinel: 'partner-accessible-orgs' };
    const orgConditionSpy = vi.fn().mockReturnValue(cond);
    authState = {
      scope: 'partner',
      orgId: null,
      accessibleOrgIds: [ORG_A, ORG_C],
      canAccessOrg: (orgId: string) => orgId === ORG_A || orgId === ORG_C,
      orgCondition: orgConditionSpy,
      user: { id: 'user-1' },
    };

    // These rows stand in for what Postgres would already have filtered down
    // to via the where(orgCondition) clause (+ RLS backstop) — one device from
    // each of the caller's two accessible orgs, ORG_B's rows never surface.
    const whereSpy = vi.fn().mockResolvedValue([
      {
        deviceId: 'device-1',
        hostname: 'host-1',
        signedIn: true,
        filesOnDemandOn: true,
        oneDriveVersion: '24.100',
        kfmFolderStates: { Desktop: 'redirected' },
        mountedLibraries: [],
        entitledLibraries: [],
        driftEntries: [],
        lastReportedAt: new Date('2026-07-01T00:00:00Z'),
      },
      {
        deviceId: 'device-3',
        hostname: 'host-3',
        signedIn: true,
        filesOnDemandOn: true,
        oneDriveVersion: '24.100',
        kfmFolderStates: { Desktop: 'redirected' },
        mountedLibraries: [],
        entitledLibraries: [],
        driftEntries: [],
        lastReportedAt: new Date('2026-07-01T00:00:00Z'),
      },
    ]);
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: whereSpy,
        }),
      }),
    } as any);

    const res = await onedriveRoutes.request('/state');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.devices).toHaveLength(2);
    expect(body.stats).toEqual({ total: 2, signedIn: 2, kfmProtected: 2, withDrift: 0 });
    // Proves the route delegates org-scoping to auth.orgCondition (the vuln
    // fleet-stats pattern) rather than requiring a single resolvable org.
    expect(orgConditionSpy).toHaveBeenCalledTimes(1);
    expect(whereSpy).toHaveBeenCalledWith(cond);
  });
});
