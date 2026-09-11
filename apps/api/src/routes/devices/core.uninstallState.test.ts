import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// ---------------------------------------------------------------------------
// #3987 item 7 — GET /devices/:id reports what happened to the agent-uninstall
// queued by Remove.
//
// This file covers the ROUTE's wiring only; the query and the state mapping it
// depends on are covered on compiled SQL by
// `services/deviceUninstallState.test.ts`. The two properties that can only be
// asserted here:
//
//   1. `uninstall` actually reaches the response body (this exact class of
//      "selected but never mapped" drop has shipped three times on the device
//      list — see core.list-response-shape.test.ts's comment).
//   2. The read happens AFTER the authorisation chokepoint and only for a
//      removed device. `device_commands` has no RLS (intentionally
//      system-scoped, agent WS path), so calling the service before
//      `getDeviceWithOrgAndSiteCheck` has cleared the id would read another
//      tenant's command row.
//
// Mock scaffold mirrors core.remoteAccessLaunch.test.ts, which is the existing
// suite that drives this same GET handler end to end.
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
import { getDeviceUninstallStatus } from '../../services/deviceUninstallState';

const DEVICE_ID = '22222222-2222-4222-8222-222222222222';

const REMOVED_DEVICE = {
  id: DEVICE_ID,
  orgId: 'org-123',
  siteId: 'site-1',
  hostname: 'host-1',
  displayName: 'Host 1',
  status: 'decommissioned',
  customFields: {},
};

const PENDING_UNINSTALL = {
  state: 'pending' as const,
  queuedAt: '2026-09-05T10:00:00.000Z',
  sentAt: null,
  completedAt: null,
  expiresAt: '2026-09-08T10:00:00.000Z',
};

describe('GET /devices/:id — agent-uninstall state (#3987)', () => {
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

  it('surfaces the queued uninstall (state + deadline) on a removed device', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(REMOVED_DEVICE as never);
    vi.mocked(getDeviceUninstallStatus).mockResolvedValue(PENDING_UNINSTALL);

    const res = await get();

    expect(res.status).toBe(200);
    const body = await res.json() as { uninstall?: unknown };
    expect(body.uninstall).toEqual(PENDING_UNINSTALL);
    expect(getDeviceUninstallStatus).toHaveBeenCalledWith(DEVICE_ID);
  });

  it('reports uninstall: null when the Remove left the agent installed', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(REMOVED_DEVICE as never);
    vi.mocked(getDeviceUninstallStatus).mockResolvedValue(null);

    const res = await get();

    expect(res.status).toBe(200);
    // Explicitly present-and-null, not absent: the web badge distinguishes
    // "this Remove left the agent installed" (null) from "this payload does
    // not carry the field at all" (a list row), and renders different things.
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('uninstall');
    expect(body.uninstall).toBeNull();
  });

  it('does not read device_commands for a device that is not removed', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({
      ...REMOVED_DEVICE,
      status: 'online',
    } as never);

    const res = await get();

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.uninstall).toBeNull();
    // Keeps the hot detail path exactly as it was for the 99% case.
    expect(getDeviceUninstallStatus).not.toHaveBeenCalled();
  });

  it('never reads device_commands when the authorisation chokepoint rejects the id', async () => {
    // The load-bearing isolation property: `device_commands` carries no RLS,
    // so a read issued before/without the chokepoint would happily return
    // another tenant's uninstall row for a guessed device id.
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(null as never);

    const res = await get();

    expect(res.status).toBe(404);
    expect(getDeviceUninstallStatus).not.toHaveBeenCalled();
  });
});
