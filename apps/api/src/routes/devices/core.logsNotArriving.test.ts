import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// ---------------------------------------------------------------------------
// #8612 (W05 of #8607) — GET /devices/:id attaches `logsNotArriving`.
//
// Route wiring only; the query and the conditions live in
// `services/logsNotArriving.test.ts`. Properties asserted here:
//
//   1. The service's `{ raisedAt }` reaches the body as `{ since }`.
//   2. It is computed only after the authorisation chokepoint
//      (`device_commands` has no RLS) and only when it could be non-null:
//      the agent reports `logShipping` (state non-NULL) and the device is
//      online. Every other detail load pays zero queries for it.
//   3. A failure in the check never fails the detail response.
//
// Mock scaffold mirrors core.uninstallState.test.ts.
// ---------------------------------------------------------------------------

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
  withDbTransaction: vi.fn(async (fn: () => Promise<unknown>) => fn()),
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
  getDeviceUninstallStatus: vi.fn(async () => null),
}));

vi.mock('../../services/logsNotArriving', () => ({
  logsNotArriving: vi.fn(),
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
import { logsNotArriving } from '../../services/logsNotArriving';

const DEVICE_ID = '22222222-2222-4222-8222-222222222222';

const DEVICE = {
  id: DEVICE_ID,
  orgId: 'org-123',
  siteId: 'site-1',
  hostname: 'host-1',
  displayName: 'Host 1',
  status: 'online',
  customFields: {},
  logShippingState: 'ok',
  logShippingFailureStartedAt: null,
  logShippingLastError: null,
};

describe('GET /devices/:id — logsNotArriving (#8612)', () => {
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

  it('maps the service result to { since } on the detail body', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(DEVICE as never);
    vi.mocked(logsNotArriving).mockResolvedValue({ raisedAt: '2026-10-13T11:50:00.000Z' });

    const res = await get();

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.logsNotArriving).toEqual({ since: '2026-10-13T11:50:00.000Z' });
    expect(logsNotArriving).toHaveBeenCalledWith(
      DEVICE_ID,
      expect.any(Date),
      expect.objectContaining({ logShippingState: 'ok' }),
    );
  });

  it('is present-and-null when the service reports nothing', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(DEVICE as never);
    vi.mocked(logsNotArriving).mockResolvedValue(null);

    const body = await (await get()).json() as Record<string, unknown>;
    expect(body).toHaveProperty('logsNotArriving');
    expect(body.logsNotArriving).toBeNull();
  });

  it('skips the check entirely when the agent never reported logShipping', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({ ...DEVICE, logShippingState: null } as never);

    const body = await (await get()).json() as Record<string, unknown>;
    expect(body.logsNotArriving).toBeNull();
    expect(logsNotArriving).not.toHaveBeenCalled();
  });

  it('skips the check for a device that is not online (an offline device trivially ships nothing)', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({ ...DEVICE, status: 'offline' } as never);

    const body = await (await get()).json() as Record<string, unknown>;
    expect(body.logsNotArriving).toBeNull();
    expect(logsNotArriving).not.toHaveBeenCalled();
  });

  it('never runs the check when the authorisation chokepoint rejects the id', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(null as never);

    const res = await get();
    expect(res.status).toBe(404);
    expect(logsNotArriving).not.toHaveBeenCalled();
  });

  it('degrades to null (detail still 200) when the check throws', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(DEVICE as never);
    vi.mocked(logsNotArriving).mockRejectedValue(new Error('boom'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.logsNotArriving).toBeNull();
    errSpy.mockRestore();
  });
});
