import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { discoveryRoutes } from './discovery';
import { db } from '../db';
import { sites, topologyManualNodes, networkTopology, topologyLayout } from '../db/schema';

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

describe('POST /discovery/topology/manual-node (#1728 phase 4)', () => {
  let app: Hono;

  const SITE_ID = '00000000-0000-0000-0000-000000000001';
  const validBody = {
    siteId: SITE_ID,
    label: 'Core Switch',
    role: 'switch' as const,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/discovery', discoveryRoutes);
  });

  it('is gated by requirePermission(topology, write) at the route module', () => {
    expect(requirePermissionWiring).toContainEqual(['topology', 'write']);
  });

  it('inserts with server-derived orgId + createdBy and returns 201', async () => {
    const insertValues: any[] = [];

    // Site lookup returns a matching site row; manual-node insert returns the created row.
    vi.mocked(db.select).mockImplementation(((..._args: any[]) => ({
      from: vi.fn((table: any) => ({
        where: vi.fn(() =>
          Object.assign(Promise.resolve(table === sites ? [{ id: SITE_ID }] : []), {
            limit: vi.fn(() => Promise.resolve(table === sites ? [{ id: SITE_ID }] : [])),
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
                id: 'node-1',
                orgId: '00000000-0000-0000-0000-000000000000',
                siteId: SITE_ID,
                label: 'Core Switch',
                role: 'switch',
                notes: null,
                createdAt: new Date('2026-06-30T00:00:00.000Z'),
              },
            ]),
          ),
        };
      }),
    })) as any);

    const res = await app.request('/discovery/topology/manual-node', {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      // No orgId in the body — it must be server-derived from auth context.
      body: JSON.stringify(validBody),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ id: 'node-1', label: 'Core Switch', role: 'switch' });

    expect(insertValues).toHaveLength(1);
    expect(insertValues[0].table).toBe(topologyManualNodes);
    // org is server-derived (auth.orgId), NOT the body-supplied value.
    expect(insertValues[0].v).toMatchObject({
      orgId: '00000000-0000-0000-0000-000000000000',
      siteId: SITE_ID,
      label: 'Core Switch',
      role: 'switch',
      createdBy: 'user-123',
    });
  });

  it('returns 404 when the site is not in the resolved org', async () => {
    // Site lookup yields no row.
    vi.mocked(db.select).mockImplementation(((..._args: any[]) => ({
      from: vi.fn(() => ({
        where: vi.fn(() =>
          Object.assign(Promise.resolve([]), { limit: vi.fn(() => Promise.resolve([])) }),
        ),
      })),
    })) as any);

    const res = await app.request('/discovery/topology/manual-node', {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    });

    expect(res.status).toBe(404);
  });

  it('returns 403 when a site-restricted caller targets an out-of-scope site', async () => {
    // Site exists in the org, but the caller's allowedSiteIds excludes it.
    vi.mocked(db.select).mockImplementation(((..._args: any[]) => ({
      from: vi.fn((table: any) => ({
        where: vi.fn(() =>
          Object.assign(Promise.resolve(table === sites ? [{ id: SITE_ID }] : []), {
            limit: vi.fn(() => Promise.resolve(table === sites ? [{ id: SITE_ID }] : [])),
          }),
        ),
      })),
    })) as any);

    const res = await app.request('/discovery/topology/manual-node', {
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

  it('returns 400 for an invalid role', async () => {
    const res = await app.request('/discovery/topology/manual-node', {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ siteId: SITE_ID, label: 'X', role: 'mainframe' }),
    });

    expect(res.status).toBe(400);
  });
});

describe('DELETE /discovery/topology/manual-node/:id (#1728 phase 4)', () => {
  let app: Hono;

  const NODE_ID = '00000000-0000-0000-0000-0000000000aa';

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/discovery', discoveryRoutes);
  });

  it('cascades manual edges + layout row and deletes the node in one transaction (200)', async () => {
    // Node lookup yields a visible manual node.
    vi.mocked(db.select).mockImplementation(((..._args: any[]) => ({
      from: vi.fn(() => ({
        where: vi.fn(() =>
          Object.assign(
            Promise.resolve([
              {
                id: NODE_ID,
                orgId: '00000000-0000-0000-0000-000000000000',
                label: 'Core Switch',
              },
            ]),
            {
              limit: vi.fn(() =>
                Promise.resolve([
                  {
                    id: NODE_ID,
                    orgId: '00000000-0000-0000-0000-000000000000',
                    label: 'Core Switch',
                  },
                ]),
              ),
            },
          ),
        ),
      })),
    })) as any);

    const deletedTables: any[] = [];
    let transactionRan = false;
    vi.mocked(db.transaction).mockImplementation((async (fn: any) => {
      transactionRan = true;
      return fn({
        delete: vi.fn((table: any) => {
          deletedTables.push(table);
          return { where: vi.fn(() => Promise.resolve()) };
        }),
      });
    }) as any);

    const res = await app.request(`/discovery/topology/manual-node/${NODE_ID}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true });

    expect(transactionRan).toBe(true);
    // Three networkTopology/topologyLayout deletes (source edges, target edges, layout)
    // plus the node delete — four deletes, all inside the single transaction.
    expect(deletedTables).toHaveLength(4);
    expect(deletedTables).toContain(networkTopology);
    expect(deletedTables).toContain(topologyLayout);
    expect(deletedTables).toContain(topologyManualNodes);
    // networkTopology is deleted twice (source-side and target-side manual edges).
    expect(deletedTables.filter((t) => t === networkTopology)).toHaveLength(2);
  });

  it('returns 404 for an unknown node id', async () => {
    vi.mocked(db.select).mockImplementation(((..._args: any[]) => ({
      from: vi.fn(() => ({
        where: vi.fn(() =>
          Object.assign(Promise.resolve([]), { limit: vi.fn(() => Promise.resolve([])) }),
        ),
      })),
    })) as any);

    const res = await app.request(`/discovery/topology/manual-node/${NODE_ID}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(404);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('returns 404 for a site-restricted caller deleting a node in an out-of-scope site (cross-site IDOR)', async () => {
    // The node lookup resolves a manual node whose siteId is NOT in the caller's
    // allowedSiteIds. RLS scopes by org, not site — the app-layer gate is the
    // only thing blocking the cross-site delete.
    vi.mocked(db.select).mockImplementation(((..._args: any[]) => ({
      from: vi.fn(() => ({
        where: vi.fn(() =>
          Object.assign(Promise.resolve([]), {
            limit: vi.fn(() =>
              Promise.resolve([
                {
                  id: NODE_ID,
                  orgId: '00000000-0000-0000-0000-000000000000',
                  siteId: '00000000-0000-0000-0000-000000000001',
                  label: 'Core Switch',
                },
              ]),
            ),
          }),
        ),
      })),
    })) as any);

    const res = await app.request(`/discovery/topology/manual-node/${NODE_ID}`, {
      method: 'DELETE',
      headers: {
        Authorization: 'Bearer token',
        // Caller restricted to a DIFFERENT site than the node's.
        'x-restrict-site': '00000000-0000-0000-0000-000000000099',
      },
    });

    expect(res.status).toBe(404);
    // The cascade transaction must NOT run for an out-of-scope node.
    expect(db.transaction).not.toHaveBeenCalled();
  });
});
