import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { discoveryRoutes } from './discovery';
import { db } from '../db';
import { authMiddleware } from '../middleware/auth';
import { isRedisAvailable } from '../services/redis';
import { decryptSecret, isEncryptedSecret } from '../services/secretCrypto';
import { networkTopology, topologyLayout, discoveredAssets } from '../db/schema';

vi.mock('../services', () => ({}));

vi.mock('../services/auditEvents', () => ({
  writeAuditEvent: vi.fn(),
  writeRouteAudit: vi.fn()
}));

vi.mock('../services/redis', () => ({
  isRedisAvailable: vi.fn(() => false),
  getRedisConnection: vi.fn(),
}));

vi.mock('../jobs/discoveryWorker', () => ({
  enqueueDiscoveryScan: vi.fn(async () => {}),
  getDiscoveryQueue: vi.fn(() => null),
}));

vi.mock('../services/discoveryJobCreation', () => ({
  createDiscoveryJobIfIdle: vi.fn(async ({ profileId, orgId, siteId, agentId }: any) => ({
    job: {
      id: 'job-001',
      profileId,
      orgId,
      siteId,
      agentId: agentId ?? null,
      status: 'scheduled',
      scheduledAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    created: true,
  })),
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => Object.assign(Promise.resolve([]), {
          limit: vi.fn(() => Promise.resolve([]))
        }))
      }))
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn(() => Promise.resolve([{
          id: 'profile-001',
          orgId: '00000000-0000-0000-0000-000000000000',
          name: 'Nightly Scan',
          subnets: ['10.0.2.0/24'],
          methods: ['ping', 'arp'],
          schedule: { type: 'interval', intervalMinutes: 30 }
        }]))
      }))
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve())
      }))
    })),
    delete: vi.fn(() => ({
      where: vi.fn(() => Promise.resolve())
    })),
    transaction: vi.fn(async (fn: any) => fn({
      select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => Promise.resolve([])) })) })),
      delete: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })),
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          onConflictDoUpdate: vi.fn(() => Promise.resolve()),
        })),
      })),
    }))
  },
  withDbAccessContext: vi.fn(async (_ctx: any, fn: any) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: any) => fn()),
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  SYSTEM_DB_ACCESS_CONTEXT: { scope: 'system', orgId: null, accessibleOrgIds: null }
}));

vi.mock('../db/schema', () => ({
  discoveryProfiles: { id: 'discoveryProfiles.id', orgId: 'discoveryProfiles.orgId', siteId: 'discoveryProfiles.siteId' },
  discoveryJobs: { id: 'discoveryJobs.id' },
  discoveredAssets: { id: 'discoveredAssets.id', orgId: 'discoveredAssets.orgId', siteId: 'discoveredAssets.siteId' },
  networkTopology: { orgId: 'orgId' },
  topologyLayout: {
    orgId: 'topologyLayout.orgId',
    siteId: 'topologyLayout.siteId',
    nodeType: 'topologyLayout.nodeType',
    nodeId: 'topologyLayout.nodeId',
  },
  networkMonitors: {},
  snmpDevices: {},
  snmpAlertThresholds: {},
  snmpMetrics: {},
  discoveredAssetTypeEnum: {
    enumValues: ['unknown', 'router', 'switch', 'firewall', 'access_point', 'workstation', 'server']
  },
  networkEventTypeEnum: {
    enumValues: ['new_device', 'device_disappeared', 'device_changed', 'rogue_device']
  },
  devices: {
    id: 'devices.id',
    orgId: 'devices.orgId',
    siteId: 'devices.siteId',
    agentId: 'devices.agentId',
    status: 'devices.status'
  },
  patchPolicies: {},
  alertRules: {},
  backupConfigs: {},
  securityPolicies: {},
  automationPolicies: {},
  maintenanceWindows: {},
  softwarePolicies: {},
  sensitiveDataPolicies: {},
  peripheralPolicies: {}
}));

