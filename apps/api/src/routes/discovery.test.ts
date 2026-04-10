import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { discoveryRoutes } from './discovery';
import { db } from '../db';
import { isRedisAvailable } from '../services/redis';

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

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
      scope: 'organization',
      orgId: '00000000-0000-0000-0000-000000000000',
      partnerId: null,
      canAccessOrg: (orgId: string) => orgId === '00000000-0000-0000-0000-000000000000'
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
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
});
