import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { deploymentRoutes } from './deployments';

const DEPLOYMENT_ID_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DEPLOYMENT_ID_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DEVICE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ORG_ID = '11111111-1111-1111-1111-111111111111';
const ORG_ID_2 = '22222222-2222-2222-2222-222222222222';
const PARTNER_ID = '33333333-3333-3333-3333-333333333333';
const SITE_ALLOWED = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

vi.mock('../services', () => ({}));

vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: vi.fn()
}));

vi.mock('../services/deploymentEngine', () => ({
  initializeDeployment: vi.fn().mockResolvedValue({ success: true, deviceCount: 5 }),
  getDeploymentProgress: vi.fn().mockResolvedValue({
    total: 5,
    pending: 3,
    running: 1,
    completed: 1,
    failed: 0,
    skipped: 0
  }),
  pauseDeployment: vi.fn().mockResolvedValue(undefined),
  resumeDeployment: vi.fn().mockResolvedValue(undefined),
  cancelDeployment: vi.fn().mockResolvedValue(undefined),
  incrementRetryCount: vi.fn().mockResolvedValue({ canRetry: true, retryCount: 1 })
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn()
  }
,
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db/schema', () => ({
  deployments: {
    id: 'id',
    orgId: 'orgId',
    name: 'name',
    type: 'type',
    payload: 'payload',
    targetType: 'targetType',
    targetConfig: 'targetConfig',
    schedule: 'schedule',
    rolloutConfig: 'rolloutConfig',
    status: 'status',
    createdBy: 'createdBy',
    createdAt: 'createdAt',
    startedAt: 'startedAt',
    completedAt: 'completedAt'
  },
  deploymentDevices: {
    id: 'id',
    deploymentId: 'deploymentId',
    deviceId: 'deviceId',
    batchNumber: 'batchNumber',
    status: 'status',
    retryCount: 'retryCount',
    maxRetries: 'maxRetries',
    startedAt: 'startedAt',
    completedAt: 'completedAt',
    result: 'result'
  },
  devices: {
    id: 'devices.id',
    hostname: 'hostname',
    displayName: 'displayName',
    siteId: 'devices.siteId'
  }
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
      scope: 'organization',
      orgId: '11111111-1111-1111-1111-111111111111',
      partnerId: null,
      accessibleOrgIds: ['11111111-1111-1111-1111-111111111111'],
      canAccessOrg: (orgId: string) => orgId === '11111111-1111-1111-1111-111111111111'
    });
    const restrictedSite = c.req.header('x-restrict-site');
    if (restrictedSite) c.set('permissions', { allowedSiteIds: [restrictedSite] });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next())
}));

import { db } from '../db';
import { authMiddleware } from '../middleware/auth';
import { initializeDeployment, getDeploymentProgress, pauseDeployment, cancelDeployment, incrementRetryCount } from '../services/deploymentEngine';

function makeDeployment(overrides: Record<string, unknown> = {}) {
  return {
    id: DEPLOYMENT_ID_1,
    orgId: ORG_ID,
    name: 'Deploy Agent v2.5',
    type: 'agent_update',
    payload: { version: '2.5.0' },
    targetType: 'devices',
    targetConfig: { type: 'devices', deviceIds: [DEVICE_ID] },
    schedule: null,
    rolloutConfig: { type: 'immediate', respectMaintenanceWindows: false },
    status: 'draft',
    createdBy: 'user-123',
    createdAt: new Date('2026-01-01'),
    startedAt: null,
    completedAt: null,
    ...overrides
  };
}

const validCreatePayload = {
  name: 'Deploy Agent v2.5',
  type: 'agent_update',
  payload: { version: '2.5.0' },
  targetType: 'devices' as const,
  targetConfig: { type: 'devices' as const, deviceIds: [DEVICE_ID] },
  rolloutConfig: { type: 'immediate' as const, respectMaintenanceWindows: false }
};

function conditionText(value: unknown): string {
  return JSON.stringify(value, (_key, nested) =>
    typeof nested === 'function' ? '[function]' : nested
  );
}


