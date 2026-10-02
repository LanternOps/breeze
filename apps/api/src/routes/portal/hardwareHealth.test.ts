import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => ({
  overview: vi.fn(),
  page: vi.fn(),
  detail: vi.fn(),
  brandingRows: [] as Array<{ enableHardwareHealth: boolean }>,
}));

vi.mock('../../services/portal/hardwareHealthReadModel', () => ({
  hardwareHealthOverview: mocks.overview,
  hardwareHealthDevicesPage: mocks.page,
  hardwareHealthDeviceDetail: mocks.detail,
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
            Object.hasOwn(columns, 'enableHardwareHealth')
              ? mocks.brandingRows
              : [{
                  id: 'pu-1',
                  orgId: '11111111-1111-4111-8111-111111111111',
                  email: 'customer@example.com',
                  name: 'Customer',
                  contactId: null,
                  authMethod: 'password',
                  receiveNotifications: true,
                  status: 'active',
                  authEpoch: 1,
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

import { portalHardwareHealthRoutes } from './hardwareHealth';
import { portalRoutes } from './index';
import { portalSessions } from './helpers';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG_DEVICE = '99999999-9999-4999-8999-999999999999';
const TOKEN = 'hardware-health-route-session';

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
  hono.route('/', portalHardwareHealthRoutes);
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
    authEpoch: 1,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
  });
}

const OVERVIEW = {
  asOf: '2026-10-02T12:00:00.000Z',
  dataStatus: 'ok',
  devices: { total: 1, reporting: 1, byHealth: { ok: 1, warning: 0, critical: 0, unknown: 0 } },
};

beforeEach(() => {
  vi.clearAllMocks();
  portalSessions.clear();
  mocks.brandingRows = [];
});

describe('hardware health handlers', () => {
  it('calls the overview with the session org and sets cache headers', async () => {
    mocks.overview.mockResolvedValue(OVERVIEW);
    const response = await isolatedApp().request('/hardware-health/overview');
    expect(response.status).toBe(200);
    expect(mocks.overview).toHaveBeenCalledWith(ORG_ID, expect.any(Date));
    expect(response.headers.get('cache-control')).toContain('private');
    expect(response.headers.get('etag')).toMatch(/^W\//);
    expect(await response.json()).toEqual(OVERVIEW);
  });

  it('revalidates unchanged data when only asOf changes', async () => {
    mocks.overview
      .mockResolvedValueOnce(OVERVIEW)
      .mockResolvedValueOnce({ ...OVERVIEW, asOf: '2026-10-02T12:00:01.000Z' });
    const first = await isolatedApp().request('/hardware-health/overview');
    const etag = first.headers.get('etag');
    const second = await isolatedApp().request('/hardware-health/overview', {
      headers: { 'If-None-Match': etag! },
    });
    expect(second.status).toBe(304);
  });

  it('paginates the device list and validates limits', async () => {
    mocks.page.mockResolvedValue({
      asOf: OVERVIEW.asOf, dataStatus: 'no_data', data: [],
      pagination: { page: 2, limit: 25, total: 0 },
    });
    const ok = await isolatedApp().request('/hardware-health/devices?page=2&limit=25');
    expect(ok.status).toBe(200);
    expect(mocks.page).toHaveBeenCalledWith(ORG_ID, { page: 2, limit: 25, now: expect.any(Date) });
    expect((await isolatedApp().request('/hardware-health/devices?limit=101')).status).toBe(400);
    expect((await isolatedApp().request('/hardware-health/devices?page=0')).status).toBe(400);
  });

  it('rejects a device id that is not a uuid', async () => {
    const response = await isolatedApp().request('/hardware-health/devices/not-a-uuid');
    expect(response.status).toBe(400);
    expect(mocks.detail).not.toHaveBeenCalled();
  });

  it('returns 404 when the device is not in the session org (forged id)', async () => {
    mocks.detail.mockResolvedValue(null);
    const response = await isolatedApp().request(
      `/hardware-health/devices/${OTHER_ORG_DEVICE}?orgId=other-org`,
    );
    expect(response.status).toBe(404);
    // The org always comes from the session, never from the request.
    expect(mocks.detail).toHaveBeenCalledWith(ORG_ID, OTHER_ORG_DEVICE, expect.any(Date));
  });

  it('returns the device detail for a device in the session org', async () => {
    const dto = { asOf: OVERVIEW.asOf, dataStatus: 'ok', health: 'ok' };
    mocks.detail.mockResolvedValue(dto);
    const response = await isolatedApp().request(`/hardware-health/devices/${OTHER_ORG_DEVICE}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(dto);
  });
});

describe('assembled portal router hardware health gate', () => {
  it('returns 401 without a portal session', async () => {
    const response = await assembledApp().request('/portal/hardware-health/overview');
    expect(response.status).toBe(401);
    expect(mocks.overview).not.toHaveBeenCalled();
  });

  it('returns 403 when enableHardwareHealth is false', async () => {
    seedSession();
    mocks.brandingRows = [{ enableHardwareHealth: false }];
    for (const path of [
      '/portal/hardware-health/overview',
      '/portal/hardware-health/devices',
      `/portal/hardware-health/devices/${OTHER_ORG_DEVICE}`,
    ]) {
      const response = await assembledApp().request(path, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: 'Hardware health is not enabled for this portal',
        code: 'PORTAL_HARDWARE_HEALTH_DISABLED',
      });
    }
    expect(mocks.overview).not.toHaveBeenCalled();
    expect(mocks.page).not.toHaveBeenCalled();
    expect(mocks.detail).not.toHaveBeenCalled();
  });

  it('returns 403 when the org has no branding row (fail closed)', async () => {
    seedSession();
    mocks.brandingRows = [];
    const response = await assembledApp().request('/portal/hardware-health/overview', {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(403);
    expect(mocks.overview).not.toHaveBeenCalled();
  });

  it('returns 200 when enableHardwareHealth is true', async () => {
    seedSession();
    mocks.brandingRows = [{ enableHardwareHealth: true }];
    mocks.overview.mockResolvedValue(OVERVIEW);
    const response = await assembledApp().request('/portal/hardware-health/overview', {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(200);
    expect(mocks.overview).toHaveBeenCalledWith(ORG_ID, expect.any(Date));
  });
});
