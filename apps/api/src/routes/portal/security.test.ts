import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => ({
  overview: vi.fn(),
  devices: vi.fn(),
  brandingRows: [] as Array<{ enableSecurity: boolean }>,
}));

vi.mock('../../services/portal/securityReadModel', () => ({
  securityOverview: mocks.overview,
  securityDevicesPage: mocks.devices,
}));

vi.mock('../../services/portal/timezone', () => ({
  resolveOrgTimezone: vi.fn(async () => 'America/Denver'),
}));

vi.mock('../../services/tenantStatus', () => ({
  getActiveOrgTenant: vi.fn(async () => ({
    orgId: '11111111-1111-4111-8111-111111111111',
    partnerId: 'partner-1',
  })),
  isUsableOrgStatus: (status: string) => status === 'active' || status === 'trial',
  invalidateAgentTenantCache: vi.fn(async () => undefined),
}));

vi.mock('../../db', () => ({
  db: {
    select: (columns: Record<string, unknown>) => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(
            Object.hasOwn(columns, 'enableSecurity')
              ? mocks.brandingRows
              : [{
                  id: 'pu-1',
                  orgId: '11111111-1111-4111-8111-111111111111',
                  email: 'customer@example.com',
                  name: 'Customer',
                  contactId: null,
                  receiveNotifications: true,
                  status: 'active',
                }],
          ),
        }),
      }),
    }),
  },
  withDbAccessContext: (_context: unknown, fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
  runOutsideDbContext: <T,>(fn: () => T): T => fn(),
}));

import { portalSecurityRoutes } from './security';
import { portalRoutes } from './index';
import { portalSessions } from './helpers';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const TOKEN = 'security-route-session';

function isolatedApp() {
  const hono = new Hono();
  hono.use('*', async (c, next) => {
    c.set('portalAuth', {
      user: {
        id: 'pu-1',
        orgId: ORG_ID,
        email: 'customer@example.com',
        name: 'Customer',
        contactId: null,
        receiveNotifications: true,
        status: 'active',
      },
      token: 'token',
      authMethod: 'bearer',
      timezone: 'America/Denver',
    });
    await next();
  });
  hono.route('/', portalSecurityRoutes);
  return hono;
}

function assembledApp() {
  const hono = new Hono();
  hono.route('/portal', portalRoutes);
  return hono;
}

function seedSession() {
  portalSessions.set(TOKEN, {
    token: TOKEN,
    portalUserId: 'pu-1',
    orgId: ORG_ID,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  portalSessions.clear();
  mocks.brandingRows = [];
});

it('validates days and calls the overview with the session org', async () => {
  mocks.overview.mockResolvedValue({
    asOf: '2026-09-02T12:00:00.000Z',
    dataStatus: 'no_data',
    score: null,
    band: null,
    scoreHistory: [],
    threatEvents: { label: 'Endpoint threat events', weeks: [] },
    vulnerabilities: {
      openBySeverity: {
        critical: 0, high: 0, medium: 0, low: 0, unknown: 0,
      },
      kevCount: 0,
      lastDetectedAt: null,
    },
  });
  const response = await isolatedApp().request('/security/overview?days=30');
  expect(response.status).toBe(200);
  expect(mocks.overview).toHaveBeenCalledWith(ORG_ID, {
    days: 30,
    timezone: 'America/Denver',
    now: expect.any(Date),
  });
  expect(response.headers.get('cache-control')).toContain('private, max-age=30');
  expect(response.headers.get('etag')).toMatch(/^W\//);
  expect((await isolatedApp().request('/security/overview?days=91')).status).toBe(400);
});

it('paginates security devices', async () => {
  mocks.devices.mockResolvedValue({
    dataStatus: 'no_data',
    asOf: '2026-09-02T12:00:00.000Z',
    data: [],
    pagination: { page: 2, limit: 25, total: 0 },
  });
  const response = await isolatedApp().request('/security/devices?page=2&limit=25');
  expect(response.status).toBe(200);
  expect(mocks.devices).toHaveBeenCalledWith(ORG_ID, {
    page: 2,
    limit: 25,
    timezone: 'America/Denver',
    now: expect.any(Date),
  });
});

it('revalidates unchanged security data when only asOf changes', async () => {
  const payload = {
    dataStatus: 'ok',
    score: 82,
    band: 'strong',
    scoreHistory: [{ capturedAt: '2026-09-01', score: 82 }],
    threatEvents: { label: 'Endpoint threat events', weeks: [] },
    vulnerabilities: {
      openBySeverity: {
        critical: 0, high: 0, medium: 0, low: 0, unknown: 0,
      },
      kevCount: 0,
      lastDetectedAt: null,
    },
  };
  mocks.overview
    .mockResolvedValueOnce({ ...payload, asOf: '2026-09-02T12:00:00.000Z' })
    .mockResolvedValueOnce({ ...payload, asOf: '2026-09-02T12:00:01.000Z' });

  const first = await isolatedApp().request('/security/overview');
  const etag = first.headers.get('etag');
  expect(etag).toBeTruthy();

  const second = await isolatedApp().request('/security/overview', {
    headers: { 'If-None-Match': etag! },
  });

  expect(second.status).toBe(304);
  expect(second.headers.get('etag')).toBe(etag);
});

describe('assembled portal router security gate', () => {
  it('returns 401 without a portal session', async () => {
    const response = await assembledApp().request('/portal/security/overview');
    expect(response.status).toBe(401);
    expect(mocks.overview).not.toHaveBeenCalled();
  });

  it('returns 403 when enableSecurity is false', async () => {
    seedSession();
    mocks.brandingRows = [{ enableSecurity: false }];

    const response = await assembledApp().request('/portal/security/overview', {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: 'Security visibility is not enabled for this portal',
      code: 'PORTAL_SECURITY_DISABLED',
    });
    expect(mocks.overview).not.toHaveBeenCalled();
  });
});
