import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const { authRef, dbJoinResult, getAlertWithOrgCheckMock } = vi.hoisted(() => ({
  authRef: {
    current: {
      scope: 'partner' as string,
      user: { id: 'u-1', name: 'Tess Tech', email: 'tess@msp.example' },
      partnerId: 'p-1' as string | null,
      orgId: null as string | null,
      accessibleOrgIds: null as string[] | null,
      canAccessOrg: (_id: string) => true as boolean
    }
  },
  dbJoinResult: vi.fn(),
  getAlertWithOrgCheckMock: vi.fn()
}));

// requireScope injects auth here because alertsRoutes gets authMiddleware from
// routes/alerts/index.ts, which this test does not mount.
vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn(async (_c: any, next: any) => next()),
  requireScope: () => async (c: any, next: any) => {
    if (!authRef.current) {
      return c.json({ error: 'Not authenticated' }, 401);
    }
    c.set('auth', authRef.current);
    await next();
  },
  requirePermission: () => async (_c: any, next: any) => next()
}));

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        innerJoin: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn(() => dbJoinResult())
          }))
        })),
        // GET /:id and friends use other chains; tolerate them.
        where: vi.fn(() => ({
          orderBy: vi.fn(() => dbJoinResult()),
          limit: vi.fn(() => dbJoinResult())
        }))
      }))
    }))
  }
}));

vi.mock('../../db/schema', () => ({
  alertRules: {}, alertTemplates: {}, alerts: {}, notificationChannels: {},
  alertNotifications: {}, devices: {},
  tickets: {
    id: 'id', internalNumber: 'internalNumber', subject: 'subject',
    status: 'status', priority: 'priority'
  },
  ticketAlertLinks: {
    ticketId: 'ticketId', alertId: 'alertId', linkType: 'linkType', createdAt: 'createdAt'
  }
}));

vi.mock('./helpers', () => ({
  getPagination: vi.fn(() => ({ page: 1, limit: 50, offset: 0 })),
  ensureOrgAccess: vi.fn(() => true),
  getAlertWithOrgCheck: (...args: unknown[]) => getAlertWithOrgCheckMock(...args)
}));

vi.mock('../../services/alertCooldown', () => ({
  setCooldown: vi.fn(),
  markConfigPolicyRuleCooldown: vi.fn()
}));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
vi.mock('../../services/eventBus', () => ({ publishEvent: vi.fn() }));
vi.mock('../../services/ticketService', () => ({
  createTicketFromAlert: vi.fn(),
  TicketServiceError: class TicketServiceError extends Error { status = 400; }
}));

import { alertsRoutes } from './alerts';

const ALERT_ID = '5d4c3b2a-1111-4222-8333-444455556666';

function makeApp() {
  const app = new Hono();
  app.route('/alerts', alertsRoutes);
  return app;
}

describe('GET /alerts/:id/tickets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authRef.current = {
      scope: 'partner', user: { id: 'u-1', name: 'Tess Tech', email: 'tess@msp.example' },
      partnerId: 'p-1', orgId: null, accessibleOrgIds: null, canAccessOrg: () => true
    } as typeof authRef.current;
  });

  it('returns linked tickets for a visible alert', async () => {
    getAlertWithOrgCheckMock.mockResolvedValue({ id: ALERT_ID, orgId: 'org-1' });
    dbJoinResult.mockResolvedValue([
      {
        id: 't-1', internalNumber: 'T-2026-0042', subject: 'CPU pegged',
        status: 'open', priority: 'high', linkType: 'created_from',
        linkedAt: '2026-06-11T00:00:00.000Z'
      }
    ]);
    const res = await makeApp().request(`/alerts/${ALERT_ID}/tickets`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].internalNumber).toBe('T-2026-0042');
    expect(body.data[0].linkType).toBe('created_from');
  });

  it('returns an empty list when nothing is linked', async () => {
    getAlertWithOrgCheckMock.mockResolvedValue({ id: ALERT_ID, orgId: 'org-1' });
    dbJoinResult.mockResolvedValue([]);
    const res = await makeApp().request(`/alerts/${ALERT_ID}/tickets`);
    expect(res.status).toBe(200);
    expect((await res.json()).data).toHaveLength(0);
  });

  it('404 when the alert is not visible to the caller (cross-org)', async () => {
    getAlertWithOrgCheckMock.mockResolvedValue(null);
    const res = await makeApp().request(`/alerts/${ALERT_ID}/tickets`);
    expect(res.status).toBe(404);
    expect(await res.json()).toHaveProperty('error', 'Alert not found');
  });

  it('400 on a non-uuid alert id', async () => {
    const res = await makeApp().request('/alerts/not-a-uuid/tickets');
    expect(res.status).toBe(400);
  });

  it('401 when unauthenticated', async () => {
    authRef.current = null as unknown as typeof authRef.current;
    const res = await makeApp().request(`/alerts/${ALERT_ID}/tickets`);
    expect(res.status).toBe(401);
  });
});
