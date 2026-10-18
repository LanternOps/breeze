import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// The assembled portal router: /dashboard/trust-page must carry portal auth AND the strict enableDashboard gate
// (fail-closed on a missing portal_branding row or an explicit false), like every other /dashboard/* surface.

const ORG_ID = '11111111-1111-4111-8111-111111111111';

const mocks = vi.hoisted(() => ({
  brandingRows: [] as Array<{ enableDashboard: boolean }>,
  trustPageReads: 0,
}));

vi.mock('../../services/portal/timezone', () => ({ resolveOrgTimezone: vi.fn(async () => 'UTC') }));
vi.mock('../../services/tenantStatus', () => ({
  getActiveOrgTenant: vi.fn(async () => ({ orgId: '11111111-1111-4111-8111-111111111111', partnerId: 'partner-1' })),
  isUsableOrgStatus: (status: string) => status === 'active' || status === 'trial',
  invalidateAgentTenantCache: vi.fn(async () => undefined),
}));

vi.mock('../../db', () => {
  const chainFor = (columns: Record<string, unknown>) => {
    const rows = () => {
      if (Object.hasOwn(columns, 'enableDashboard')) return mocks.brandingRows;
      if (Object.hasOwn(columns, 'publishedAt')) { mocks.trustPageReads++; return []; }
      return [{
        id: 'pu-1', orgId: '11111111-1111-4111-8111-111111111111', email: 'customer@example.com',
        name: 'Customer', contactId: null, authMethod: 'password', receiveNotifications: true,
        status: 'active', authEpoch: 1,
      }];
    };
    const c: Record<string, unknown> = {};
    for (const m of ['from', 'where', 'innerJoin', 'leftJoin']) c[m] = () => c;
    c.limit = () => Promise.resolve(rows());
    return c;
  };
  return {
    db: { select: (columns: Record<string, unknown>) => chainFor(columns) },
    withDbAccessContext: (_context: unknown, fn: () => unknown) => fn(),
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
    runOutsideDbContext: <T,>(fn: () => T): T => fn(),
  };
});

import { portalRoutes } from './index';
import { portalSessions } from './helpers';

const TOKEN = 'trust-link-gate-session';
const auth = { Authorization: `Bearer ${TOKEN}` };

function assembledApp() {
  const hono = new Hono();
  hono.route('/portal', portalRoutes);
  return hono;
}
function seedSession() {
  portalSessions.set(TOKEN, {
    token: TOKEN, portalUserId: 'pu-1', orgId: ORG_ID, authEpoch: 1,
    createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  portalSessions.clear();
  mocks.brandingRows = [];
  mocks.trustPageReads = 0;
});

describe('assembled portal router: GET /portal/dashboard/trust-page gates', () => {
  it('without a portal session is 401 and reads no trust page', async () => {
    const res = await assembledApp().request('/portal/dashboard/trust-page');
    expect(res.status).toBe(401);
    expect(mocks.trustPageReads).toBe(0);
  });

  it.each([
    ['a missing branding row', []],
    ['enableDashboard off', [{ enableDashboard: false }]],
  ])('is 403 with %s (strict gate) and reads no trust page', async (_label, rows) => {
    seedSession();
    mocks.brandingRows = rows;
    const res = await assembledApp().request('/portal/dashboard/trust-page', { headers: auth });
    expect(res.status).toBe(403);
    expect(mocks.trustPageReads).toBe(0);
  });

  it('with the dashboard enabled it reaches the handler at /portal/dashboard/trust-page', async () => {
    seedSession();
    mocks.brandingRows = [{ enableDashboard: true }];
    const res = await assembledApp().request('/portal/dashboard/trust-page', { headers: auth });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { publicPath: null } });
    expect(mocks.trustPageReads).toBe(1);
  });
});
