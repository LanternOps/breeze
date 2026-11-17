import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';


vi.mock('../../services/partnerTrust', () => ({
  evaluateCapability: vi.fn(async () => ({ allow: true })),
  requireCapability: vi.fn(() => async (_c: any, next: any) => next()),
}));

// Chainable, table-agnostic query-builder stub: every lookup the GET handler
// makes (hardware, network interfaces, metrics, memberships, site, org,
// partner settings) resolves to an empty array instead of crashing partway
// through on an unmocked chain shape.
function makeSelectMock() {
  return vi.fn(() => {
    const node: any = {
      from: vi.fn(() => node),
      innerJoin: vi.fn(() => node),
      where: vi.fn(() => node),
      orderBy: vi.fn(() => node),
      limit: vi.fn(async () => []),
      then: (resolve: (v: unknown[]) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve([]).then(resolve, reject),
    };
    return node;
  });
}

vi.mock('../../db', () => ({
  getCurrentDbAccessContext: vi.fn(() => undefined),
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: makeSelectMock(),
  },
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: '11111111-1111-1111-1111-111111111111', email: 'test@example.com', name: 'Test User' },
      scope: 'organization',
      orgId: 'org-123',
      partnerId: null,
      accessibleOrgIds: ['org-123'],
      principal: { kind: 'user_session' },
      canAccessOrg: (orgId: string) => orgId === 'org-123',
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
  isInteractiveUserSession: vi.fn(() => true),
}));

vi.mock('./helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./helpers')>()),
  getPagination: vi.fn(() => ({ page: 1, limit: 50, offset: 0 })),
  getDeviceWithOrgCheck: vi.fn(),
  getDeviceWithOrgAndSiteCheck: vi.fn(),
  SITE_ACCESS_DENIED: Symbol('SITE_ACCESS_DENIED'),
}));

vi.mock('../../services/deviceUninstallState', () => ({
  getDeviceUninstallStatus: vi.fn(),
}));

vi.mock('../../services/remoteAccessPolicy', () => ({
  resolveRemoteAccessForDevice: vi.fn(async () => ({ policyId: null, policyName: null, settings: {} })),
}));

vi.mock('../../services/agentWs', () => ({
  sendCommandToAgent: vi.fn(),
  isAgentConnected: vi.fn(() => false),
}));

vi.mock('../../services/commandQueue', () => ({ CommandTypes: {} }));

vi.mock('../agents/enrollment', () => ({
  getGlobalEnrollmentSecret: vi.fn(() => null),
}));

vi.mock('../../services/enrollmentKeySecurity', () => ({
  hashEnrollmentKey: vi.fn((k: string) => `hash:${k}`),
}));

vi.mock('../../services/auditEvents', () => ({
  requestLikeFromSnapshot: vi.fn(() => ({ req: { header: () => undefined } })),
  writeRouteAudit: vi.fn(),
}));

vi.mock('../../services/sentry', () => ({ captureException: vi.fn() }));

import { coreRoutes } from './core';
import { getDeviceWithOrgAndSiteCheck } from './helpers';

// ---------------------------------------------------------------------------
// #8868 — GET /devices/:id exposes only a derived `controlPlaneBlock` notice.
// The raw columns (closed-enum kind + jsonb episode) are never in the
// response. Scaffold copied from core.watchdogInstall.test.ts.
// ---------------------------------------------------------------------------

const DEVICE_ID = '22222222-2222-4222-8222-222222222222';
const RAW_KEYS = ['controlPlaneBlockKind'];

const BASE_DEVICE = {
  id: DEVICE_ID,
  orgId: 'org-123',
  siteId: 'site-1',
  hostname: 'host-1',
  displayName: 'Host 1',
  status: 'online',
  customFields: {},
  controlPlaneBlockKind: null,
  controlPlaneBlock: null,
};

describe('GET /devices/:id — control-plane block notice (#8868)', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/devices', coreRoutes);
  });

  async function get() {
    return app.request(`/devices/${DEVICE_ID}`, {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });
  }

  it('a clean device has controlPlaneBlock: null (present, not absent)', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(BASE_DEVICE as never);
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('controlPlaneBlock');
    expect(body.controlPlaneBlock).toBeNull();
  });

  it('a blocked device gets the derived notice without server bookkeeping fields', async () => {
    const recent = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({
      ...BASE_DEVICE,
      controlPlaneBlockKind: 'web_filter',
      controlPlaneBlock: {
        kind: 'web_filter',
        host: 'cp.example',
        firstSeenAt: recent,
        lastSeenAt: recent,
        httpStatus: 302,
        locationHost: 'warn.filter-a.example',
        reachableViaEch: true,
        reportedAt: recent,
      },
    } as never);

    const body = await (await get()).json() as Record<string, unknown>;
    expect(body.controlPlaneBlock).toEqual({
      state: 'active',
      kind: 'web_filter',
      host: 'cp.example',
      firstSeenAt: recent,
      lastSeenAt: recent,
      httpStatus: 302,
      locationHost: 'warn.filter-a.example',
      reachableViaEch: true,
    });
    for (const key of RAW_KEYS) expect(body).not.toHaveProperty(key);
    expect(body.controlPlaneBlock).not.toHaveProperty('reportedAt');
  });

  it('a stale episode is not surfaced', async () => {
    const old = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({
      ...BASE_DEVICE,
      controlPlaneBlockKind: null,
      controlPlaneBlock: {
        kind: 'web_filter', host: 'cp.example', firstSeenAt: old, lastSeenAt: old,
        reachableViaEch: false, reportedAt: old, staleAt: old,
      },
    } as never);
    const body = await (await get()).json() as Record<string, unknown>;
    expect(body.controlPlaneBlock).toBeNull();
  });
});
