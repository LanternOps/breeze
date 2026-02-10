import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { automationRoutes, automationWebhookRoutes } from './automations';

vi.mock('../jobs/automationWorker', () => ({
  enqueueAutomationRun: vi.fn(async () => ({ enqueued: true, jobId: 'job-1' }))
}));

vi.mock('../services/automationRuntime', async () => {
  const actual = await vi.importActual<typeof import('../services/automationRuntime')>('../services/automationRuntime');

  return {
    ...actual,
    createAutomationRunRecord: vi.fn(async () => ({
      run: {
        id: 'run-1',
        automationId: 'auto-1',
        triggeredBy: 'manual:user-123',
        status: 'running',
        devicesTargeted: 2,
        devicesSucceeded: 0,
        devicesFailed: 0,
        startedAt: new Date(),
        completedAt: null,
        logs: [],
        createdAt: new Date()
      },
      targetDeviceIds: ['device-1', 'device-2']
    }))
  };
});

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve([]))
        }))
      }))
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn(() => Promise.resolve([]))
      }))
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(() => Promise.resolve([]))
        }))
      }))
    })),
    delete: vi.fn(() => ({
      where: vi.fn(() => Promise.resolve())
    }))
  }
}));

vi.mock('../db/schema', () => ({
  automations: {},
  automationRuns: {},
  policies: {},
  policyCompliance: {},
  organizations: {},
  devices: {},
  scripts: {}
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
      scope: 'organization',
      partnerId: null,
      orgId: 'org-123',
      token: { sub: 'user-123' },
      accessibleOrgIds: ['org-123'],
      canAccessOrg: (orgId: string) => orgId === 'org-123'
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next())
}));

import { db } from '../db';

describe('automations routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/automations/webhooks', automationWebhookRoutes);
    app.route('/automations', automationRoutes);
  });

  it('should list automations with pagination', async () => {
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
                offset: vi.fn().mockResolvedValue([
                  { id: 'auto-1', name: 'Automation One' },
                  { id: 'auto-2', name: 'Automation Two' }
                ])
              })
            })
          })
        })
      } as any);

    const res = await app.request('/automations?limit=10&page=1', {
      method: 'GET',
      headers: { Authorization: 'Bearer valid-token' }
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(2);
    expect(body.pagination.total).toBe(2);
  });

  it('should get an automation by id with run history', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: 'auto-1',
              name: 'Automation One',
              orgId: 'org-123',
              trigger: { type: 'manual' },
              runCount: 3
            }])
          })
        })
      } as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([
                { id: 'run-1', status: 'completed' }
              ])
            })
          })
        })
      } as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{
            totalRuns: 3,
            completedRuns: 2,
            failedRuns: 1,
            partialRuns: 0
          }])
        })
      } as any);

    const res = await app.request('/automations/auto-1', {
      method: 'GET',
      headers: { Authorization: 'Bearer valid-token' }
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe('auto-1');
    expect(body.recentRuns).toHaveLength(1);
    expect(body.statistics.totalRuns).toBe(3);
  });

  it('should create an automation with trigger configuration', async () => {
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{
          id: 'auto-1',
          name: 'Reboot Devices',
          orgId: 'org-123',
          trigger: { type: 'manual' },
          enabled: true
        }])
      })
    } as any);

    const res = await app.request('/automations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
      body: JSON.stringify({
        name: 'Reboot Devices',
        description: 'Reboot on schedule',
        enabled: true,
        trigger: { type: 'manual' },
        conditions: { type: 'all' },
        actions: [{ type: 'run_script', scriptId: 'script-1' }],
        onFailure: 'stop',
        notificationTargets: { emails: ['alerts@example.com'] }
      })
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBe('auto-1');
    expect(body.trigger.type).toBe('manual');
  });

  it('should update automation enabled state', async () => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{
            id: 'auto-1',
            name: 'Automation One',
            orgId: 'org-123',
            enabled: true,
            trigger: { type: 'manual' }
          }])
        })
      })
    } as any);
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{
            id: 'auto-1',
            enabled: false,
            trigger: { type: 'manual' }
          }])
        })
      })
    } as any);

    const res = await app.request('/automations/auto-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
      body: JSON.stringify({
        enabled: false
      })
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(false);
  });

  it('should delete an automation', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: 'auto-1',
              name: 'Automation One',
              orgId: 'org-123'
            }])
          })
        })
      } as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ count: 0 }])
        })
      } as any);
    vi.mocked(db.delete).mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined)
    } as any);

    const res = await app.request('/automations/auto-1', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer valid-token' }
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it('should trigger an automation using configured device targets', async () => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{
            id: 'auto-1',
            name: 'Automation One',
            orgId: 'org-123',
            enabled: true,
            runCount: 0,
            trigger: { type: 'manual' }
          }])
        })
      })
    } as any);

    const res = await app.request('/automations/auto-1/trigger', {
      method: 'POST',
      headers: { Authorization: 'Bearer valid-token' }
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toContain('triggered');
    expect(body.run.devicesTargeted).toBe(2);
  });

  it('should prevent triggering disabled automations', async () => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{
            id: 'auto-1',
            name: 'Automation One',
            orgId: 'org-123',
            enabled: false,
            trigger: { type: 'manual' }
          }])
        })
      })
    } as any);

    const res = await app.request('/automations/auto-1/trigger', {
      method: 'POST',
      headers: { Authorization: 'Bearer valid-token' }
    });

    expect(res.status).toBe(400);
  });

  it('should trigger automation via webhook when secret matches', async () => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{
            id: 'auto-1',
            name: 'Webhook Automation',
            orgId: 'org-123',
            enabled: true,
            trigger: { type: 'webhook', secret: 'secret-123' },
            actions: [{ type: 'execute_command', command: 'echo ok' }]
          }])
        })
      })
    } as any);

    const res = await app.request('/automations/webhooks/auto-1', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-automation-secret': 'secret-123'
      },
      body: JSON.stringify({ ping: true })
    });

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.accepted).toBe(true);
    expect(body.run.id).toBe('run-1');
  });

  it('should reject webhook trigger when secret is invalid', async () => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{
            id: 'auto-1',
            name: 'Webhook Automation',
            orgId: 'org-123',
            enabled: true,
            trigger: { type: 'webhook', secret: 'secret-123' }
          }])
        })
      })
    } as any);

    const res = await app.request('/automations/webhooks/auto-1', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-automation-secret': 'wrong-secret'
      },
      body: JSON.stringify({ ping: true })
    });

    expect(res.status).toBe(401);
  });
});
