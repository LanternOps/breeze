import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { alertRoutes } from './alerts';

const { sendSmsNotificationMock } = vi.hoisted(() => ({
  sendSmsNotificationMock: vi.fn()
}));
const { publishEventMock } = vi.hoisted(() => ({
  publishEventMock: vi.fn().mockResolvedValue('event-1')
}));
const { permissionGate, mfaGate } = vi.hoisted(() => ({
  permissionGate: { deny: false },
  mfaGate: { deny: false }
}));

vi.mock('../services', () => ({}));

vi.mock('../services/notificationSenders/smsSender', async () => {
  const actual = await vi.importActual<typeof import('../services/notificationSenders/smsSender')>('../services/notificationSenders/smsSender');
  return {
    ...actual,
    sendSmsNotification: sendSmsNotificationMock
  };
});

vi.mock('../services/notificationSenders', async () => {
  const actual = await vi.importActual<typeof import('../services/notificationSenders')>('../services/notificationSenders');
  return {
    ...actual,
    sendSmsNotification: sendSmsNotificationMock,
    sendEmailNotification: vi.fn().mockResolvedValue({ success: true }),
    sendWebhookNotification: vi.fn().mockResolvedValue({ success: true }),
    sendPagerDutyNotification: vi.fn().mockResolvedValue({ success: true }),
    testWebhook: vi.fn().mockResolvedValue({ success: true })
  };
});

vi.mock('../services/eventBus', () => ({
  publishEvent: publishEventMock
}));

vi.mock('../services/alertCooldown', () => ({
  setCooldown: vi.fn().mockResolvedValue(undefined),
  markConfigPolicyRuleCooldown: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: vi.fn()
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
  alertRules: {},
  alertTemplates: {},
  alerts: {},
  notificationChannels: {},
  escalationPolicies: {},
  alertNotifications: {},
  devices: {},
  organizations: {}
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      scope: 'organization',
      orgId: '11111111-1111-1111-1111-111111111111',
      partnerId: null,
      user: { id: 'user-123', email: 'test@example.com' },
      accessibleOrgIds: ['11111111-1111-1111-1111-111111111111'],
      canAccessOrg: (orgId: string) => orgId === '11111111-1111-1111-1111-111111111111'
    });
    return next();
  }),
  requireScope: vi.fn(() => (c: any, next: any) => next()),
  requirePermission: vi.fn(() => (c: any, next: any) => {
    if (permissionGate.deny) {
      return c.json({ error: 'Permission denied' }, 403);
    }
    return next();
  }),
  requireMfa: vi.fn(() => (c: any, next: any) => {
    if (mfaGate.deny) {
      return c.json({ error: 'MFA required' }, 403);
    }
    return next();
  })
}));

import { db } from '../db';
import { authMiddleware } from '../middleware/auth';

