import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const { authRef, grantedRef, selectRows, visibleAlertIds, deviceVisible, auditMock } = vi.hoisted(() => ({
  authRef: { current: {
    scope: 'organization',
    orgId: '11111111-1111-4111-8111-111111111111',
    partnerId: null,
    accessibleOrgIds: null,
    allowedSiteIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
    user: { id: 'user-1' },
  } },
  grantedRef: { current: new Set<string>() },
  selectRows: { current: [] as unknown[][] },
  visibleAlertIds: { current: new Set<string>() },
  deviceVisible: { current: true },
  auditMock: vi.fn(),
}));

function queryResult(rows: unknown[]) {
  const query: Record<string, unknown> = {};
  for (const method of ['where', 'orderBy', 'limit']) {
    query[method] = vi.fn(() => query);
  }
  query.then = (resolve: (value: unknown[]) => unknown) => Promise.resolve(rows).then(resolve);
  return query;
}

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => queryResult(selectRows.current.shift() ?? [])),
    })),
  },
}));

vi.mock('../../db/schema', () => ({
  alerts: { id: 'alerts.id', orgId: 'alerts.org_id', deviceId: 'alerts.device_id' },
  alertCorrelations: {
    parentAlertId: 'alert_correlations.parent_alert_id',
    childAlertId: 'alert_correlations.child_alert_id',
    createdAt: 'alert_correlations.created_at',
  },
}));

vi.mock('../../middleware/auth', () => ({
  requireScope: () => async (c: any, next: any) => {
    c.set('auth', authRef.current);
    return next();
  },
  requirePermission: (resource: string, action: string) => async (c: any, next: any) => {
    if (!grantedRef.current.has(`${resource}:${action}`)) return c.json({ error: 'Forbidden' }, 403);
    return next();
  },
}));

vi.mock('../../services/permissions', () => ({
  PERMISSIONS: { ALERTS_READ: { resource: 'alerts', action: 'read' } },
}));

vi.mock('../tickets/siteScope', () => ({
  filterAlertsBySiteScope: vi.fn(async (_auth: unknown, rows: Array<{ id: string }>) =>
    rows.filter((row) => visibleAlertIds.current.has(row.id))),
  deviceInSiteScope: vi.fn(async () => deviceVisible.current),
}));

vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: auditMock }));
vi.mock('./helpers', () => ({ resolveScopedOrgId: () => authRef.current.orgId }));
vi.mock('../../utils/pagination', () => ({ getPagination: () => ({ page: 1, limit: 20, offset: 0 }) }));

import { correlationRoutes, filterCorrelationsToVisibleAlerts } from './correlations';

const ALERT_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const ALERT_B = 'bbbbbbbb-2222-4222-8222-222222222222';
const ALERT_HIDDEN = 'cccccccc-3333-4333-8333-333333333333';

function makeApp() {
  const app = new Hono();
  app.route('/alert-templates', correlationRoutes);
  return app;
}

describe('legacy correlation authorization and site scope', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    grantedRef.current = new Set<string>();
    selectRows.current = [];
    visibleAlertIds.current = new Set([ALERT_A, ALERT_B]);
    deviceVisible.current = true;
  });

  for (const request of [
    () => makeApp().request('/alert-templates/correlations'),
    () => makeApp().request('/alert-templates/correlations/groups'),
    () => makeApp().request('/alert-templates/correlations/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alertIds: [ALERT_A] }),
    }),
    () => makeApp().request(`/alert-templates/correlations/${ALERT_A}`),
  ]) {
    it('denies a caller without alerts:read before any database access', async () => {
      const response = await request();
      expect(response.status).toBe(403);
      const { db } = await import('../../db');
      expect(db.select).not.toHaveBeenCalled();
      expect(auditMock).not.toHaveBeenCalled();
    });
  }

  it('filters every correlation edge unless both endpoints are visible', () => {
    expect(filterCorrelationsToVisibleAlerts([
      { id: 'visible', parentAlertId: ALERT_A, childAlertId: ALERT_B },
      { id: 'hidden-child', parentAlertId: ALERT_A, childAlertId: ALERT_HIDDEN },
      { id: 'hidden-parent', parentAlertId: ALERT_HIDDEN, childAlertId: ALERT_B },
    ], [ALERT_A, ALERT_B]).map((row) => row.id)).toEqual(['visible']);
  });

  it('groups only visible alerts and drops edges to a hidden-site alert', async () => {
    grantedRef.current.add('alerts:read');
    selectRows.current = [
      [[
        { id: ALERT_A, deviceId: 'device-a', title: 'Allowed A' },
        { id: ALERT_B, deviceId: 'device-b', title: 'Allowed B' },
        { id: ALERT_HIDDEN, deviceId: 'device-hidden', title: 'Hidden' },
      ]],
      [[
        { parentAlertId: ALERT_A, childAlertId: ALERT_B, confidence: '0.9', createdAt: new Date() },
        { parentAlertId: ALERT_A, childAlertId: ALERT_HIDDEN, confidence: '1.0', createdAt: new Date() },
      ]],
    ].flat();

    const response = await makeApp().request('/alert-templates/correlations/groups');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].alerts.map((alert: { id: string }) => alert.id)).toEqual([ALERT_A, ALERT_B]);
    expect(JSON.stringify(body)).not.toContain(ALERT_HIDDEN);
    expect(body.data[0].correlationScore).toBe(0.9);
  });

  it('returns an opaque 404 for a named alert outside the site ceiling', async () => {
    grantedRef.current.add('alerts:read');
    deviceVisible.current = false;
    selectRows.current = [[{ id: ALERT_HIDDEN, deviceId: 'device-hidden' }]];

    const response = await makeApp().request(`/alert-templates/correlations/${ALERT_HIDDEN}`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Alert not found' });
    const { db } = await import('../../db');
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it('drops hidden related alerts and their correlation rows from by-id output', async () => {
    grantedRef.current.add('alerts:read');
    selectRows.current = [
      [{ id: ALERT_A, deviceId: 'device-a' }],
      [
        { id: 'edge-visible', parentAlertId: ALERT_A, childAlertId: ALERT_B },
        { id: 'edge-hidden', parentAlertId: ALERT_A, childAlertId: ALERT_HIDDEN },
      ],
      [
        { id: ALERT_B, deviceId: 'device-b' },
        { id: ALERT_HIDDEN, deviceId: 'device-hidden' },
      ],
    ];

    const response = await makeApp().request(`/alert-templates/correlations/${ALERT_A}`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.relatedAlerts.map((alert: { id: string }) => alert.id)).toEqual([ALERT_B]);
    expect(body.data.correlations.map((edge: { id: string }) => edge.id)).toEqual(['edge-visible']);
    expect(JSON.stringify(body)).not.toContain(ALERT_HIDDEN);
  });

  it('does not expand an analyze request containing only hidden alert IDs to all visible links', async () => {
    grantedRef.current.add('alerts:read');
    visibleAlertIds.current = new Set([ALERT_A]);
    selectRows.current = [
      [
        { id: ALERT_A, deviceId: 'device-a' },
        { id: ALERT_HIDDEN, deviceId: 'device-hidden' },
      ],
      [{ id: 'should-drop', parentAlertId: ALERT_A, childAlertId: ALERT_A }],
    ];

    const response = await makeApp().request('/alert-templates/correlations/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alertIds: [ALERT_HIDDEN] }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.requestedAlertIds).toEqual([]);
    expect(body.data.links).toEqual([]);
  });
});
