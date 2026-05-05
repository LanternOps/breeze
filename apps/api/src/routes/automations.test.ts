import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { createHmac } from 'crypto';
import { automationRoutes, automationWebhookRoutes } from './automations';

vi.mock('../jobs/automationWorker', () => ({
  enqueueAutomationRun: vi.fn(async () => ({ enqueued: true, jobId: 'job-1' }))
}));

vi.mock('../services/redis', () => ({
  getRedis: vi.fn(() => null)
}));

vi.mock('../services/automationRuntime', () => ({
  AutomationValidationError: class AutomationValidationError extends Error {},
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
  })),
  normalizeAutomationActions: vi.fn((actions) => actions),
  normalizeAutomationTrigger: vi.fn((trigger) => trigger),
  normalizeNotificationTargets: vi.fn((targets) => targets ?? {}),
  withWebhookDefaults: vi.fn((trigger) => trigger),
}));

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
  },
  runOutsideDbContext: vi.fn((fn: () => any) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => any) => fn())
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
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireScope: vi.fn(() => async (_c: any, next: any) => next())
}));

import { db } from '../db';
import { getRedis } from '../services/redis';

describe('automations routes', () => {
  let app: Hono;

	  beforeEach(() => {
	    vi.clearAllMocks();
	    delete process.env.AUTOMATION_WEBHOOK_ALLOW_LEGACY_SECRET;
	    delete process.env.AUTOMATION_WEBHOOK_ALLOW_QUERY_SECRET;
	    delete process.env.AUTOMATION_WEBHOOK_ALLOW_LOCAL_REPLAY_FALLBACK;
	    vi.mocked(getRedis).mockReturnValue(null);
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

  it('encrypts and redacts webhook automation trigger secrets on create', async () => {
    vi.mocked(db.insert).mockReturnValueOnce({
      values: vi.fn((values: any) => ({
        returning: vi.fn(() => Promise.resolve([{
          id: values.id,
          name: values.name,
          orgId: values.orgId,
          trigger: values.trigger,
          enabled: true,
          notificationTargets: {},
          createdAt: new Date(),
          updatedAt: new Date()
        }]))
      }))
    } as any);

    const res = await app.request('/automations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
      body: JSON.stringify({
        name: 'Webhook Automation',
        trigger: { type: 'webhook', secret: 'webhook-secret' },
        actions: [{ type: 'execute_command', command: 'echo ok' }]
      })
    });

    expect(res.status).toBe(201);
    const insertValues = vi.mocked(db.insert).mock.results[0]?.value.values.mock.calls[0][0];
    expect(insertValues.trigger.secret).not.toBe('webhook-secret');
    expect(String(insertValues.trigger.secret)).toMatch(/^enc:v1:/);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain('webhook-secret');
    expect(body.trigger.secret).toEqual({
      redacted: true,
      hasSecret: true,
      masked: '********'
    });
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

	  it('should trigger automation via webhook when signed payload is valid', async () => {
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
	    const rawBody = JSON.stringify({ ping: true });
	    const timestamp = String(Math.floor(Date.now() / 1000));
	    const signature = `sha256=${createHmac('sha256', 'secret-123').update(`${timestamp}.${rawBody}`).digest('hex')}`;

	    const res = await app.request('/automations/webhooks/auto-1', {
	      method: 'POST',
	      headers: {
	        'Content-Type': 'application/json',
	        'x-breeze-timestamp': timestamp,
	        'x-breeze-signature': signature,
	        'x-breeze-event-id': 'event-valid-1',
	      },
	      body: rawBody
	    });

	    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.accepted).toBe(true);
	    expect(body.run.id).toBe('run-1');
	  });

	  it('rejects automation webhook when signed body is modified', async () => {
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
	    const signedBody = JSON.stringify({ ping: true });
	    const sentBody = JSON.stringify({ ping: false });
	    const timestamp = String(Math.floor(Date.now() / 1000));
	    const signature = `sha256=${createHmac('sha256', 'secret-123').update(`${timestamp}.${signedBody}`).digest('hex')}`;

	    const res = await app.request('/automations/webhooks/auto-1', {
	      method: 'POST',
	      headers: {
	        'Content-Type': 'application/json',
	        'x-breeze-timestamp': timestamp,
	        'x-breeze-signature': signature,
	        'x-breeze-event-id': 'event-mutated-1',
	      },
	      body: sentBody
	    });

	    expect(res.status).toBe(401);
	  });

	  it('rejects automation webhook when signature is missing', async () => {
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
	        'x-breeze-timestamp': String(Math.floor(Date.now() / 1000)),
	        'x-breeze-event-id': 'event-missing-signature-1',
	      },
	      body: JSON.stringify({ ping: true })
	    });

	    expect(res.status).toBe(401);
	    await expect(res.json()).resolves.toMatchObject({
	      error: 'Missing webhook signature',
	    });
	  });

	  it('rejects stale signed automation webhooks', async () => {
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
	    const rawBody = JSON.stringify({ ping: true });
	    const timestamp = String(Math.floor((Date.now() - 10 * 60 * 1000) / 1000));
	    const signature = `sha256=${createHmac('sha256', 'secret-123').update(`${timestamp}.${rawBody}`).digest('hex')}`;

	    const res = await app.request('/automations/webhooks/auto-1', {
	      method: 'POST',
	      headers: {
	        'Content-Type': 'application/json',
	        'x-breeze-timestamp': timestamp,
	        'x-breeze-signature': signature,
	        'x-breeze-event-id': 'event-stale-1',
	      },
	      body: rawBody
	    });

	    expect(res.status).toBe(401);
	  });

	  it('rejects duplicate signed automation webhook deliveries', async () => {
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
	    const rawBody = JSON.stringify({ ping: true, id: 'dup' });
	    const timestamp = String(Math.floor(Date.now() / 1000));
	    const signature = `sha256=${createHmac('sha256', 'secret-123').update(`${timestamp}.${rawBody}`).digest('hex')}`;
	    const request = () => app.request('/automations/webhooks/auto-1', {
	      method: 'POST',
	      headers: {
	        'Content-Type': 'application/json',
	        'x-breeze-timestamp': timestamp,
	        'x-breeze-signature': signature,
	        'x-breeze-event-id': 'event-duplicate-1',
	      },
	      body: rawBody
	    });

	    expect((await request()).status).toBe(202);
	    expect((await request()).status).toBe(409);
	  });

	  it('rejects webhook automations without a configured signing secret', async () => {
	    vi.mocked(db.select).mockReturnValue({
	      from: vi.fn().mockReturnValue({
	        where: vi.fn().mockReturnValue({
	          limit: vi.fn().mockResolvedValue([{
	            id: 'auto-1',
	            name: 'Webhook Automation',
	            orgId: 'org-123',
	            enabled: true,
	            trigger: { type: 'webhook' }
	          }])
	        })
	      })
	    } as any);

	    const res = await app.request('/automations/webhooks/auto-1', {
	      method: 'POST',
	      headers: {
	        'Content-Type': 'application/json',
	      },
	      body: JSON.stringify({ ping: true })
	    });

	    expect(res.status).toBe(403);
	  });

	  it('stores signed automation webhook replay nonces in Redis when available', async () => {
	    const redis = {
	      set: vi.fn()
	        .mockResolvedValueOnce('OK')
	        .mockResolvedValueOnce(null)
	    };
	    vi.mocked(getRedis).mockReturnValue(redis as any);
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
	    const rawBody = JSON.stringify({ ping: true, id: 'redis-dup' });
	    const timestamp = String(Math.floor(Date.now() / 1000));
	    const signature = `sha256=${createHmac('sha256', 'secret-123').update(`${timestamp}.${rawBody}`).digest('hex')}`;
	    const request = () => app.request('/automations/webhooks/auto-1', {
	      method: 'POST',
	      headers: {
	        'Content-Type': 'application/json',
	        'x-breeze-timestamp': timestamp,
	        'x-breeze-signature': signature,
	        'x-breeze-event-id': 'event-redis-duplicate-1',
	      },
	      body: rawBody
	    });

	    expect((await request()).status).toBe(202);
	    expect((await request()).status).toBe(409);
	    expect(redis.set).toHaveBeenCalledWith(
	      expect.stringMatching(/^automation-webhook-replay:auto-1:/),
	      '1',
	      'PX',
	      5 * 60 * 1000,
	      'NX',
	    );
	  });

	  it('allows legacy header secret only behind explicit compatibility flag', async () => {
	    process.env.AUTOMATION_WEBHOOK_ALLOW_LEGACY_SECRET = 'true';
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
	  });

	  it('rejects query-string webhook secrets without explicit compatibility flag', async () => {
	    process.env.AUTOMATION_WEBHOOK_ALLOW_LEGACY_SECRET = 'true';
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

	    const res = await app.request('/automations/webhooks/auto-1?secret=secret-123', {
	      method: 'POST',
	      headers: { 'Content-Type': 'application/json' },
	      body: JSON.stringify({ ping: true })
	    });

	    expect(res.status).toBe(401);
	  });

	  it('should reject webhook trigger when secret is invalid', async () => {
	    process.env.AUTOMATION_WEBHOOK_ALLOW_LEGACY_SECRET = 'true';
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