describe('deployment routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
      c.set('auth', {
        user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
        scope: 'organization',
        orgId: ORG_ID,
        partnerId: null,
        accessibleOrgIds: [ORG_ID],
        canAccessOrg: (orgId: string) => orgId === ORG_ID
      });
      const restrictedSite = c.req.header('x-restrict-site');
      if (restrictedSite) c.set('permissions', { allowedSiteIds: [restrictedSite] });
      return next();
    });
    app = new Hono();
    app.route('/deployments', deploymentRoutes);
  });

  // ----------------------------------------------------------------
  // GET /:id/devices - List deployment devices
  // ----------------------------------------------------------------
  describe('GET /deployments/:id/devices', () => {
    it('should list devices in a deployment', async () => {
      vi.mocked(db.select)
        // getDeploymentWithAccess
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([makeDeployment()])
            })
          })
        } as any)
        // count
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ count: 1 }])
          })
        } as any)
        // device list
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            leftJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                orderBy: vi.fn().mockReturnValue({
                  limit: vi.fn().mockReturnValue({
                    offset: vi.fn().mockResolvedValue([{
                      id: 'dd-1',
                      deploymentId: DEPLOYMENT_ID_1,
                      deviceId: DEVICE_ID,
                      batchNumber: 1,
                      status: 'pending',
                      retryCount: 0,
                      maxRetries: 3,
                      startedAt: null,
                      completedAt: null,
                      result: null,
                      hostname: 'host-1',
                      displayName: 'Host 1'
                    }])
                  })
                })
              })
            })
          })
        } as any);

      const res = await app.request(`/deployments/${DEPLOYMENT_ID_1}/devices`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].deviceId).toBe(DEVICE_ID);
      expect(body.total).toBe(1);
    });

    it('narrows deployment devices and count to devices in the caller site allowlist', async () => {
      let countWhere: unknown;
      let listWhere: unknown;

      vi.mocked(db.select)
        // getDeploymentWithAccess
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([makeDeployment()])
            })
          })
        } as any)
        // count with device join
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn((condition: unknown) => {
                countWhere = condition;
                return Promise.resolve([{ count: 0 }]);
              })
            })
          })
        } as any)
        // device list
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            leftJoin: vi.fn().mockReturnValue({
              where: vi.fn((condition: unknown) => {
                listWhere = condition;
                return {
                  orderBy: vi.fn().mockReturnValue({
                    limit: vi.fn().mockReturnValue({
                      offset: vi.fn().mockResolvedValue([])
                    })
                  })
                };
              })
            })
          })
        } as any);

      const res = await app.request(`/deployments/${DEPLOYMENT_ID_1}/devices`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token', 'x-restrict-site': SITE_ALLOWED }
      });

      expect(res.status).toBe(200);
      expect(conditionText(countWhere)).toContain('devices.siteId');
      expect(conditionText(countWhere)).toContain(SITE_ALLOWED);
      expect(conditionText(listWhere)).toContain('devices.siteId');
      expect(conditionText(listWhere)).toContain(SITE_ALLOWED);
    });

    it('should return 404 for non-existent deployment', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([])
          })
        })
      } as any);

      const res = await app.request(`/deployments/${DEPLOYMENT_ID_1}/devices`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(404);
    });
  });

  // ----------------------------------------------------------------
  // POST /:id/devices/:deviceId/retry - Retry failed device
  // ----------------------------------------------------------------
  describe('POST /deployments/:id/devices/:deviceId/retry', () => {
    it('should retry a failed device', async () => {
      vi.mocked(db.select)
        // getDeploymentWithAccess
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([makeDeployment({ status: 'installing' })])
            })
          })
        } as any)
        // find deployment device
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{
                id: 'dd-1',
                deploymentId: DEPLOYMENT_ID_1,
                deviceId: DEVICE_ID,
                status: 'failed',
                retryCount: 0,
                maxRetries: 3
              }])
            })
          })
        } as any)
        // fetch updated device record
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            leftJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([{
                  id: 'dd-1',
                  deploymentId: DEPLOYMENT_ID_1,
                  deviceId: DEVICE_ID,
                  batchNumber: 1,
                  status: 'pending',
                  retryCount: 1,
                  maxRetries: 3,
                  startedAt: null,
                  completedAt: null,
                  result: null,
                  hostname: 'host-1',
                  displayName: 'Host 1'
                }])
              })
            })
          })
        } as any);

      const res = await app.request(`/deployments/${DEPLOYMENT_ID_1}/devices/${DEVICE_ID}/retry`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.retryCount).toBe(1);
      expect(vi.mocked(incrementRetryCount)).toHaveBeenCalledWith(DEPLOYMENT_ID_1, DEVICE_ID);
    });

    it('should reject retrying non-failed device', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([makeDeployment()])
            })
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{
                id: 'dd-1',
                deploymentId: DEPLOYMENT_ID_1,
                deviceId: DEVICE_ID,
                status: 'completed',
                retryCount: 0,
                maxRetries: 3
              }])
            })
          })
        } as any);

      const res = await app.request(`/deployments/${DEPLOYMENT_ID_1}/devices/${DEVICE_ID}/retry`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('Only failed devices');
    });

    it('should reject when device not in deployment', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([makeDeployment()])
            })
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([])
            })
          })
        } as any);

      const res = await app.request(`/deployments/${DEPLOYMENT_ID_1}/devices/${DEVICE_ID}/retry`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toContain('Device not found');
    });

    it('should reject when max retries exceeded', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([makeDeployment()])
            })
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{
                id: 'dd-1',
                deploymentId: DEPLOYMENT_ID_1,
                deviceId: DEVICE_ID,
                status: 'failed',
                retryCount: 3,
                maxRetries: 3
              }])
            })
          })
        } as any);
      vi.mocked(incrementRetryCount).mockResolvedValueOnce({ canRetry: false, retryCount: 3 });

      const res = await app.request(`/deployments/${DEPLOYMENT_ID_1}/devices/${DEVICE_ID}/retry`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('Maximum retry count');
    });
  });

  // ----------------------------------------------------------------
  // Multi-tenant isolation for partner
  // ----------------------------------------------------------------
  describe('partner scope multi-tenant isolation', () => {
    beforeEach(() => {
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-456', email: 'partner@example.com', name: 'Partner User' },
          scope: 'partner',
          orgId: null,
          partnerId: PARTNER_ID,
          accessibleOrgIds: [ORG_ID],
          canAccessOrg: (orgId: string) => orgId === ORG_ID
        });
        return next();
      });
    });

    it('should auto-select org for partner with single org', async () => {
      vi.mocked(db.insert).mockReturnValueOnce({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([makeDeployment()])
        })
      } as any);

      const res = await app.request('/deployments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify(validCreatePayload)
      });

      expect(res.status).toBe(201);
    });

    it('should deny access to deployment in inaccessible org', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([makeDeployment({ orgId: ORG_ID_2 })])
          })
        })
      } as any);

      const res = await app.request(`/deployments/${DEPLOYMENT_ID_1}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(404);
    });
  });

});

// ------------------------------------------------------------------
// Site axis on the deployment LIST and GET (review #6110)
//
// `GET /:id/devices` and the device retry action both carry the site axis, but
// `GET /` and `GET /:id` filtered on orgId alone — so a site-restricted tech saw
// every deployment in the org by name, type, target config and progress, and
// only lost the per-device breakdown. A deployment is site-attributable through
// its member devices; one with NO members is unattributable and denied.
// ------------------------------------------------------------------
describe('deployment site axis on list/get (review #6110)', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks does NOT drain a pending mockReturnValueOnce queue; an
    // earlier describe block can leave entries behind and every test here would
    // then read someone else's chain shape.
    vi.mocked(db.select).mockReset();
    vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
      c.set('auth', {
        user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
        scope: 'organization',
        orgId: ORG_ID,
        partnerId: null,
        accessibleOrgIds: [ORG_ID],
        canAccessOrg: (orgId: string) => orgId === ORG_ID
      });
      const restrictedSite = c.req.header('x-restrict-site');
      if (restrictedSite) c.set('permissions', { allowedSiteIds: [restrictedSite] });
      return next();
    });
    app = new Hono();
    app.route('/deployments', deploymentRoutes);
  });

  /** Restricted-caller list: full scan, then one batched membership query. */
  function mockRestrictedList(rows: unknown[], members: unknown[]) {
    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ orderBy: vi.fn().mockResolvedValue(rows) })
        })
      } as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          leftJoin: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(members) })
        })
      } as any);
  }

  it('hides a deployment whose members sit in another site', async () => {
    mockRestrictedList(
      [makeDeployment(), makeDeployment({ id: DEPLOYMENT_ID_2, name: 'Other site' })],
      [
        { deploymentId: DEPLOYMENT_ID_1, deviceId: DEVICE_ID, siteId: SITE_ALLOWED },
        { deploymentId: DEPLOYMENT_ID_2, deviceId: 'd-out', siteId: 'site-other' }
      ]
    );

    const res = await app.request('/deployments', { headers: { 'x-restrict-site': SITE_ALLOWED } });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.map((d: any) => d.id)).toEqual([DEPLOYMENT_ID_1]);
    expect(body.total).toBe(1);
    expect(JSON.stringify(body)).not.toContain('Other site');
  });

  it('hides a ZERO-member deployment from a restricted caller', async () => {
    mockRestrictedList([makeDeployment()], []);

    const res = await app.request('/deployments', { headers: { 'x-restrict-site': SITE_ALLOWED } });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([]);
    expect(body.total).toBe(0);
  });

  it('paginates the FILTERED set — page 2 holds the next visible rows', async () => {
    const visible = Array.from({ length: 4 }, (_, i) => makeDeployment({ id: `in-${i}`, name: `In ${i}` }));
    const rows = visible.flatMap((row, i) => [makeDeployment({ id: `out-${i}`, name: `Out ${i}` }), row]);
    const members = rows.map((row: any) => ({
      deploymentId: row.id,
      deviceId: `dev-${row.id}`,
      siteId: String(row.id).startsWith('in-') ? SITE_ALLOWED : 'site-other'
    }));
    mockRestrictedList(rows, members);

    const res = await app.request('/deployments?limit=2&offset=2', { headers: { 'x-restrict-site': SITE_ALLOWED } });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.map((d: any) => d.id)).toEqual(['in-2', 'in-3']);
    expect(body.total).toBe(4);
  });

  it('leaves the unrestricted list path untouched (count + page, no membership query)', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([{ count: 2 }]) })
      } as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                offset: vi.fn().mockResolvedValue([makeDeployment(), makeDeployment({ id: DEPLOYMENT_ID_2 })])
              })
            })
          })
        })
      } as any);

    const res = await app.request('/deployments');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(2);
    expect(body.total).toBe(2);
    expect(vi.mocked(db.select)).toHaveBeenCalledTimes(2);
  });

  /** GET /:id: deployment lookup, then (restricted only) the membership query. */
  function mockGetById(members?: unknown[]) {
    const chain = vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([makeDeployment({ status: 'running' })]) })
      })
    } as any);
    if (members) {
      chain.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          leftJoin: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(members) })
        })
      } as any);
    }
  }

  it('GET /:id 404s a deployment reaching another site', async () => {
    mockGetById([{ deploymentId: DEPLOYMENT_ID_1, deviceId: 'd-out', siteId: 'site-other' }]);

    const res = await app.request(`/deployments/${DEPLOYMENT_ID_1}`, { headers: { 'x-restrict-site': SITE_ALLOWED } });

    expect(res.status).toBe(404);
  });

  it('GET /:id 404s a ZERO-member deployment for a restricted caller', async () => {
    mockGetById([]);

    const res = await app.request(`/deployments/${DEPLOYMENT_ID_1}`, { headers: { 'x-restrict-site': SITE_ALLOWED } });

    expect(res.status).toBe(404);
  });

  it('GET /:id still serves a deployment confined to the caller site', async () => {
    mockGetById([{ deploymentId: DEPLOYMENT_ID_1, deviceId: DEVICE_ID, siteId: SITE_ALLOWED }]);

    const res = await app.request(`/deployments/${DEPLOYMENT_ID_1}`, { headers: { 'x-restrict-site': SITE_ALLOWED } });

    expect(res.status).toBe(200);
    expect((await res.json()).data.id).toBe(DEPLOYMENT_ID_1);
  });

  it('GET /:id runs no membership query for an unrestricted caller', async () => {
    mockGetById();

    const res = await app.request(`/deployments/${DEPLOYMENT_ID_1}`);

    expect(res.status).toBe(200);
    expect(vi.mocked(db.select)).toHaveBeenCalledTimes(1);
  });
});
