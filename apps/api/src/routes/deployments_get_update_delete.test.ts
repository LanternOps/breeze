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
      orgId: '11111111-1111-1111-1111-111111111111',
      partnerId: null,
      accessibleOrgIds: ['11111111-1111-1111-1111-111111111111'],
      canAccessOrg: (orgId: string) => orgId === '11111111-1111-1111-1111-111111111111'
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

});
