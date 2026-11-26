import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// ---------------------------------------------------------------------------
// #12729 - GET /devices/:id attaches `plaintextServerConnection`.
//
// Route wiring only; the query and the derivation live in
// `services/agentHealthObservations.test.ts`. Properties asserted here:
//
//   1. The service result reaches the body unchanged, read for this device
//      and its org, inside withDbTransaction (a savepoint), so a failed read
//      cannot abort the request transaction.
//   2. It is read only after the authorisation chokepoint.
//   3. A failure never fails the detail response.
//
// Mock scaffold mirrors core.logsNotArriving.test.ts.
// ---------------------------------------------------------------------------

const { txDepth } = vi.hoisted(() => ({ txDepth: { current: 0, seenInside: false } }));

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
  withDbTransaction: vi.fn(async (fn: () => Promise<unknown>) => {
    txDepth.current += 1;
    try {
      return await fn();
    } finally {
      txDepth.current -= 1;
    }
  }),
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

vi.mock('../../services/agentHealthObservations', () => ({
  readPlaintextServerConnection: vi.fn(),
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
import { readPlaintextServerConnection } from '../../services/agentHealthObservations';

const DEVICE_ID = '22222222-2222-4222-8222-222222222222';

const DEVICE = {
  id: DEVICE_ID,
  orgId: 'org-123',
  siteId: 'site-1',
  hostname: 'host-1',
  displayName: 'Host 1',
  status: 'online',
  customFields: {},
};

describe('GET /devices/:id — plaintextServerConnection (#12729)', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    txDepth.current = 0;
    txDepth.seenInside = false;
    app = new Hono();
    app.route('/devices', coreRoutes);
  });

  async function get() {
    return app.request(`/devices/${DEVICE_ID}`, {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });
  }

  it('attaches the notice the service derives, read for this device and org inside a transaction', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(DEVICE as never);
    vi.mocked(readPlaintextServerConnection).mockImplementation(async () => {
      txDepth.seenInside = txDepth.current > 0;
      return { observedAt: '2026-11-20T10:00:00.000Z' };
    });

    const res = await get();

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.plaintextServerConnection).toEqual({ observedAt: '2026-11-20T10:00:00.000Z' });
    expect(readPlaintextServerConnection).toHaveBeenCalledWith({ id: DEVICE_ID, orgId: 'org-123' });
    expect(txDepth.seenInside).toBe(true);
  });

  it('is present-and-null when the agent reports nothing', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(DEVICE as never);
    vi.mocked(readPlaintextServerConnection).mockResolvedValue(null);

    const body = await (await get()).json() as Record<string, unknown>;
    expect(body).toHaveProperty('plaintextServerConnection');
    expect(body.plaintextServerConnection).toBeNull();
  });

  it('never reads when the authorisation chokepoint rejects the id', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(null as never);

    const res = await get();
    expect(res.status).toBe(404);
    expect(readPlaintextServerConnection).not.toHaveBeenCalled();
  });

  it('degrades to null (detail still 200) when the read throws', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(DEVICE as never);
    vi.mocked(readPlaintextServerConnection).mockRejectedValue(new Error('boom'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.plaintextServerConnection).toBeNull();
    errSpy.mockRestore();
  });
});
