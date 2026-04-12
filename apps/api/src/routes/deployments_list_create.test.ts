import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { deploymentRoutes } from './deployments';

const DEPLOYMENT_ID_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DEPLOYMENT_ID_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DEVICE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ORG_ID = '11111111-1111-1111-1111-111111111111';
const ORG_ID_2 = '22222222-2222-2222-2222-222222222222';
const PARTNER_ID = '33333333-3333-3333-3333-333333333333';

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
    displayName: 'displayName'
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
      return next();
    });
    app = new Hono();
    app.route('/deployments', deploymentRoutes);
  });

  // ----------------------------------------------------------------
  // GET / - List deployments
  // ----------------------------------------------------------------
  describe('GET /deployments', () => {
    it('should list deployments with pagination', async () => {
      const deps = [makeDeployment(), makeDeployment({ id: DEPLOYMENT_ID_2, name: 'Deploy Patch' })];
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ count: 2 }])
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockReturnValue({
                  offset: vi.fn().mockResolvedValue(deps)
                })
              })
            })
          })
        } as any);

      const res = await app.request('/deployments', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(2);
      expect(body.total).toBe(2);
    });

    it('should filter by status', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ count: 1 }])
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockReturnValue({
                  offset: vi.fn().mockResolvedValue([makeDeployment({ status: 'completed' })])
                })
              })
            })
          })
        } as any);

      const res = await app.request('/deployments?status=completed', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
    });

    it('should return empty for org with no orgId', async () => {
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
          scope: 'organization',
          orgId: null,
          partnerId: null,
          accessibleOrgIds: [],
          canAccessOrg: () => false
        });
        return next();
      });

      const res = await app.request('/deployments', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toEqual([]);
      expect(body.total).toBe(0);
    });
  });

  // ----------------------------------------------------------------
  // POST / - Create deployment
  // ----------------------------------------------------------------
  describe('POST /deployments', () => {
    it('should create a deployment in draft status', async () => {
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
      const body = await res.json();
      expect(body.data.id).toBe(DEPLOYMENT_ID_1);
      expect(body.data.status).toBe('draft');
    });

    it('should reject when org user has no orgId', async () => {
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
          scope: 'organization',
          orgId: null,
          partnerId: null,
          accessibleOrgIds: [],
          canAccessOrg: () => false
        });
        return next();
      });

      const res = await app.request('/deployments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify(validCreatePayload)
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toContain('Organization context required');
    });

    it('should require orgId for partner with multiple orgs', async () => {
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-456', email: 'partner@example.com', name: 'Partner User' },
          scope: 'partner',
          orgId: null,
          partnerId: PARTNER_ID,
          accessibleOrgIds: [ORG_ID, ORG_ID_2],
          canAccessOrg: (orgId: string) => [ORG_ID, ORG_ID_2].includes(orgId)
        });
        return next();
      });

      const res = await app.request('/deployments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify(validCreatePayload)
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('orgId is required');
    });

    it('should reject partner creating deployment for inaccessible org', async () => {
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

      const res = await app.request('/deployments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ ...validCreatePayload, orgId: ORG_ID_2 })
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toContain('Access to this organization denied');
    });

    it('should require orgId for system scope', async () => {
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'admin-1', email: 'admin@example.com', name: 'Admin' },
          scope: 'system',
          orgId: null,
          partnerId: null,
          accessibleOrgIds: null,
          canAccessOrg: () => true
        });
        return next();
      });

      const res = await app.request('/deployments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify(validCreatePayload)
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('orgId is required');
    });

    it('should validate required fields', async () => {
      const res = await app.request('/deployments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ name: 'Missing fields' })
      });

      expect(res.status).toBe(400);
    });
  });

});