// Persistent record of requirePermission(resource, action) wiring. Lives in a
// vi.hoisted block so it survives vi.clearAllMocks() — the discovery route module
// creates its gates at import time (module top-level), before any test/beforeEach
// runs, so the import-time call would otherwise be cleared away.
const { requirePermissionWiring } = vi.hoisted(() => ({
  requirePermissionWiring: [] as Array<[string, string]>,
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    const restrict = c.req.header('x-restrict-site');
    c.set('auth', {
      user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
      scope: 'organization',
      orgId: '00000000-0000-0000-0000-000000000000',
      partnerId: null,
      canAccessOrg: (orgId: string) => orgId === '00000000-0000-0000-0000-000000000000'
    });
    c.set('permissions', restrict ? {
      permissions: [{ resource: 'devices', action: 'read' }],
      partnerId: null,
      orgId: '00000000-0000-0000-0000-000000000000',
      roleId: 'role-1',
      scope: 'organization',
      allowedSiteIds: restrict === '__empty__' ? [] : [restrict],
    } : undefined);
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn((resource: string, action: string) => {
    requirePermissionWiring.push([resource, action]);
    return async (_c: any, next: any) => next();
  }),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next())
}));

describe('discovery routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/discovery', discoveryRoutes);
  });

  describe('GET /discovery/topology', () => {
    it('should return topology nodes and edges for the org', async () => {
      const res = await app.request('/discovery/topology', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.nodes).toEqual([]);
      expect(body.edges).toEqual([]);
      // Subnet definitions are surfaced so the client can group by the correct
      // mask instead of fabricating edges (issue #1325).
      expect(body.subnets).toEqual([]);
    });

    it('surfaces measured-edge provenance (method/confidence/interfaceName/vlan) on edges (#1728)', async () => {
      // The /topology handler issues several db.select() calls (assets, edges,
      // profiles). Branch on the table passed to .from() so only the
      // networkTopology query returns a measured row; everything else stays empty.
      const topologyRow = {
        id: 'edge-1',
        sourceId: 'asset-a',
        targetId: 'asset-b',
        connectionType: 'infra',
        sourceType: 'discovered_asset',
        targetType: 'discovered_asset',
        bandwidth: null,
        latency: null,
        lastVerifiedAt: new Date('2026-06-22T00:00:00.000Z'),
        method: 'lldp',
        confidence: 'high',
        interfaceName: 'Gi0/1',
        vlan: 10,
      };

      vi.mocked(db.select).mockImplementation(((...args: any[]) => {
        // db.select({ subnets: ... }) for the profile CIDRs — return empty.
        if (args.length > 0) {
          return {
            from: vi.fn(() => ({ where: vi.fn(() => Promise.resolve([])) })),
          } as any;
        }
        // db.select().from(table).where(...) — branch on the table identity.
        return {
          from: vi.fn((table: any) => ({
            where: vi.fn(() =>
              Promise.resolve(table === networkTopology ? [topologyRow] : [])
            ),
          })),
        } as any;
      }) as any);

      const res = await app.request('/discovery/topology', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.edges).toHaveLength(1);
      expect(body.edges[0]).toMatchObject({
        id: 'edge-1',
        method: 'lldp',
        confidence: 'high',
        interfaceName: 'Gi0/1',
        vlan: 10,
      });
    });

    it('returns saved node positions in a `layout` array mapped from topology_layout (#1728)', async () => {
      const layoutRow = {
        id: 'layout-1',
        orgId: 'org-1',
        siteId: 'site-1',
        nodeType: 'discovered_asset',
        nodeId: 'asset-a',
        x: 120.5,
        y: 240.25,
        pinned: true,
        updatedBy: 'user-1',
        updatedAt: new Date('2026-06-22T00:00:00.000Z'),
      };

      vi.mocked(db.select).mockImplementation(((...args: any[]) => {
        // db.select({ subnets: ... }) for the profile CIDRs — return empty.
        if (args.length > 0) {
          return {
            from: vi.fn(() => ({ where: vi.fn(() => Promise.resolve([])) })),
          } as any;
        }
        // db.select().from(table).where(...) — branch on the table identity.
        return {
          from: vi.fn((table: any) => ({
            where: vi.fn(() =>
              Promise.resolve(table === topologyLayout ? [layoutRow] : [])
            ),
          })),
        } as any;
      }) as any);

      const res = await app.request('/discovery/topology', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.layout).toHaveLength(1);
      expect(body.layout[0]).toEqual({
        nodeType: 'discovered_asset',
        nodeId: 'asset-a',
        x: 120.5,
        y: 240.25,
        pinned: true,
      });
    });

    it('includes each node\'s siteId so the client can scope the layout PATCH (#1728)', async () => {
      const assetRow = {
        id: 'asset-a',
        orgId: 'org-1',
        siteId: 'site-1',
        assetType: 'switch',
        label: 'Core Switch',
        hostname: 'sw-core',
        ipAddress: '10.0.0.1',
        macAddress: 'aa:bb:cc:dd:ee:ff',
        isOnline: true,
        approvalStatus: 'approved',
      };

      vi.mocked(db.select).mockImplementation(((...args: any[]) => {
        // db.select({ subnets: ... }) for the profile CIDRs — return empty.
        if (args.length > 0) {
          return {
            from: vi.fn(() => ({ where: vi.fn(() => Promise.resolve([])) })),
          } as any;
        }
        // db.select().from(table).where(...) — branch on the table identity.
        return {
          from: vi.fn((table: any) => ({
            where: vi.fn(() =>
              Promise.resolve(table === discoveredAssets ? [assetRow] : [])
            ),
          })),
        } as any;
      }) as any);

      const res = await app.request('/discovery/topology', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.nodes).toHaveLength(1);
      expect(body.nodes[0].siteId).toBe('site-1');
    });
  });

  describe('PATCH /discovery/topology/layout', () => {
    const validBody = {
      siteId: '00000000-0000-0000-0000-000000000001',
      positions: [
        {
          nodeType: 'discovered_asset' as const,
          nodeId: '00000000-0000-0000-0000-000000000020',
          x: 100.5,
          y: 200.25,
        },
        {
          nodeType: 'discovered_asset' as const,
          nodeId: '00000000-0000-0000-0000-000000000021',
          x: 300,
          y: 400,
        },
      ],
    };

    it('is gated by requirePermission(topology, write) at the route module', () => {
      // The gate const is created at import time; assert the wiring was recorded.
      expect(requirePermissionWiring).toContainEqual(['topology', 'write']);
    });

    it('upserts positions keyed on (site_id, node_type, node_id) with pinned=true and updated_by=auth.user.id', async () => {
      const insertValues: any[] = [];
      const conflictArgs: any[] = [];
      (db.transaction as any).mockImplementationOnce(async (fn: any) =>
        fn({
          insert: vi.fn(() => ({
            values: vi.fn((v: any) => {
              insertValues.push(v);
              return {
                onConflictDoUpdate: vi.fn((args: any) => {
                  conflictArgs.push(args);
                  return Promise.resolve();
                }),
              };
            }),
          })),
        }),
      );

      const res = await app.request('/discovery/topology/layout', {
        method: 'PATCH',
        headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
        body: JSON.stringify(validBody),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ upserted: 2 });

      expect(insertValues).toHaveLength(2);
      expect(insertValues[0]).toMatchObject({
        orgId: '00000000-0000-0000-0000-000000000000',
        siteId: '00000000-0000-0000-0000-000000000001',
        nodeType: 'discovered_asset',
        nodeId: '00000000-0000-0000-0000-000000000020',
        x: 100.5,
        y: 200.25,
        pinned: true,
        updatedBy: 'user-123',
      });

      // upsert keyed on (site_id, node_type, node_id), sets pinned=true + updatedBy
      expect(conflictArgs[0].target).toEqual([
        topologyLayout.siteId,
        topologyLayout.nodeType,
        topologyLayout.nodeId,
      ]);
      expect(conflictArgs[0].set).toMatchObject({
        x: 100.5,
        y: 200.25,
        pinned: true,
        updatedBy: 'user-123',
      });
    });

    it('returns 403 when a site-restricted caller targets an out-of-scope site', async () => {
      const res = await app.request('/discovery/topology/layout', {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer token',
          'Content-Type': 'application/json',
          'x-restrict-site': '00000000-0000-0000-0000-000000000099',
        },
        body: JSON.stringify(validBody),
      });

      expect(res.status).toBe(403);
    });

    it('rejects an empty positions array (min 1)', async () => {
      const res = await app.request('/discovery/topology/layout', {
        method: 'PATCH',
        headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ siteId: validBody.siteId, positions: [] }),
      });

      expect(res.status).toBe(400);
    });
  });

  describe('GET /discovery/assets site-scope', () => {
    it('returns 403 when a site-restricted caller filters to an out-of-scope site', async () => {
      const res = await app.request('/discovery/assets?siteId=00000000-0000-0000-0000-000000000099', {
        headers: { 'x-restrict-site': '00000000-0000-0000-0000-000000000001' },
      });

      expect(res.status).toBe(403);
    });

    it('returns an empty asset list when the site allowlist is empty', async () => {
      const res = await app.request('/discovery/assets', {
        headers: { 'x-restrict-site': '__empty__' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toEqual([]);
    });

    // Regression: GET /discovery/assets must project snmp_data so the detail
    // modal can render it. It was collected + stored but dropped here (#1731).
    it('projects snmpData in the asset list response', async () => {
      const now = new Date();
      const snmp = { sysName: 'core-sw-01', sysDescr: 'Cisco IOS', sysObjectId: '1.3.6.1.4.1.9.1.1' };
      const row = {
        asset: {
          id: 'asset-001',
          orgId: '00000000-0000-0000-0000-000000000000',
          assetType: 'switch',
          approvalStatus: 'pending',
          isOnline: true,
          hostname: 'core-sw-01',
          label: null,
          ipAddress: '10.0.2.1',
          macAddress: 'aa:bb:cc:dd:ee:ff',
          manufacturer: 'Cisco',
          model: 'C9300',
          openPorts: [],
          snmpData: snmp,
          responseTimeMs: 2,
          linkedDeviceId: null,
          discoveryMethods: ['ping', 'snmp'],
          notes: null,
          tags: [],
          firstSeenAt: now,
          lastSeenAt: now,
          createdAt: now,
          updatedAt: now,
        },
        snmpMonitoringEnabled: false,
        networkMonitoringEnabled: false,
        linkedDeviceHostname: null,
        linkedDeviceDisplayName: null,
        profileId: null,
        profileName: null,
        profileSubnets: null,
      };

      (db.select as any).mockReturnValueOnce({
        from: () => ({
          leftJoin: () => ({
            leftJoin: () => ({
              leftJoin: () => ({
                where: () => ({
                  orderBy: () => Promise.resolve([row]),
                }),
              }),
            }),
          }),
        }),
      });

      const res = await app.request('/discovery/assets', {
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].snmpData).toEqual(snmp);
      expect(body.data[0].discoveryMethods).toEqual(['ping', 'snmp']);
    });
  });

  describe('POST /discovery/scan', () => {
    it('should queue a discovery scan for a profile', async () => {
      const profileId = '00000000-0000-0000-0000-000000000099';

      // Mock profile lookup to return a valid profile
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: profileId,
              orgId: '00000000-0000-0000-0000-000000000000',
              siteId: '00000000-0000-0000-0000-000000000001',
              name: 'Test Profile',
              subnets: ['10.0.0.0/24'],
              methods: ['ping'],
            }]),
          }),
        }),
      } as any);

      // Enable Redis so enqueue path succeeds
      vi.mocked(isRedisAvailable).mockReturnValueOnce(true);

      const res = await app.request('/discovery/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ profileId })
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.id).toBe('job-001');
      expect(body.status).toBe('scheduled');
    });

    it('rejects requested agents from a different site', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{
                id: '00000000-0000-0000-0000-000000000010',
                orgId: '00000000-0000-0000-0000-000000000000',
                siteId: '00000000-0000-0000-0000-000000000001',
              }]),
            }),
          }),
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{
                id: '00000000-0000-0000-0000-000000000011',
                orgId: '00000000-0000-0000-0000-000000000000',
                siteId: '00000000-0000-0000-0000-000000000099',
                agentId: '00000000-0000-0000-0000-000000000012',
                status: 'online'
              }]),
            }),
          }),
        } as any);

      const res = await app.request('/discovery/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          profileId: '00000000-0000-0000-0000-000000000010',
          agentId: '00000000-0000-0000-0000-000000000012'
        })
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toContain('same site');
    });
  });

  describe('POST /discovery/assets/:id/link', () => {
    it('rejects linking an asset to a device from a different site', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{
                id: '00000000-0000-0000-0000-000000000020',
                orgId: '00000000-0000-0000-0000-000000000000',
                siteId: '00000000-0000-0000-0000-000000000001'
              }]),
            }),
          }),
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{
                id: '00000000-0000-0000-0000-000000000021',
                orgId: '00000000-0000-0000-0000-000000000000',
                siteId: '00000000-0000-0000-0000-000000000099'
              }]),
            }),
          }),
        } as any);

      const res = await app.request('/discovery/assets/00000000-0000-0000-0000-000000000020/link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ deviceId: '00000000-0000-0000-0000-000000000021' })
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toContain('same site');
    });
  });

  describe('GET /discovery/profiles', () => {
    // Regression: the Changes tab differentiates "Alerting disabled" from "no
    // changes yet" using each profile's alertSettings, so the list response must
    // project alertSettings (#1729).
    it('projects alertSettings in the profile list response', async () => {
      const now = new Date();
      const row = {
        profile: {
          id: 'profile-001',
          orgId: '00000000-0000-0000-0000-000000000000',
          siteId: '00000000-0000-0000-0000-000000000001',
          name: 'Nightly Scan',
          description: null,
          enabled: true,
          subnets: ['10.0.2.0/24'],
          methods: ['ping'],
          schedule: { type: 'manual' },
          deepScan: false,
          resolveHostnames: true,
          alertSettings: {
            enabled: false,
            alertOnNew: true,
            alertOnDisappeared: true,
            alertOnChanged: true,
            changeRetentionDays: 90
          },
          createdAt: now,
          updatedAt: now,
        },
        lastRunAt: null,
      };

      (db.select as any).mockReturnValueOnce({
        from: () => ({
          where: () => ({
            orderBy: () => Promise.resolve([row]),
          }),
        }),
      });

      const res = await app.request('/discovery/profiles', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].alertSettings).toEqual(row.profile.alertSettings);
    });

    it('returns alertSettings as null when a profile has none', async () => {
      const now = new Date();
      const row = {
        profile: {
          id: 'profile-002',
          orgId: '00000000-0000-0000-0000-000000000000',
          siteId: '00000000-0000-0000-0000-000000000001',
          name: 'Legacy Scan',
          description: null,
          enabled: true,
          subnets: ['10.0.3.0/24'],
          methods: ['ping'],
          schedule: { type: 'manual' },
          deepScan: false,
          resolveHostnames: true,
          alertSettings: null,
          createdAt: now,
          updatedAt: now,
        },
        lastRunAt: null,
      };

      (db.select as any).mockReturnValueOnce({
        from: () => ({
          where: () => ({
            orderBy: () => Promise.resolve([row]),
          }),
        }),
      });

      const res = await app.request('/discovery/profiles', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data[0].alertSettings).toBeNull();
    });
  });

  describe('POST /discovery/profiles', () => {
    it('should create a discovery profile with schedule configuration', async () => {
      const res = await app.request('/discovery/profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          name: 'Nightly Scan',
          siteId: '00000000-0000-0000-0000-000000000001',
          subnets: ['10.0.2.0/24'],
          methods: ['ping', 'arp'],
          schedule: { type: 'interval', intervalMinutes: 30 }
        })
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.name).toBe('Nightly Scan');
      expect(body.subnets).toEqual(['10.0.2.0/24']);
      expect(body.schedule.type).toBe('interval');
      expect(body.schedule.intervalMinutes).toBe(30);
    });

    it('encrypts and masks SNMP profile secrets', async () => {
      const insertValues = vi.fn(() => ({
        returning: vi.fn(() => Promise.resolve([{
          id: 'profile-001',
          orgId: '00000000-0000-0000-0000-000000000000',
          siteId: '00000000-0000-0000-0000-000000000001',
          name: 'SNMP Scan',
          subnets: ['10.0.2.0/24'],
          methods: ['snmp'],
          snmpCommunities: ['enc:v1:mock'],
          snmpCredentials: { authPassphrase: 'enc:v1:mock-auth' },
          schedule: { type: 'interval', intervalMinutes: 30 },
          createdAt: new Date('2026-05-01T00:00:00.000Z'),
          updatedAt: new Date('2026-05-01T00:00:00.000Z'),
        }]))
      }));
      vi.mocked(db.insert).mockReturnValueOnce({
        values: insertValues,
      } as any);

      const res = await app.request('/discovery/profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          name: 'SNMP Scan',
          siteId: '00000000-0000-0000-0000-000000000001',
          subnets: ['10.0.2.0/24'],
          methods: ['snmp'],
          snmpCommunities: ['private'],
          snmpCredentials: { version: 'v3', username: 'poller', authPassphrase: 'auth-secret' },
          schedule: { type: 'interval', intervalMinutes: 30 }
        })
      });

      expect(res.status).toBe(201);
      const saved = (insertValues.mock.calls as any)[0]?.[0];
      expect(saved).toBeDefined();
      expect(isEncryptedSecret(saved.snmpCommunities[0])).toBe(true);
      expect(decryptSecret(saved.snmpCommunities[0])).toBe('private');
      expect(decryptSecret(saved.snmpCredentials.authPassphrase)).toBe('auth-secret');
      const body = await res.json();
      expect(body.snmpCommunities).toEqual(['********']);
      expect(body.snmpCredentials.authPassphrase).toBe('********');
    });

    it('should validate schedule details', async () => {
      const res = await app.request('/discovery/profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          subnets: ['10.0.3.0/24'],
          methods: ['ping'],
          schedule: { type: 'interval' }
        })
      });

      expect(res.status).toBe(400);
    });
  });

  describe('POST /discovery/jobs/:id/cancel — multi-org partner', () => {
    const ORG_A = '11111111-1111-1111-1111-111111111111';
    const ORG_B = '22222222-2222-2222-2222-222222222222';
    const JOB_ID = '33333333-3333-3333-3333-333333333333';
    const accessibleOrgIds = [ORG_A, ORG_B];

    const usePartnerAuth = () => {
      vi.mocked(authMiddleware).mockImplementationOnce((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-partner', email: 'partner@example.com', name: 'Partner User' },
          scope: 'partner',
          orgId: null,
          partnerId: 'partner-1',
          accessibleOrgIds,
          canAccessOrg: (orgId: string) => accessibleOrgIds.includes(orgId)
        });
        return next();
      });
    };

    it('cancels a scheduled job when the selected orgId is supplied as a query param', async () => {
      usePartnerAuth();

      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ id: JOB_ID, orgId: ORG_A, status: 'scheduled' }])
          })
        })
      } as any);

      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{
              id: JOB_ID,
              orgId: ORG_A,
              status: 'cancelled',
              createdAt: new Date('2026-05-18T00:00:00.000Z'),
              scheduledAt: null,
              startedAt: null,
              completedAt: new Date('2026-05-18T00:01:00.000Z')
            }])
          })
        })
      } as any);

      const res = await app.request(`/discovery/jobs/${JOB_ID}/cancel?orgId=${ORG_A}`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token' }
      });

      const body = await res.json();
      expect(body.error).not.toBe('orgId is required when partner has multiple organizations');
      expect(res.status).toBe(200);
      expect(body.status).toBe('cancelled');
    });

    it('denies cancelling against an org the partner cannot access', async () => {
      usePartnerAuth();

      const res = await app.request(
        `/discovery/jobs/${JOB_ID}/cancel?orgId=99999999-9999-9999-9999-999999999999`,
        { method: 'POST', headers: { Authorization: 'Bearer token' } }
      );

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toContain('denied');
    });
  });

  describe('POST /discovery/assets/bulk-approve — multi-org partner', () => {
    const ORG_A = '11111111-1111-1111-1111-111111111111';
    const ORG_B = '22222222-2222-2222-2222-222222222222';
    const ASSET_ID = '44444444-4444-4444-4444-444444444444';
    const accessibleOrgIds = [ORG_A, ORG_B];

    const usePartnerAuth = () => {
      vi.mocked(authMiddleware).mockImplementationOnce((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-partner', email: 'partner@example.com', name: 'Partner User' },
          scope: 'partner',
          orgId: null,
          partnerId: 'partner-1',
          accessibleOrgIds,
          canAccessOrg: (orgId: string) => accessibleOrgIds.includes(orgId)
        });
        return next();
      });
    };

    it('scopes the bulk approve to the supplied orgId for a multi-org partner', async () => {
      usePartnerAuth();

      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: ASSET_ID }])
          })
        })
      } as any);

      const res = await app.request(`/discovery/assets/bulk-approve?orgId=${ORG_A}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ assetIds: [ASSET_ID] })
      });

      const body = await res.json();
      expect(body.error).not.toBe('orgId is required when partner has multiple organizations');
      expect(res.status).toBe(200);
      expect(body.approvedCount).toBe(1);
    });

    it('denies bulk approve against an org the partner cannot access', async () => {
      usePartnerAuth();

      const res = await app.request(
        '/discovery/assets/bulk-approve?orgId=99999999-9999-9999-9999-999999999999',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
          body: JSON.stringify({ assetIds: [ASSET_ID] })
        }
      );

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toContain('denied');
    });
  });

  describe('POST /discovery/jobs/:id/cancel — org-scoped user (no regression)', () => {
    // The default mocked auth is scope:'organization', orgId 00000000-...-000000000000.
    const OWN_ORG = '00000000-0000-0000-0000-000000000000';
    const JOB_ID = '55555555-5555-5555-5555-555555555555';

    it('still cancels the org user’s own job when no orgId query param is sent', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ id: JOB_ID, orgId: OWN_ORG, status: 'scheduled' }])
          })
        })
      } as any);

      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{
              id: JOB_ID,
              orgId: OWN_ORG,
              status: 'cancelled',
              createdAt: new Date('2026-05-19T00:00:00.000Z'),
              scheduledAt: null,
              startedAt: null,
              completedAt: new Date('2026-05-19T00:01:00.000Z')
            }])
          })
        })
      } as any);

      const res = await app.request(`/discovery/jobs/${JOB_ID}/cancel`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('cancelled');
    });

    it('rejects an org user that forwards a mismatched orgId query param', async () => {
      const res = await app.request(
        `/discovery/jobs/${JOB_ID}/cancel?orgId=11111111-1111-1111-1111-111111111111`,
        { method: 'POST', headers: { Authorization: 'Bearer token' } }
      );

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toContain('denied');
    });
  });

  describe('site-scope authz (app-layer, RLS does not defend)', () => {
    const ORG = '00000000-0000-0000-0000-000000000000';
    const ASSET_IN = '00000000-0000-0000-0000-0000000000a0';
    const SITE_IN = '00000000-0000-0000-0000-0000000000s1';
    const SITE_OUT = '00000000-0000-0000-0000-0000000000s9';
    const DEVICE_ID = '00000000-0000-0000-0000-0000000000d1';

    function setSiteRestrictedAuth(allowedSiteIds: string[] | undefined) {
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
          scope: 'organization',
          orgId: ORG,
          partnerId: null,
          canAccessOrg: (orgId: string) => orgId === ORG,
          accessibleOrgIds: null
        });
        c.set('permissions', allowedSiteIds ? { allowedSiteIds } : {});
        return next();
      });
    }

    function mockAssetThenDevice(asset: any, device: any) {
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([asset]),
            }),
          }),
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([device]),
            }),
          }),
        } as any);
    }

    describe('POST /assets/:id/link', () => {
      it('rejects when the asset is in a site outside the caller allowlist', async () => {
        setSiteRestrictedAuth([SITE_IN]);
        mockAssetThenDevice(
          { id: ASSET_IN, orgId: ORG, siteId: SITE_OUT },
          { id: DEVICE_ID, orgId: ORG, siteId: SITE_OUT }
        );

        const res = await app.request(`/discovery/assets/${ASSET_IN}/link`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
          body: JSON.stringify({ deviceId: DEVICE_ID })
        });

        expect(res.status).toBe(403);
        const body = await res.json();
        expect(body.error).toBe('Access to this site denied');
        expect(db.update).not.toHaveBeenCalled();
      });

      it('blocks linking when the target device site is outside the caller allowlist', async () => {
        // Asset and device share an out-of-scope site (the same-site invariant
        // holds), so the link must still be refused for a site-restricted caller.
        setSiteRestrictedAuth([SITE_IN]);
        mockAssetThenDevice(
          { id: ASSET_IN, orgId: ORG, siteId: SITE_OUT },
          { id: DEVICE_ID, orgId: ORG, siteId: SITE_OUT }
        );

        const res = await app.request(`/discovery/assets/${ASSET_IN}/link`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
          body: JSON.stringify({ deviceId: DEVICE_ID })
        });

        expect(res.status).toBe(403);
        const body = await res.json();
        expect(body.error).toBe('Access to this site denied');
      });

      it('allows linking when both asset and device sites are in the allowlist', async () => {
        setSiteRestrictedAuth([SITE_IN]);
        mockAssetThenDevice(
          { id: ASSET_IN, orgId: ORG, siteId: SITE_IN },
          { id: DEVICE_ID, orgId: ORG, siteId: SITE_IN }
        );
        vi.mocked(db.update).mockReturnValueOnce({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{ id: ASSET_IN, orgId: ORG, linkedDeviceId: DEVICE_ID }])
            })
          })
        } as any);

        const res = await app.request(`/discovery/assets/${ASSET_IN}/link`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
          body: JSON.stringify({ deviceId: DEVICE_ID })
        });

        expect(res.status).toBe(200);
      });

      it('does not gate when the caller is unrestricted (no allowedSiteIds)', async () => {
        setSiteRestrictedAuth(undefined);
        mockAssetThenDevice(
          { id: ASSET_IN, orgId: ORG, siteId: SITE_OUT },
          { id: DEVICE_ID, orgId: ORG, siteId: SITE_OUT }
        );
        vi.mocked(db.update).mockReturnValueOnce({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{ id: ASSET_IN, orgId: ORG, linkedDeviceId: DEVICE_ID }])
            })
          })
        } as any);

        const res = await app.request(`/discovery/assets/${ASSET_IN}/link`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
          body: JSON.stringify({ deviceId: DEVICE_ID })
        });

        expect(res.status).toBe(200);
      });
    });

    describe('DELETE /assets/:id', () => {
      function mockAssetOnly(asset: any) {
        vi.mocked(db.select).mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([asset]),
            }),
          }),
        } as any);
      }

      it('rejects deleting an asset in a site outside the caller allowlist', async () => {
        setSiteRestrictedAuth([SITE_IN]);
        mockAssetOnly({ id: ASSET_IN, orgId: ORG, hostname: 'h', ipAddress: '10.0.0.1', siteId: SITE_OUT });

        const res = await app.request(`/discovery/assets/${ASSET_IN}`, {
          method: 'DELETE',
          headers: { Authorization: 'Bearer token' }
        });

        expect(res.status).toBe(403);
        const body = await res.json();
        expect(body.error).toBe('Access to this site denied');
      });

      it('allows deleting an asset whose site is in the allowlist', async () => {
        setSiteRestrictedAuth([SITE_IN]);
        mockAssetOnly({ id: ASSET_IN, orgId: ORG, hostname: 'h', ipAddress: '10.0.0.1', siteId: SITE_IN });
        vi.mocked(db.transaction).mockImplementationOnce(async (fn: any) => fn({
          select: vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }) }),
          delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) })
        }));

        const res = await app.request(`/discovery/assets/${ASSET_IN}`, {
          method: 'DELETE',
          headers: { Authorization: 'Bearer token' }
        });

        expect(res.status).toBe(200);
      });

      it('deletes saved topology_layout rows for the asset within the delete transaction (#1728)', async () => {
        setSiteRestrictedAuth(undefined);
        mockAssetOnly({ id: ASSET_IN, orgId: ORG, hostname: 'h', ipAddress: '10.0.0.1', siteId: SITE_OUT });
        const txDelete = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
        vi.mocked(db.transaction).mockImplementationOnce(async (fn: any) => fn({
          select: vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }) }),
          delete: txDelete,
        }));

        const res = await app.request(`/discovery/assets/${ASSET_IN}`, {
          method: 'DELETE',
          headers: { Authorization: 'Bearer token' }
        });

        expect(res.status).toBe(200);
        // The transaction must issue a delete against the topology_layout table.
        const deletedTables = txDelete.mock.calls.map((call) => call[0]);
        expect(deletedTables).toContain(topologyLayout);
      });

      it('does not gate deletion when the caller is unrestricted', async () => {
        setSiteRestrictedAuth(undefined);
        mockAssetOnly({ id: ASSET_IN, orgId: ORG, hostname: 'h', ipAddress: '10.0.0.1', siteId: SITE_OUT });
        vi.mocked(db.transaction).mockImplementationOnce(async (fn: any) => fn({
          select: vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }) }),
          delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) })
        }));

        const res = await app.request(`/discovery/assets/${ASSET_IN}`, {
          method: 'DELETE',
          headers: { Authorization: 'Bearer token' }
        });

        expect(res.status).toBe(200);
      });
    });
  });
});