describe('alert routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    permissionGate.deny = false;
    mfaGate.deny = false;
    sendSmsNotificationMock.mockResolvedValue({
      success: true,
      sentCount: 1,
      failedCount: 0
    });
    vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
      c.set('auth', {
        scope: 'organization',
        orgId: '11111111-1111-1111-1111-111111111111',
        partnerId: null,
        user: { id: 'user-123', email: 'test@example.com' },
        accessibleOrgIds: ['11111111-1111-1111-1111-111111111111'],
        canAccessOrg: (orgId: string) => orgId === '11111111-1111-1111-1111-111111111111'
      });
      return next();
    });
    app = new Hono();
    app.route('/alerts', alertRoutes);
  });

  describe('GET /alerts', () => {
    it('should list alerts with pagination', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ count: 1 }])
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            leftJoin: vi.fn().mockReturnValue({
              leftJoin: vi.fn().mockReturnValue({
                where: vi.fn().mockReturnValue({
                  orderBy: vi.fn().mockReturnValue({
                    limit: vi.fn().mockReturnValue({
                      offset: vi.fn().mockResolvedValue([
                        {
                          id: 'alert-1',
                          status: 'active',
                          severity: 'high',
                          title: 'CPU usage high',
                          message: 'CPU over threshold',
                          deviceHostname: 'device-1',
                          ruleName: 'CPU Alert'
                        }
                      ])
                    })
                  })
                })
              })
            })
          })
        } as any);

      const res = await app.request('/alerts', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].severity).toBe('high');
      expect(body.pagination.total).toBe(1);
    });

    it('should filter alerts by status and severity', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ count: 1 }])
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            leftJoin: vi.fn().mockReturnValue({
              leftJoin: vi.fn().mockReturnValue({
                where: vi.fn().mockReturnValue({
                  orderBy: vi.fn().mockReturnValue({
                    limit: vi.fn().mockReturnValue({
                      offset: vi.fn().mockResolvedValue([
                        {
                          id: 'alert-2',
                          status: 'acknowledged',
                          severity: 'critical',
                          title: 'Disk failure',
                          message: 'Disk error',
                          deviceHostname: 'device-2',
                          ruleName: 'Disk Alert'
                        }
                      ])
                    })
                  })
                })
              })
            })
          })
        } as any);

      const res = await app.request('/alerts?status=acknowledged&severity=critical', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data[0].status).toBe('acknowledged');
      expect(body.data[0].severity).toBe('critical');
    });
  });

  describe('POST /alerts/:id/acknowledge', () => {
    it('should acknowledge an active alert', async () => {
      const alertId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              {
                id: alertId,
                orgId: '11111111-1111-1111-1111-111111111111',
                status: 'active'
              }
            ])
          })
        })
      } as any);
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([
              {
                id: alertId,
                status: 'acknowledged',
                acknowledgedBy: 'user-123'
              }
            ])
          })
        })
      } as any);

      const res = await app.request(`/alerts/${alertId}/acknowledge`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('acknowledged');
      expect(body.acknowledgedBy).toBe('user-123');
    });
  });

  describe('POST /alerts/:id/resolve', () => {
    it('should resolve an alert with a note', async () => {
      const alertId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              {
                id: alertId,
                orgId: '11111111-1111-1111-1111-111111111111',
                status: 'active'
              }
            ])
          })
        })
      } as any);
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([
              {
                id: alertId,
                status: 'resolved',
                resolvedBy: 'user-123',
                resolutionNote: 'Issue fixed'
              }
            ])
          })
        })
      } as any);

      const res = await app.request(`/alerts/${alertId}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ note: 'Issue fixed' })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('resolved');
      expect(body.resolutionNote).toBe('Issue fixed');
    });
  });

  describe('GET /alerts/summary', () => {
    it('should return severity and status breakdowns', async () => {
      const groupByMock1 = vi.fn().mockResolvedValue([
        { severity: 'critical', count: 2 },
        { severity: 'high', count: 1 }
      ]);
      const whereMock1 = vi.fn().mockReturnValue({ groupBy: groupByMock1 });
      const groupByMock2 = vi.fn().mockResolvedValue([
        { status: 'active', count: 2 },
        { status: 'resolved', count: 1 }
      ]);
      const whereMock2 = vi.fn().mockReturnValue({ groupBy: groupByMock2 });

      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: whereMock1
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: whereMock2
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ count: 3 }])
          })
        } as any);

      const res = await app.request('/alerts/summary', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.bySeverity.critical).toBe(2);
      expect(body.bySeverity.high).toBe(1);
      expect(body.bySeverity.medium).toBe(0);
      expect(body.byStatus.active).toBe(2);
      expect(body.byStatus.resolved).toBe(1);
      expect(body.byStatus.acknowledged).toBe(0);
      expect(body.total).toBe(3);
    });
  });

  describe('alert rule notification ownership validation', () => {
    it('rejects creating a rule with notification channels outside the org', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{
                id: '44444444-4444-4444-4444-444444444444',
                orgId: '11111111-1111-1111-1111-111111111111',
                name: 'CPU Template'
              }])
            })
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([])
          })
        } as any);

      const res = await app.request('/alerts/rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          templateId: '44444444-4444-4444-4444-444444444444',
          notificationChannelIds: ['22222222-2222-2222-2222-222222222222']
        })
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('Notification channels must belong to the same organization');
    });

    it('rejects updating a rule with notification channels outside the org', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{
                id: '55555555-5555-5555-5555-555555555555',
                orgId: '11111111-1111-1111-1111-111111111111',
                templateId: '44444444-4444-4444-4444-444444444444',
                name: 'CPU Rule',
                overrideSettings: {}
              }])
            })
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([])
          })
        } as any);

      const res = await app.request('/alerts/rules/55555555-5555-5555-5555-555555555555', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          notificationChannelIds: ['33333333-3333-3333-3333-333333333333']
        })
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('Notification channels must belong to the same organization');
    });
  });

  describe('notification channel webhook validation', () => {
    it('encrypts and redacts credential-bearing channel config on create', async () => {
      vi.mocked(db.insert).mockReturnValueOnce({
        values: vi.fn((values: any) => ({
          returning: vi.fn(() => Promise.resolve([{
            id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            orgId: '11111111-1111-1111-1111-111111111111',
            name: 'PagerDuty',
            type: 'pagerduty',
            config: values.config,
            enabled: true,
            createdAt: new Date(),
            updatedAt: new Date()
          }]))
        }))
      } as any);

      const res = await app.request('/alerts/channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          name: 'PagerDuty',
          type: 'pagerduty',
          config: { routingKey: 'pd-routing-key' },
          enabled: true
        })
      });

      expect(res.status).toBe(201);
      const insertValues = vi.mocked(db.insert).mock.results[0]?.value.values.mock.calls[0][0];
      expect(insertValues.config.routingKey).not.toBe('pd-routing-key');
      expect(String(insertValues.config.routingKey)).toMatch(/^enc:v1:/);
      const body = await res.json();
      expect(JSON.stringify(body)).not.toContain('pd-routing-key');
      expect(body.config.routingKey).toEqual({
        redacted: true,
        hasSecret: true,
        masked: '********'
      });
    });

    it('requires permission and MFA for channel mutations', async () => {
      permissionGate.deny = true;
      const deniedPermission = await app.request('/alerts/channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          name: 'PagerDuty',
          type: 'pagerduty',
          config: { routingKey: 'pd-routing-key' },
          enabled: true
        })
      });
      expect(deniedPermission.status).toBe(403);

      permissionGate.deny = false;
      mfaGate.deny = true;
      const deniedMfa = await app.request('/alerts/channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          name: 'PagerDuty',
          type: 'pagerduty',
          config: { routingKey: 'pd-routing-key' },
          enabled: true
        })
      });
      expect(deniedMfa.status).toBe(403);
    });

    it('rejects creating a webhook channel with an unsafe URL', async () => {
      const res = await app.request('/alerts/channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          name: 'Unsafe webhook',
          type: 'webhook',
          config: { url: 'http://127.0.0.1/webhook' },
          enabled: true
        })
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('Invalid webhook channel configuration');
    });

    it('rejects updating a webhook channel with an unsafe URL', async () => {
      const channelId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: channelId,
              orgId: '11111111-1111-1111-1111-111111111111',
              type: 'webhook'
            }])
          })
        })
      } as any);

      const res = await app.request(`/alerts/channels/${channelId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          config: { url: 'http://169.254.169.254/latest/meta-data' }
        })
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('Invalid webhook channel configuration');
    });

    it('does not return decrypted webhook URLs from channel test details', async () => {
      const channelId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: channelId,
              orgId: '11111111-1111-1111-1111-111111111111',
              name: 'Webhook',
              type: 'webhook',
              config: { url: 'https://hooks.example.com/token/secret-token' }
            }])
          })
        })
      } as any);

      const res = await app.request(`/alerts/channels/${channelId}/test`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(JSON.stringify(body)).not.toContain('secret-token');
      expect(body.testResult.details.url).toEqual({
        redacted: true,
        hasSecret: true,
        masked: '********'
      });
    });
  });

  describe('notification channel sms behavior', () => {
    it('rejects creating an sms channel with invalid phone numbers', async () => {
      const res = await app.request('/alerts/channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          name: 'Invalid SMS',
          type: 'sms',
          config: { phoneNumbers: ['12345'] },
          enabled: true
        })
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('Invalid sms channel configuration');
    });

    it('uses sms sender when testing an sms channel', async () => {
      const smsChannelId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: smsChannelId,
              orgId: '11111111-1111-1111-1111-111111111111',
              name: 'Primary SMS',
              type: 'sms',
              config: { phoneNumbers: ['+15551234567'] }
            }])
          })
        })
      } as any);

      sendSmsNotificationMock.mockResolvedValueOnce({
        success: true,
        sentCount: 1,
        failedCount: 0
      });

      const res = await app.request(`/alerts/channels/${smsChannelId}/test`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      expect(sendSmsNotificationMock).toHaveBeenCalledTimes(1);
      const body = await res.json();
      expect(body.testResult.success).toBe(true);
      expect(body.testResult.message).toContain('Test SMS sent');
    });
  });
});
