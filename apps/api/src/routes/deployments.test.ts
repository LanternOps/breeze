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
      orgId: ORG_ID,
      partnerId: null,
      accessibleOrgIds: [ORG_ID],
      canAccessOrg: (orgId: string) => orgId === ORG_ID
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next())
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

  // ----------------------------------------------------------------
  // GET /:id - Get deployment by ID
  // ----------------------------------------------------------------
  describe('GET /deployments/:id', () => {
    it('should return a deployment with progress', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([makeDeployment({ status: 'downloading' })])
          })
        })
      } as any);

      const res = await app.request(`/deployments/${DEPLOYMENT_ID_1}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.id).toBe(DEPLOYMENT_ID_1);
      expect(body.data.progress).toBeDefined();
      expect(body.data.progress.total).toBe(5);
    });

    it('should return deployment without progress when in draft', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([makeDeployment({ status: 'draft' })])
          })
        })
      } as any);

      const res = await app.request(`/deployments/${DEPLOYMENT_ID_1}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.progress).toBeNull();
    });

    it('should return 404 when deployment not found', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([])
          })
        })
      } as any);

      const res = await app.request(`/deployments/${DEPLOYMENT_ID_1}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(404);
    });

    it('should return 404 for deployment in different org (multi-tenant)', async () => {
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

    it('should reject invalid UUID param', async () => {
      const res = await app.request('/deployments/not-a-uuid', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(400);
    });
  });

  // ----------------------------------------------------------------
  // PUT /:id - Update deployment (draft only)
  // ----------------------------------------------------------------
  describe('PUT /deployments/:id', () => {
    it('should update a draft deployment', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([makeDeployment()])
          })
        })
      } as any);
      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([makeDeployment({ name: 'Updated Deploy' })])
          })
        })
      } as any);

      const res = await app.request(`/deployments/${DEPLOYMENT_ID_1}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ name: 'Updated Deploy' })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.name).toBe('Updated Deploy');
    });

    it('should reject update for non-draft deployment', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([makeDeployment({ status: 'downloading' })])
          })
        })
      } as any);

      const res = await app.request(`/deployments/${DEPLOYMENT_ID_1}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ name: 'Should Fail' })
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('draft');
    });

    it('should return 404 for non-existent deployment', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([])
          })
        })
      } as any);

      const res = await app.request(`/deployments/${DEPLOYMENT_ID_1}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ name: 'Updated' })
      });

      expect(res.status).toBe(404);
    });

    it('should return existing deployment when no fields to update', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([makeDeployment()])
          })
        })
      } as any);

      const res = await app.request(`/deployments/${DEPLOYMENT_ID_1}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({})
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.id).toBe(DEPLOYMENT_ID_1);
    });
  });

  // ----------------------------------------------------------------
  // DELETE /:id - Delete deployment (draft only)
  // ----------------------------------------------------------------
  describe('DELETE /deployments/:id', () => {
    it('should delete a draft deployment', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([makeDeployment()])
          })
        })
      } as any);
      vi.mocked(db.delete)
        .mockReturnValueOnce({
          where: vi.fn().mockResolvedValue(undefined)
        } as any)
        .mockReturnValueOnce({
          where: vi.fn().mockResolvedValue(undefined)
        } as any);

      const res = await app.request(`/deployments/${DEPLOYMENT_ID_1}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.id).toBe(DEPLOYMENT_ID_1);
    });

    it('should reject deleting non-draft deployment', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([makeDeployment({ status: 'completed' })])
          })
        })
      } as any);

      const res = await app.request(`/deployments/${DEPLOYMENT_ID_1}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('draft');
    });

    it('should return 404 when deleting non-existent deployment', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([])
          })
        })
      } as any);

      const res = await app.request(`/deployments/${DEPLOYMENT_ID_1}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(404);
    });
  });

  // ----------------------------------------------------------------
  // POST /:id/initialize - Initialize deployment
  // ----------------------------------------------------------------
  describe('POST /deployments/:id/initialize', () => {
    it('should initialize a draft deployment', async () => {
      vi.mocked(db.select)
        // getDeploymentWithAccess
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([makeDeployment()])
            })
          })
        } as any)
        // fetch updated deployment after init
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([makeDeployment({ status: 'pending' })])
            })
          })
        } as any);

      const res = await app.request(`/deployments/${DEPLOYMENT_ID_1}/initialize`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.deviceCount).toBe(5);
      expect(vi.mocked(initializeDeployment)).toHaveBeenCalledWith(DEPLOYMENT_ID_1);
    });

    it('should reject initializing non-draft deployment', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([makeDeployment({ status: 'pending' })])
          })
        })
      } as any);

      const res = await app.request(`/deployments/${DEPLOYMENT_ID_1}/initialize`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('draft');
    });

    it('should return 404 for non-existent deployment', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([])
          })
        })
      } as any);

      const res = await app.request(`/deployments/${DEPLOYMENT_ID_1}/initialize`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(404);
    });

    it('should return error when initialization fails', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([makeDeployment()])
          })
        })
      } as any);
      vi.mocked(initializeDeployment).mockResolvedValueOnce({
        success: false,
        error: 'No target devices found',
        deviceCount: 0
      });

      const res = await app.request(`/deployments/${DEPLOYMENT_ID_1}/initialize`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('No target devices');
    });
  });

  // ----------------------------------------------------------------
  // POST /:id/start - Start deployment
  // ----------------------------------------------------------------
  describe('POST /deployments/:id/start', () => {
    it('should start a pending deployment', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([makeDeployment({ status: 'pending' })])
          })
        })
      } as any);
      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([makeDeployment({ status: 'downloading', startedAt: new Date() })])
          })
        })
      } as any);

      const res = await app.request(`/deployments/${DEPLOYMENT_ID_1}/start`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.status).toBe('downloading');
      expect(body.data.progress).toBeDefined();
    });

    it('should reject starting non-pending deployment', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([makeDeployment({ status: 'draft' })])
          })
        })
      } as any);

      const res = await app.request(`/deployments/${DEPLOYMENT_ID_1}/start`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('pending');
    });
  });

  // ----------------------------------------------------------------
  // POST /:id/pause - Pause deployment
  // ----------------------------------------------------------------
  describe('POST /deployments/:id/pause', () => {
    it('should pause a running deployment', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([makeDeployment({ status: 'downloading' })])
            })
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([makeDeployment({ status: 'pending' })])
            })
          })
        } as any);

      const res = await app.request(`/deployments/${DEPLOYMENT_ID_1}/pause`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      expect(vi.mocked(pauseDeployment)).toHaveBeenCalledWith(DEPLOYMENT_ID_1);
    });

    it('should reject pausing non-running deployment', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([makeDeployment({ status: 'draft' })])
          })
        })
      } as any);

      const res = await app.request(`/deployments/${DEPLOYMENT_ID_1}/pause`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('not in a running state');
    });
  });

  // ----------------------------------------------------------------
  // POST /:id/cancel - Cancel deployment
  // ----------------------------------------------------------------
  describe('POST /deployments/:id/cancel', () => {
    it('should cancel a pending deployment', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([makeDeployment({ status: 'pending' })])
            })
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([makeDeployment({ status: 'cancelled' })])
            })
          })
        } as any);

      const res = await app.request(`/deployments/${DEPLOYMENT_ID_1}/cancel`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      expect(vi.mocked(cancelDeployment)).toHaveBeenCalledWith(DEPLOYMENT_ID_1);
    });

    it('should reject cancelling draft deployment', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([makeDeployment({ status: 'draft' })])
          })
        })
      } as any);

      const res = await app.request(`/deployments/${DEPLOYMENT_ID_1}/cancel`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('Cannot cancel');
    });

    it('should reject cancelling completed deployment', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([makeDeployment({ status: 'completed' })])
          })
        })
      } as any);

      const res = await app.request(`/deployments/${DEPLOYMENT_ID_1}/cancel`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(400);
    });

    it('should reject cancelling already cancelled deployment', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([makeDeployment({ status: 'cancelled' })])
          })
        })
      } as any);

      const res = await app.request(`/deployments/${DEPLOYMENT_ID_1}/cancel`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(400);
    });
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
