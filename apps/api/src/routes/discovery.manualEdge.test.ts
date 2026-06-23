import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { discoveryRoutes } from './discovery';
import { db } from '../db';
import { discoveredAssets, topologyManualNodes, networkTopology } from '../db/schema';

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
        where: vi.fn(() =>
          Object.assign(Promise.resolve([]), {
            limit: vi.fn(() => Promise.resolve([])),
          }),
        ),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn(() => Promise.resolve([])),
      })),
    })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })) })),
    delete: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })),
    transaction: vi.fn(async (fn: any) =>
      fn({
        select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => Promise.resolve([])) })) })),
        delete: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })),
        insert: vi.fn(() => ({
          values: vi.fn(() => ({ onConflictDoUpdate: vi.fn(() => Promise.resolve()) })),
        })),
      }),
    ),
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
  networkTopology: {
    id: 'networkTopology.id',
    orgId: 'networkTopology.orgId',
    method: 'networkTopology.method',
  },
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
  },
  sites: { id: 'sites.id', orgId: 'sites.orgId' },
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
      canAccessOrg: (orgId: string) => orgId === '00000000-0000-0000-0000-000000000000',
    });
    c.set('permissions', restrict ? {
      permissions: [{ resource: 'topology', action: 'write' }],
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
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
}));

describe('POST /discovery/topology/manual-edge (#1728 phase 4)', () => {
  let app: Hono;

  const SITE_ID = '00000000-0000-0000-0000-000000000001';
  const ASSET_ID = '00000000-0000-0000-0000-0000000000a1';
  const NODE_ID = '00000000-0000-0000-0000-0000000000b1';

  const validBody = {
    siteId: SITE_ID,
    source: { type: 'manual_node' as const, id: NODE_ID },
    target: { type: 'discovered_asset' as const, id: ASSET_ID },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/discovery', discoveryRoutes);
  });

  it('is gated by requirePermission(topology, write) at the route module', () => {
    expect(requirePermissionWiring).toContainEqual(['topology', 'write']);
  });

  it('inserts a manual edge with method/confidence/createdBy and returns 201', async () => {
    const insertValues: any[] = [];

    // Endpoint existence lookups: manual node + discovered asset both resolve.
    vi.mocked(db.select).mockImplementation(((..._args: any[]) => ({
      from: vi.fn((table: any) => ({
        where: vi.fn(() =>
          Object.assign(Promise.resolve([]), {
            limit: vi.fn(() =>
              Promise.resolve(
                table === topologyManualNodes
                  ? [{ id: NODE_ID }]
                  : table === discoveredAssets
                    ? [{ id: ASSET_ID }]
                    : [],
              ),
            ),
          }),
        ),
      })),
    })) as any);

    vi.mocked(db.insert).mockImplementation(((table: any) => ({
      values: vi.fn((v: any) => {
        insertValues.push({ table, v });
        return {
          returning: vi.fn(() =>
            Promise.resolve([
              {
                id: 'edge-1',
                orgId: '00000000-0000-0000-0000-000000000000',
                siteId: SITE_ID,
                sourceType: 'manual_node',
                sourceId: NODE_ID,
                targetType: 'discovered_asset',
                targetId: ASSET_ID,
                connectionType: 'manual',
                method: 'manual',
                confidence: 'asserted',
                createdBy: 'user-123',
              },
            ]),
          ),
        };
      }),
    })) as any);

    const res = await app.request('/discovery/topology/manual-edge', {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      // No orgId in the body — it must be server-derived from auth context.
      body: JSON.stringify(validBody),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ id: 'edge-1', method: 'manual', confidence: 'asserted' });

    expect(insertValues).toHaveLength(1);
    expect(insertValues[0].table).toBe(networkTopology);
    expect(insertValues[0].v).toMatchObject({
      orgId: '00000000-0000-0000-0000-000000000000',
      siteId: SITE_ID,
      sourceType: 'manual_node',
      sourceId: NODE_ID,
      targetType: 'discovered_asset',
      targetId: ASSET_ID,
      connectionType: 'manual',
      method: 'manual',
      confidence: 'asserted',
      createdBy: 'user-123',
    });
  });

  it('returns 404 when an endpoint is not found in the site', async () => {
    // Manual node resolves, discovered asset does not.
    vi.mocked(db.select).mockImplementation(((..._args: any[]) => ({
      from: vi.fn((table: any) => ({
        where: vi.fn(() =>
          Object.assign(Promise.resolve([]), {
            limit: vi.fn(() =>
              Promise.resolve(table === topologyManualNodes ? [{ id: NODE_ID }] : []),
            ),
          }),
        ),
      })),
    })) as any);

    const res = await app.request('/discovery/topology/manual-edge', {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    });

    expect(res.status).toBe(404);
  });

  it('returns 400 for a self-edge (source === target)', async () => {
    const res = await app.request('/discovery/topology/manual-edge', {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        siteId: SITE_ID,
        source: { type: 'manual_node', id: NODE_ID },
        target: { type: 'manual_node', id: NODE_ID },
      }),
    });

    expect(res.status).toBe(400);
  });

  it('returns 403 when a site-restricted caller targets an out-of-scope site', async () => {
    vi.mocked(db.select).mockImplementation(((..._args: any[]) => ({
      from: vi.fn((table: any) => ({
        where: vi.fn(() =>
          Object.assign(Promise.resolve([]), {
            limit: vi.fn(() =>
              Promise.resolve(
                table === topologyManualNodes
                  ? [{ id: NODE_ID }]
                  : table === discoveredAssets
                    ? [{ id: ASSET_ID }]
                    : [],
              ),
            ),
          }),
        ),
      })),
    })) as any);

    const res = await app.request('/discovery/topology/manual-edge', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer token',
        'Content-Type': 'application/json',
        'x-restrict-site': '00000000-0000-0000-0000-000000000099',
      },
      body: JSON.stringify(validBody),
    });

    expect(res.status).toBe(403);
  });

  it('returns 400 for an invalid endpoint type', async () => {
    const res = await app.request('/discovery/topology/manual-edge', {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        siteId: SITE_ID,
        source: { type: 'mystery', id: NODE_ID },
        target: { type: 'discovered_asset', id: ASSET_ID },
      }),
    });

    expect(res.status).toBe(400);
  });

  it('returns 409 when a manual edge already connects the two nodes (pre-check dupe)', async () => {
    // Endpoint lookups resolve; the networkTopology dupe pre-check also resolves
    // an existing manual edge, so the route returns 409 before inserting.
    vi.mocked(db.select).mockImplementation(((..._args: any[]) => ({
      from: vi.fn((table: any) => ({
        where: vi.fn(() =>
          Object.assign(Promise.resolve([]), {
            limit: vi.fn(() =>
              Promise.resolve(
                table === topologyManualNodes
                  ? [{ id: NODE_ID }]
                  : table === discoveredAssets
                    ? [{ id: ASSET_ID }]
                    : table === networkTopology
                      ? [{ id: 'existing-edge' }]
                      : [],
              ),
            ),
          }),
        ),
      })),
    })) as any);

    const insertSpy = vi.fn(() => ({ values: vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([])) })) }));
    vi.mocked(db.insert).mockImplementation(insertSpy as any);

    const res = await app.request('/discovery/topology/manual-edge', {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/already/i);
    // No insert when a duplicate is detected.
    expect(insertSpy).not.toHaveBeenCalled();
  });
});

