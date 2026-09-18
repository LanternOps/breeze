import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(),
    // W01: GET /monitoring/assets/:id fetches the newest metric row per
    // (base_oid, instance) with a real DISTINCT ON, so the mock must model it.
    selectDistinctOn: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

// W01 (spec §4.4): the route now derives `reachability` through the batched
// loader. The derivation is pinned by services/assetReachability.test.ts; this
// suite owns the WIRING, so the loader is mocked and driven per-test rather
// than teaching this file's db chain rig three more query shapes.
const reachabilityByAsset = new Map<string, unknown>();
vi.mock('../services/assetReachabilityLoader', () => ({
  loadReachability: vi.fn(async () => reachabilityByAsset),
  loadReachabilityInputs: vi.fn(async () => new Map()),
}));

vi.mock('../db/schema', () => ({
  devices: {
    id: 'devices.id',
    orgId: 'devices.orgId',
    siteId: 'devices.siteId',
  },
  deviceSoftware: {},
  deviceChangeLog: {
    orgId: 'deviceChangeLog.orgId',
    changeType: 'deviceChangeLog.changeType',
    subject: 'deviceChangeLog.subject',
  },
  discoveredAssets: {
    id: 'discoveredAssets.id',
    orgId: 'discoveredAssets.orgId',
    siteId: 'discoveredAssets.siteId',
    hostname: 'discoveredAssets.hostname',
    ipAddress: 'discoveredAssets.ipAddress',
    assetType: 'discoveredAssets.assetType',
    approvalStatus: 'discoveredAssets.approvalStatus',
    isOnline: 'discoveredAssets.isOnline',
    lastSeenAt: 'discoveredAssets.lastSeenAt',
    createdAt: 'discoveredAssets.createdAt',
    updatedAt: 'discoveredAssets.updatedAt',
  },
  networkMonitors: {
    assetId: 'networkMonitors.assetId',
    orgId: 'networkMonitors.orgId',
    isActive: 'networkMonitors.isActive',
    id: 'networkMonitors.id',
    updatedAt: 'networkMonitors.updatedAt',
  },
  snmpDevices: {
    id: 'snmpDevices.id',
    orgId: 'snmpDevices.orgId',
    assetId: 'snmpDevices.assetId',
    snmpVersion: 'snmpDevices.snmpVersion',
    templateId: 'snmpDevices.templateId',
    pollingInterval: 'snmpDevices.pollingInterval',
    port: 'snmpDevices.port',
    isActive: 'snmpDevices.isActive',
    lastPolled: 'snmpDevices.lastPolled',
    lastStatus: 'snmpDevices.lastStatus',
    lastError: 'snmpDevices.lastError',
    lastErrorAt: 'snmpDevices.lastErrorAt',
    createdAt: 'snmpDevices.createdAt',
    community: 'snmpDevices.community',
    username: 'snmpDevices.username',
  },
  snmpMetrics: {
    id: 'snmpMetrics.id',
    deviceId: 'snmpMetrics.deviceId',
    oid: 'snmpMetrics.oid',
    name: 'snmpMetrics.name',
    value: 'snmpMetrics.value',
    valueType: 'snmpMetrics.valueType',
    timestamp: 'snmpMetrics.timestamp',
  },
  serviceProcessCheckResults: {
    id: 'serviceProcessCheckResults.id',
    orgId: 'serviceProcessCheckResults.orgId',
    deviceId: 'serviceProcessCheckResults.deviceId',
    watchType: 'serviceProcessCheckResults.watchType',
    name: 'serviceProcessCheckResults.name',
    status: 'serviceProcessCheckResults.status',
    cpuPercent: 'serviceProcessCheckResults.cpuPercent',
    memoryMb: 'serviceProcessCheckResults.memoryMb',
    pid: 'serviceProcessCheckResults.pid',
    details: 'serviceProcessCheckResults.details',
    autoRestartAttempted: 'serviceProcessCheckResults.autoRestartAttempted',
    autoRestartSucceeded: 'serviceProcessCheckResults.autoRestartSucceeded',
    timestamp: 'serviceProcessCheckResults.timestamp',
  },
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    const allowedSiteIds = c.req.header('x-restrict-site')
      ?.split(',')
      .map((id: string) => id.trim())
      .filter(Boolean);
    c.set('auth', {
      user: { id: 'user-1', email: 'test@example.com', name: 'Test User' },
      scope: 'organization',
      partnerId: null,
      orgId: 'org-111',
      accessibleOrgIds: ['org-111'],
      orgCondition: () => undefined,
      canAccessOrg: (id: string) => id === 'org-111',
    });
    if (allowedSiteIds) c.set('permissions', { allowedSiteIds });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
}));

vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: vi.fn(),
}));

vi.mock('../services/redis', () => ({
  isRedisAvailable: vi.fn(() => true),
}));

vi.mock('../services/permissions', () => ({
  PERMISSIONS: {
    DEVICES_READ: { resource: 'devices', action: 'read' },
    DEVICES_WRITE: { resource: 'devices', action: 'write' },
  },
  canAccessSite: (perms: any, siteId: string) =>
    !perms?.allowedSiteIds || perms.allowedSiteIds.includes(siteId),
}));

import { monitoringRoutes } from './monitoring';
import { db } from '../db';

const ORG_ID = 'org-111';
const ASSET_ID = '11111111-1111-1111-1111-111111111111';
const DEVICE_ID = '22222222-2222-2222-2222-222222222222';
const SNMP_DEVICE_ID = '33333333-3333-3333-3333-333333333333';
const ASSET_DENIED_ID = '44444444-4444-4444-4444-444444444444';
const SITE_ALLOWED = 'aaaaaaaa-0000-0000-0000-000000000001';
const SITE_DENIED = 'bbbbbbbb-0000-0000-0000-000000000002';


describe('monitoring routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    reachabilityByAsset.clear();
    vi.mocked(db.select).mockReset();
    vi.mocked(db.selectDistinctOn).mockReset();
    vi.mocked(db.insert).mockReset();
    vi.mocked(db.update).mockReset();
    vi.mocked(db.delete).mockReset();
    app = new Hono();
    app.route('/monitoring', monitoringRoutes);
  });

  // ============================================
  // GET /assets
  // ============================================
  describe('GET /monitoring/assets', () => {
    it('narrows site-restricted callers to assets in allowed sites', async () => {
      // Allowed asset resolution
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            { id: ASSET_ID, siteId: SITE_ALLOWED },
            { id: ASSET_DENIED_ID, siteId: SITE_DENIED },
          ]),
        }),
      } as any);
      // SNMP devices query is restricted to allowed asset IDs.
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue([{
              id: SNMP_DEVICE_ID,
              assetId: ASSET_ID,
              snmpVersion: 'v2c',
              templateId: null,
              pollingInterval: 300,
              port: 161,
              isActive: true,
              lastPolled: null,
              lastStatus: null,
              createdAt: new Date('2026-01-01T00:00:00Z'),
            }]),
          }),
        }),
      } as any);
      // Network monitors query is restricted to allowed asset IDs.
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            groupBy: vi.fn().mockResolvedValue([
              { assetId: ASSET_ID, totalCount: 1, activeCount: 1 },
            ]),
          }),
        }),
      } as any);
      // Assets query returns only allowed-site assets.
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue([{
              id: ASSET_ID,
              orgId: ORG_ID,
              siteId: SITE_ALLOWED,
              hostname: 'router-allowed',
              ipAddress: '192.168.1.1',
              assetType: 'router',
              approvalStatus: 'approved',
              isOnline: true,
              lastSeenAt: new Date('2026-01-01T00:00:00Z'),
              createdAt: new Date('2026-01-01T00:00:00Z'),
              updatedAt: new Date('2026-01-01T00:00:00Z'),
            }]),
          }),
        }),
      } as any);

      const res = await app.request('/monitoring/assets?includeUnconfigured=true', {
        method: 'GET',
        headers: { Authorization: 'Bearer token', 'x-restrict-site': SITE_ALLOWED },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].id).toBe(ASSET_ID);
      expect(body.data[0].siteId).toBe(SITE_ALLOWED);
    });

    it('leaves unrestricted asset callers unchanged', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockResolvedValue([]),
            }),
          }),
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              groupBy: vi.fn().mockResolvedValue([]),
            }),
          }),
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockResolvedValue([
                {
                  id: ASSET_ID,
                  orgId: ORG_ID,
                  siteId: SITE_ALLOWED,
                  hostname: 'router-allowed',
                  ipAddress: '192.168.1.1',
                  assetType: 'router',
                  approvalStatus: 'approved',
                  isOnline: true,
                  lastSeenAt: new Date(),
                  createdAt: new Date(),
                  updatedAt: new Date(),
                },
                {
                  id: ASSET_DENIED_ID,
                  orgId: ORG_ID,
                  siteId: SITE_DENIED,
                  hostname: 'router-denied',
                  ipAddress: '192.168.2.1',
                  assetType: 'router',
                  approvalStatus: 'approved',
                  isOnline: true,
                  lastSeenAt: new Date(),
                  createdAt: new Date(),
                  updatedAt: new Date(),
                },
              ]),
            }),
          }),
        } as any);

      const res = await app.request('/monitoring/assets?includeUnconfigured=true', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.map((asset: any) => asset.id)).toEqual([ASSET_ID, ASSET_DENIED_ID]);
      expect(db.select).toHaveBeenCalledTimes(3);
    });

    it('returns monitoring assets with SNMP and network config', async () => {
      reachabilityByAsset.set(ASSET_ID, {
        state: 'responding', source: 'snmp', observedAt: '2026-09-16T11:58:00.000Z', lastKnown: null, detail: {},
      });
      // SNMP devices query
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue([{
              id: SNMP_DEVICE_ID,
              assetId: ASSET_ID,
              snmpVersion: 'v2c',
              templateId: null,
              pollingInterval: 300,
              port: 161,
              isActive: true,
              lastPolled: null,
              lastStatus: 'warning',
              lastError: 'SNMP request timed out',
              lastErrorAt: new Date('2026-09-16T11:58:00.000Z'),
              createdAt: new Date(),
            }]),
          }),
        }),
      } as any);
      // Network monitors query
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            groupBy: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as any);
      // Assets query
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue([{
              id: ASSET_ID,
              orgId: ORG_ID,
              siteId: null,
              hostname: 'router-01',
              ipAddress: '192.168.1.1',
              assetType: 'router',
              approvalStatus: 'approved',
              isOnline: true,
              lastSeenAt: new Date(),
              createdAt: new Date(),
              updatedAt: new Date(),
            }]),
          }),
        }),
      } as any);

      const res = await app.request('/monitoring/assets', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].snmp.configured).toBe(true);
      expect(body.data[0].snmp.snmpVersion).toBe('v2c');
      expect(body.data[0].snmp.lastError).toBe('SNMP request timed out');
      expect(body.data[0].snmp.lastErrorAt).toBe('2026-09-16T11:58:00.000Z');
      expect(db.select).toHaveBeenCalledWith(expect.objectContaining({
        lastError: 'snmpDevices.lastError',
        lastErrorAt: 'snmpDevices.lastErrorAt',
      }));
      expect(body.data[0].monitoring.configured).toBe(true);
      // W01 (spec §4.4) — the list route carries the derived reachability.
      expect(body.data[0].reachability).toEqual({
        state: 'responding', source: 'snmp', observedAt: '2026-09-16T11:58:00.000Z', lastKnown: null, detail: {},
      });
    });

    it('returns empty data when no configured assets exist', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockResolvedValue([]),
            }),
          }),
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              groupBy: vi.fn().mockResolvedValue([]),
            }),
          }),
        } as any);

      const res = await app.request('/monitoring/assets', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toEqual([]);
    });
  });

  // ============================================
  // GET /assets/:id
  // ============================================
  describe('GET /monitoring/assets/:id', () => {
    it('returns an opaque 404 (matching a missing asset) for a site-restricted caller reading an out-of-scope asset (#5777)', async () => {
      // Asset lookup
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ id: ASSET_ID, orgId: ORG_ID, siteId: SITE_DENIED }]),
          }),
        }),
      } as any);

      const res = await app.request(`/monitoring/assets/${ASSET_ID}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token', 'x-restrict-site': SITE_ALLOWED },
      });

      // Same status AND same body as the "returns 404 for nonexistent asset"
      // test below — an out-of-ceiling asset must be indistinguishable from
      // a missing one (existence oracle, #5777). The route now returns
      // before any of the later network-monitor/SNMP selects run, so only
      // the asset lookup needs wiring here.
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('Asset not found');
    });

    it('leaves unrestricted asset detail callers unchanged', async () => {
      // Asset lookup
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ id: ASSET_ID, orgId: ORG_ID, siteId: SITE_DENIED }]),
          }),
        }),
      } as any);
      // SNMP devices
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
      } as any);
      // Network monitor total
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ count: 0 }]),
        }),
      } as any);
      // Network monitor active
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ count: 0 }]),
        }),
      } as any);

      const res = await app.request(`/monitoring/assets/${ASSET_ID}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.enabled).toBe(false);
      expect(body.networkMonitors.totalCount).toBe(0);
    });

    it.each([
      { lastError: 'SNMP request timed out', lastErrorAt: new Date('2026-09-16T11:58:00.000Z') },
      { lastError: null, lastErrorAt: null },
    ])('returns asset detail with SNMP diagnostics: $lastError', async ({ lastError, lastErrorAt }) => {
      reachabilityByAsset.set(ASSET_ID, {
        state: 'responding', source: 'snmp', observedAt: '2026-09-16T11:58:00.000Z', lastKnown: null, detail: {},
      });
      // Asset lookup
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ id: ASSET_ID, orgId: ORG_ID }]),
          }),
        }),
      } as any);
      // SNMP devices
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{
                id: SNMP_DEVICE_ID,
                snmpVersion: 'v2c',
                templateId: null,
                pollingInterval: 300,
                port: 161,
                isActive: true,
                lastPolled: null,
                lastStatus: 'ok',
                lastError,
                lastErrorAt,
                username: null,
                community: 'public',
              }]),
            }),
          }),
        }),
      } as any);
      // Network monitor total
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ count: 2 }]),
        }),
      } as any);
      // Network monitor active
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ count: 1 }]),
        }),
      } as any);
      // Newest row per series (DISTINCT ON)
      // The DISTINCT ON chain ends at .orderBy() — there is deliberately no
      // .limit(): the per-series pick happens in Postgres, so a global row cap
      // would be the very bug this shape replaced.
      vi.mocked(db.selectDistinctOn).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue([{
              id: 'metric-1',
              oid: '1.3.6.1.2.1.1.5.0',
              name: 'sysName',
              value: 'router-01',
              valueType: 'string',
              timestamp: new Date(),
            }]),
          }),
        }),
      } as any);

      const res = await app.request(`/monitoring/assets/${ASSET_ID}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.enabled).toBe(true);
      expect(body.snmpDevice.snmpVersion).toBe('v2c');
      expect(body.snmpDevice.lastError).toBe(lastError);
      expect(body.snmpDevice.lastErrorAt).toBe(lastErrorAt?.toISOString() ?? null);
      expect(body.recentMetrics).toHaveLength(1);
      expect(body.networkMonitors.totalCount).toBe(2);
      // W01 (spec §6.2) — collection health rides the same response. This
      // fixture's device has no template and has never succeeded (lastPolled
      // null), so the honest answer is never_polled with no OIDs — not a
      // fabricated 'ok'.
      expect(body.collection).toMatchObject({ templateId: null, status: 'never_polled', oids: [] });
      // W01 (spec §4.4) — the detail route carries the derived reachability.
      expect(body.reachability).toEqual({
        state: 'responding', source: 'snmp', observedAt: '2026-09-16T11:58:00.000Z', lastKnown: null, detail: {},
      });
    });

    it('carries reachability on the no-SNMP early return too (W01, spec §4.4)', async () => {
      reachabilityByAsset.set(ASSET_ID, {
        state: 'responding', source: 'snmp', observedAt: '2026-09-16T11:58:00.000Z', lastKnown: null, detail: {},
      });
      // Asset lookup
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ id: ASSET_ID, orgId: ORG_ID }]),
          }),
        }),
      } as any);
      // SNMP devices — none
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }),
          }),
        }),
      } as any);
      // Network monitor total / active
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([{ count: 1 }]) }),
      } as any);
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([{ count: 1 }]) }),
      } as any);

      const res = await app.request(`/monitoring/assets/${ASSET_ID}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.snmpDevice).toBeNull();
      expect(body.reachability.state).toBe('responding');
      // No SNMP row at all — collection says so explicitly (spec §6.2).
      expect(body.collection).toMatchObject({ templateId: null, status: 'never_polled', oids: [] });
    });

    it('returns 404 for nonexistent asset', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as any);

      const res = await app.request(`/monitoring/assets/${ASSET_ID}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(404);
    });
  });

});
