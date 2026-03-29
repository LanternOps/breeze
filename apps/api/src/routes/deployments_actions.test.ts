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

});
