import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => ({
  page: vi.fn(),
  detail: vi.fn(),
  brandingRows: [] as Array<{ enableHardwareInventory: boolean | null }>,
}));

vi.mock('../../services/portal/hardwareInventoryReadModel', () => ({
  hardwareInventoryDevicesPage: mocks.page,
  hardwareInventoryDeviceDetail: mocks.detail,
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
            Object.hasOwn(columns, 'enableHardwareInventory')
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

import { portalHardwareInventoryRoutes } from './hardwareInventory';
import { portalRoutes } from './index';
import { portalSessions } from './helpers';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG_DEVICE = '99999999-9999-4999-8999-999999999999';
const TOKEN = 'hardware-inventory-route-session';

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
  hono.route('/', portalHardwareInventoryRoutes);
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

const LIST = {
  asOf: '2026-10-06T12:00:00.000Z',
  dataStatus: 'ok',
  data: [],
  pagination: { page: 1, limit: 50, total: 0 },
};

beforeEach(() => {
  vi.clearAllMocks();
  portalSessions.clear();
  mocks.brandingRows = [];
});

describe('hardware inventory handlers', () => {
  it('paginates the device list with the session org and sets cache headers', async () => {
    mocks.page.mockResolvedValue({ ...LIST, pagination: { page: 2, limit: 25, total: 0 } });
    const response = await isolatedApp().request('/hardware-inventory/devices?page=2&limit=25');
    expect(response.status).toBe(200);
    expect(mocks.page).toHaveBeenCalledWith(ORG_ID, { page: 2, limit: 25, now: expect.any(Date) });
    expect(response.headers.get('cache-control')).toContain('private');
    expect(response.headers.get('etag')).toMatch(/^W\//);
  });

  it('validates page and limit', async () => {
    expect((await isolatedApp().request('/hardware-inventory/devices?limit=101')).status).toBe(400);
    expect((await isolatedApp().request('/hardware-inventory/devices?page=0')).status).toBe(400);
  });

  it('revalidates unchanged data when only asOf changes', async () => {
    mocks.page
      .mockResolvedValueOnce(LIST)
      .mockResolvedValueOnce({ ...LIST, asOf: '2026-10-06T12:00:01.000Z' });
    const first = await isolatedApp().request('/hardware-inventory/devices');
    const second = await isolatedApp().request('/hardware-inventory/devices', {
      headers: { 'If-None-Match': first.headers.get('etag')! },
    });
    expect(second.status).toBe(304);
  });

  it('rejects a device id that is not a uuid', async () => {
    const response = await isolatedApp().request('/hardware-inventory/devices/not-a-uuid');
    expect(response.status).toBe(400);
    expect(mocks.detail).not.toHaveBeenCalled();
  });

  it('returns 404 when the device is not in the session org (forged id)', async () => {
    mocks.detail.mockResolvedValue(null);
    const response = await isolatedApp().request(
      `/hardware-inventory/devices/${OTHER_ORG_DEVICE}?orgId=other-org`,
    );
    expect(response.status).toBe(404);
    // The org always comes from the session, never from the request.
    expect(mocks.detail).toHaveBeenCalledWith(ORG_ID, OTHER_ORG_DEVICE, expect.any(Date));
  });

  it('returns the device detail for a device in the session org', async () => {
    const dto = { asOf: LIST.asOf, dataStatus: 'ok' };
    mocks.detail.mockResolvedValue(dto);
    const response = await isolatedApp().request(`/hardware-inventory/devices/${OTHER_ORG_DEVICE}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(dto);
  });
});

describe('assembled portal router hardware inventory gate', () => {
  it('returns 401 without a portal session', async () => {
    const response = await assembledApp().request('/portal/hardware-inventory/devices');
    expect(response.status).toBe(401);
    expect(mocks.page).not.toHaveBeenCalled();
  });

  it.each([
    ['a missing settings row', [] as Array<{ enableHardwareInventory: boolean | null }>],
    ['false', [{ enableHardwareInventory: false }]],
    ['null', [{ enableHardwareInventory: null }]],
  ])('returns 403 with the family code for %s', async (_label, rows) => {
    seedSession();
    mocks.brandingRows = rows;
    for (const path of [
      '/portal/hardware-inventory/devices',
      `/portal/hardware-inventory/devices/${OTHER_ORG_DEVICE}`,
    ]) {
      const response = await assembledApp().request(path, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: 'Hardware inventory is not enabled for this portal',
        code: 'PORTAL_HARDWARE_INVENTORY_DISABLED',
      });
    }
    expect(mocks.page).not.toHaveBeenCalled();
    expect(mocks.detail).not.toHaveBeenCalled();
  });

  it('returns 200 when enableHardwareInventory is true', async () => {
    seedSession();
    mocks.brandingRows = [{ enableHardwareInventory: true }];
    mocks.page.mockResolvedValue(LIST);
    const response = await assembledApp().request('/portal/hardware-inventory/devices', {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(200);
    expect(mocks.page).toHaveBeenCalledWith(ORG_ID, { page: 1, limit: 50, now: expect.any(Date) });
  });
});
