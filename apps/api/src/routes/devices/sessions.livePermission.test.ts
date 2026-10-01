/**
 * GET /devices/:id/sessions/live sends `list_sessions` to the device's agent
 * and returns what it answers: a live read. Live device reads need an
 * execute-level grant, so `devices:read` alone is refused. The route accepts
 * `devices:execute`, or `remote:access` because the remote desktop session
 * picker on RDS hosts is this route's main caller and remote access already
 * reaches the device live. The stored list (/sessions/active) stays on
 * `devices:read`.
 *
 * Drives the REAL `sessionsRoutes` router with the real `requirePermission`
 * and `hasPermission`; only the permission lookup, the device row and the
 * agent round trip are stubbed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const { getUserPermissionsMock, sendCommandMock, getDeviceMock } = vi.hoisted(() => ({
  getUserPermissionsMock: vi.fn(),
  sendCommandMock: vi.fn(),
  getDeviceMock: vi.fn(),
}));

const DEVICE_ID = '33333333-3333-4333-8333-333333333333';
const ORG_ID = '22222222-2222-4222-8222-222222222222';
const ROLE_ID = '55555555-5555-4555-8555-555555555555';

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(() => {
      const chain: Record<string, unknown> = {};
      for (const k of ['from', 'where', 'orderBy']) chain[k] = vi.fn(() => chain);
      (chain as { then: unknown }).then = (resolve: (v: unknown[]) => unknown) => resolve([]);
      return chain;
    }),
  },
}));

vi.mock('../../middleware/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../middleware/auth')>();
  return {
    ...actual,
    authMiddleware: async (c: any, next: () => Promise<void>) => {
      c.set('auth', {
        user: { id: '11111111-1111-4111-8111-111111111111', email: 'user@example.com' },
        token: { roleId: ROLE_ID, mfa: true },
        scope: 'organization',
        orgId: ORG_ID,
        partnerId: null,
        accessibleOrgIds: [ORG_ID],
        canAccessOrg: (orgId: string) => orgId === ORG_ID,
      });
      await next();
    },
    requireScope: () => async (_c: unknown, next: () => Promise<void>) => next(),
    withAuthDbAccessContext: (_auth: unknown, fn: () => unknown) => fn(),
  };
});

// Only the lookup is stubbed; hasPermission / PERMISSIONS run for real.
vi.mock('../../services/permissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/permissions')>();
  return { ...actual, getUserPermissions: getUserPermissionsMock };
});

vi.mock('../../services/agentCommandAwait', () => ({
  sendCommandToAgentAwaitResult: sendCommandMock,
}));

vi.mock('./helpers', () => ({
  SITE_ACCESS_DENIED: Symbol('SITE_ACCESS_DENIED'),
  getDeviceWithOrgAndSiteCheck: getDeviceMock,
}));

import { sessionsRoutes } from './sessions';

function grants(...specs: string[]) {
  return {
    permissions: specs.map((s) => {
      const [resource, action] = s.split(':');
      return { resource: resource!, action: action! };
    }),
    partnerId: null,
    orgId: ORG_ID,
    roleId: ROLE_ID,
    scope: 'organization' as const,
  };
}

function app() {
  const instance = new Hono();
  instance.route('/devices', sessionsRoutes);
  return instance;
}

describe('GET /devices/:id/sessions/live permission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getDeviceMock.mockResolvedValue({ id: DEVICE_ID, orgId: ORG_ID, agentId: 'agent-1' });
    sendCommandMock.mockResolvedValue({
      status: 'completed',
      stdout: JSON.stringify({ sessions: [{ sessionId: 2, username: 'alice', state: 'active', type: 'rdp' }] }),
    });
  });

  it('refuses devices:read alone and never reaches the device', async () => {
    getUserPermissionsMock.mockResolvedValue(grants('devices:read'));
    const res = await app().request(`/devices/${DEVICE_ID}/sessions/live`);
    expect(res.status).toBe(403);
    expect(sendCommandMock).not.toHaveBeenCalled();
    expect(getDeviceMock).not.toHaveBeenCalled();
  });

  it('refuses devices:read + devices:write (no execute-level grant)', async () => {
    getUserPermissionsMock.mockResolvedValue(grants('devices:read', 'devices:write'));
    const res = await app().request(`/devices/${DEVICE_ID}/sessions/live`);
    expect(res.status).toBe(403);
    expect(sendCommandMock).not.toHaveBeenCalled();
  });

  it.each([
    [['devices:read', 'devices:execute']],
    [['devices:read', 'remote:access']],
    [['*:*']],
  ])('lists live sessions with %j', async (specs) => {
    getUserPermissionsMock.mockResolvedValue(grants(...specs));
    const res = await app().request(`/devices/${DEVICE_ID}/sessions/live`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.sessions).toHaveLength(1);
    expect(sendCommandMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the stored session list on devices:read', async () => {
    getUserPermissionsMock.mockResolvedValue(grants('devices:read'));
    const res = await app().request(`/devices/${DEVICE_ID}/sessions/active`);
    expect(res.status).toBe(200);
    expect(sendCommandMock).not.toHaveBeenCalled();
  });
});
