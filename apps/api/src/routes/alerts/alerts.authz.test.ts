import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// Regression for Finding #6 (MEDIUM): alert state-change endpoints
// (acknowledge/resolve/suppress/bulk) must gate on an alert RBAC permission in
// addition to scope tier. acknowledge -> ALERTS_ACKNOWLEDGE; resolve/suppress/
// bulk -> ALERTS_WRITE (mirrors the mobile alert routes).

const { authRef, grantedRef } = vi.hoisted(() => ({
  authRef: {
    current: {
      scope: 'organization' as string,
      user: { id: 'u-1', name: 'Reed Only', email: 'reed@org.example' },
      partnerId: null as string | null,
      orgId: 'org-1' as string | null,
      accessibleOrgIds: null as string[] | null,
      canAccessOrg: (_id: string) => true as boolean,
    },
  },
  grantedRef: { current: new Set<string>() },
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn(async (_c: any, next: any) => next()),
  requireScope: () => async (c: any, next: any) => {
    if (!authRef.current) return c.json({ error: 'Not authenticated' }, 401);
    c.set('auth', authRef.current);
    await next();
  },
  requirePermission: (resource: string, action: string) => async (c: any, next: any) => {
    if (!grantedRef.current.has(`${resource}:${action}`)) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    c.set('permissions', {});
    await next();
  },
  requireMfa: () => async (_c: any, next: any) => next(),
}));

vi.mock('../../db', () => ({ db: {} }));
vi.mock('../../db/schema', () => ({
  alertRules: {}, alertTemplates: {}, alerts: {}, notificationChannels: {},
  alertNotifications: {}, devices: {}, tickets: {}, ticketAlertLinks: {},
}));
vi.mock('../../services/alertCooldown', () => ({
  setCooldown: vi.fn(), markConfigPolicyRuleCooldown: vi.fn(),
}));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
vi.mock('../../services/eventBus', () => ({ publishEvent: vi.fn() }));
vi.mock('../../services/ticketService', () => ({
  createTicketFromAlert: vi.fn(),
  TicketServiceError: class TicketServiceError extends Error { status = 400; },
}));
vi.mock('./helpers', () => ({
  getPagination: vi.fn(() => ({ page: 1, limit: 50, offset: 0 })),
  ensureOrgAccess: vi.fn(() => true),
  getAlertWithOrgCheck: vi.fn(),
}));

import { alertsRoutes } from './alerts';

function makeApp() {
  const app = new Hono();
  app.route('/alerts', alertsRoutes);
  return app;
}

const ALERT_ID = '5d4c3b2a-1111-4222-8333-444455556666';
const ALERTS_WRITE = 'alerts:write';
const ALERTS_ACKNOWLEDGE = 'alerts:acknowledge';

describe('alert state-change authz (Finding #6)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    grantedRef.current = new Set<string>();
    authRef.current = {
      scope: 'organization',
      user: { id: 'u-1', name: 'Reed Only', email: 'reed@org.example' },
      partnerId: null, orgId: 'org-1', accessibleOrgIds: null, canAccessOrg: () => true,
    } as typeof authRef.current;
  });

  it('403 on POST /alerts/:id/acknowledge without ALERTS_ACKNOWLEDGE', async () => {
    const res = await makeApp().request(`/alerts/${ALERT_ID}/acknowledge`, { method: 'POST' });
    expect(res.status).toBe(403);
  });

  it('403 on POST /alerts/:id/resolve without ALERTS_WRITE', async () => {
    const res = await makeApp().request(`/alerts/${ALERT_ID}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
  });

  it('403 on POST /alerts/:id/suppress without ALERTS_WRITE', async () => {
    const res = await makeApp().request(`/alerts/${ALERT_ID}/suppress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ until: '2030-01-01T00:00:00.000Z' }),
    });
    expect(res.status).toBe(403);
  });

  it('403 on POST /alerts/bulk without ALERTS_WRITE', async () => {
    const res = await makeApp().request('/alerts/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alertIds: [ALERT_ID], action: 'acknowledge' }),
    });
    expect(res.status).toBe(403);
  });

  it('passes the acknowledge gate when ALERTS_ACKNOWLEDGE is granted', async () => {
    grantedRef.current.add(ALERTS_ACKNOWLEDGE);
    const res = await makeApp().request(`/alerts/${ALERT_ID}/acknowledge`, { method: 'POST' });
    expect(res.status).not.toBe(403);
  });

  it('passes the bulk gate when ALERTS_WRITE is granted', async () => {
    grantedRef.current.add(ALERTS_WRITE);
    const res = await makeApp().request('/alerts/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).not.toBe(403);
  });
});