describe('DELETE /discovery/topology/manual-edge/:id (#1728 phase 4)', () => {
  let app: Hono;

  const EDGE_ID = '00000000-0000-0000-0000-0000000000e1';

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/discovery', discoveryRoutes);
  });

  it('deletes a method=manual edge and returns 200 { success: true }', async () => {
    // The visibility lookup (filtered to method='manual') resolves the edge.
    vi.mocked(db.select).mockImplementation(((..._args: any[]) => ({
      from: vi.fn(() => ({
        where: vi.fn(() =>
          Object.assign(Promise.resolve([]), {
            limit: vi.fn(() =>
              Promise.resolve([
                {
                  id: EDGE_ID,
                  orgId: '00000000-0000-0000-0000-000000000000',
                  siteId: '00000000-0000-0000-0000-000000000001',
                },
              ]),
            ),
          }),
        ),
      })),
    })) as any);

    const deleteWhere = vi.fn(() => Promise.resolve());
    vi.mocked(db.delete).mockImplementation((() => ({ where: deleteWhere })) as any);

    const res = await app.request(`/discovery/topology/manual-edge/${EDGE_ID}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ success: true });
    // The actual delete fired against networkTopology.
    expect(db.delete).toHaveBeenCalledWith(networkTopology);
    expect(deleteWhere).toHaveBeenCalledTimes(1);
  });

  it('returns 404 for a site-restricted caller deleting an edge in an out-of-scope site (cross-site IDOR)', async () => {
    // The visibility lookup resolves a manual edge whose siteId is NOT in the
    // caller's allowedSiteIds — RLS scopes by org, not site, so the app-layer
    // gate is the only defense.
    vi.mocked(db.select).mockImplementation(((..._args: any[]) => ({
      from: vi.fn(() => ({
        where: vi.fn(() =>
          Object.assign(Promise.resolve([]), {
            limit: vi.fn(() =>
              Promise.resolve([
                {
                  id: EDGE_ID,
                  orgId: '00000000-0000-0000-0000-000000000000',
                  siteId: '00000000-0000-0000-0000-000000000001',
                },
              ]),
            ),
          }),
        ),
      })),
    })) as any);

    const deleteWhere = vi.fn(() => Promise.resolve());
    vi.mocked(db.delete).mockImplementation((() => ({ where: deleteWhere })) as any);

    const res = await app.request(`/discovery/topology/manual-edge/${EDGE_ID}`, {
      method: 'DELETE',
      headers: {
        Authorization: 'Bearer token',
        // Caller restricted to a DIFFERENT site than the edge's.
        'x-restrict-site': '00000000-0000-0000-0000-000000000099',
      },
    });

    expect(res.status).toBe(404);
    // No delete fires for an out-of-scope edge.
    expect(deleteWhere).not.toHaveBeenCalled();
  });

  it('returns 404 for a measured (method=fdb) edge id — the manual filter yields no row', async () => {
    // Visibility lookup is filtered to method='manual'; a measured edge id resolves to nothing.
    vi.mocked(db.select).mockImplementation(((..._args: any[]) => ({
      from: vi.fn(() => ({
        where: vi.fn(() =>
          Object.assign(Promise.resolve([]), {
            limit: vi.fn(() => Promise.resolve([])),
          }),
        ),
      })),
    })) as any);

    const deleteWhere = vi.fn(() => Promise.resolve());
    vi.mocked(db.delete).mockImplementation((() => ({ where: deleteWhere })) as any);

    const res = await app.request(`/discovery/topology/manual-edge/${EDGE_ID}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(404);
    // No delete should fire when nothing is visible.
    expect(deleteWhere).not.toHaveBeenCalled();
  });
});
