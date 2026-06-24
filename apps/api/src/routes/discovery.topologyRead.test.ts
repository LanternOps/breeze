import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { discoveryRoutes } from './discovery';
import { db } from '../db';
import { networkTopology, topologyManualNodes } from '../db/schema';

vi.mock('../services', () => ({}));

vi.mock('../services/auditEvents', () => ({
  writeAuditEvent: vi.fn(),
  writeRouteAudit: vi.fn(),
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
  createDiscoveryJobIfIdle: vi.fn(async () => ({ job: {}, created: true })),
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve([])),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([])) })),
    })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })) })),
    delete: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })),
    transaction: vi.fn(async (fn: any) => fn({})),
  },
  withDbAccessContext: vi.fn(async (_ctx: any, fn: any) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: any) => fn()),
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  SYSTEM_DB_ACCESS_CONTEXT: { scope: 'system', orgId: null, accessibleOrgIds: null },
}));

vi.mock('../db/schema', () => ({
  discoveryProfiles: { id: 'discoveryProfiles.id', orgId: 'discoveryProfiles.orgId', siteId: 'discoveryProfiles.siteId' },
  discoveryJobs: { id: 'discoveryJobs.id' },
  discoveredAssets: { id: 'discoveredAssets.id', orgId: 'discoveredAssets.orgId', siteId: 'discoveredAssets.siteId' },
  networkTopology: { orgId: 'networkTopology.orgId' },
  topologyLayout: {
    orgId: 'topologyLayout.orgId',
    siteId: 'topologyLayout.siteId',
    nodeType: 'topologyLayout.nodeType',
    nodeId: 'topologyLayout.nodeId',
  },
  topologyManualNodes: {
    id: 'topologyManualNodes.id',
    orgId: 'topologyManualNodes.orgId',
    siteId: 'topologyManualNodes.siteId',
    label: 'topologyManualNodes.label',
    role: 'topologyManualNodes.role',
  },
  networkMonitors: {},
  snmpDevices: {},
  snmpAlertThresholds: {},
  snmpMetrics: {},
  discoveredAssetTypeEnum: {
    enumValues: ['unknown', 'router', 'switch', 'firewall', 'access_point', 'workstation', 'server'],
  },
  networkEventTypeEnum: {
    enumValues: ['new_device', 'device_disappeared', 'device_changed', 'rogue_device'],
  },
  devices: { id: 'devices.id', orgId: 'devices.orgId', siteId: 'devices.siteId', agentId: 'devices.agentId', status: 'devices.status' },
  patchPolicies: {},
  alertRules: {},
  backupConfigs: {},
  securityPolicies: {},
  automationPolicies: {},
  maintenanceWindows: {},
  softwarePolicies: {},
  sensitiveDataPolicies: {},
  peripheralPolicies: {},
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
      scope: 'organization',
      orgId: '00000000-0000-0000-0000-000000000000',
      partnerId: null,
      canAccessOrg: (orgId: string) => orgId === '00000000-0000-0000-0000-000000000000',
    });
    c.set('permissions', undefined);
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
}));

describe('GET /discovery/topology — manual nodes + edge provenance (#1728 phase 4)', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/discovery', discoveryRoutes);
  });

  it('includes manual nodes (kind:manual) and surfaces method/confidence on manual + measured edges', async () => {
    const manualNodeRow = {
      id: 'mn-1',
      orgId: 'org-1',
      siteId: 'site-1',
      label: 'core-sw',
      role: 'switch',
      notes: null,
      createdBy: 'user-1',
      createdAt: new Date('2026-06-22T00:00:00.000Z'),
      updatedAt: new Date('2026-06-22T00:00:00.000Z'),
    };

    const manualEdgeRow = {
      id: 'edge-manual',
      sourceId: 'mn-1',
      targetId: 'asset-a',
      connectionType: 'manual',
      sourceType: 'manual_node',
      targetType: 'discovered_asset',
      bandwidth: null,
      latency: null,
      lastVerifiedAt: null,
      method: 'manual',
      confidence: 'asserted',
      interfaceName: null,
      vlan: null,
      createdBy: 'user-1',
    };

    const fdbEdgeRow = {
      id: 'edge-fdb',
      sourceId: 'asset-a',
      targetId: 'asset-b',
      connectionType: 'infra',
      sourceType: 'discovered_asset',
      targetType: 'discovered_asset',
      bandwidth: null,
      latency: null,
      lastVerifiedAt: new Date('2026-06-22T00:00:00.000Z'),
      method: 'fdb',
      confidence: 'high',
      interfaceName: 'Gi0/1',
      vlan: 10,
      createdBy: null,
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
          where: vi.fn(() => {
            if (table === networkTopology) return Promise.resolve([manualEdgeRow, fdbEdgeRow]);
            if (table === topologyManualNodes) return Promise.resolve([manualNodeRow]);
            return Promise.resolve([]);
          }),
        })),
      } as any;
    }) as any);

    const res = await app.request('/discovery/topology', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    // Manual node present with kind:'manual' and type derived from role.
    expect(body.nodes).toContainEqual(
      expect.objectContaining({ id: 'mn-1', kind: 'manual', type: 'switch', label: 'core-sw' }),
    );

    // Manual edge carries method:'manual', confidence:'asserted', createdBy.
    expect(body.edges).toContainEqual(
      expect.objectContaining({
        id: 'edge-manual',
        method: 'manual',
        confidence: 'asserted',
        createdBy: 'user-1',
      }),
    );

    // Measured (fdb) edge still present with its provenance.
    expect(body.edges).toContainEqual(
      expect.objectContaining({ id: 'edge-fdb', method: 'fdb', confidence: 'high' }),
    );
  });

  it('tags discovered nodes with kind:discovered', async () => {
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

    const { discoveredAssets } = await import('../db/schema');

    vi.mocked(db.select).mockImplementation(((...args: any[]) => {
      if (args.length > 0) {
        return {
          from: vi.fn(() => ({ where: vi.fn(() => Promise.resolve([])) })),
        } as any;
      }
      return {
        from: vi.fn((table: any) => ({
          where: vi.fn(() => Promise.resolve(table === discoveredAssets ? [assetRow] : [])),
        })),
      } as any;
    }) as any);

    const res = await app.request('/discovery/topology', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.nodes).toContainEqual(
      expect.objectContaining({ id: 'asset-a', kind: 'discovered' }),
    );
  });
});
