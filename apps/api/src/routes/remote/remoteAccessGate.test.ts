/**
 * #11621: the `/remote/*` mount is gated on `remote:access`. A role without it
 * (the built-in Partner Viewer / Org Viewer, or a custom role) must get a 403
 * whose message names the permission and carries a machine code the web app
 * can switch on — not the bare "Permission denied" every other gate returns,
 * which surfaced in the dashboard as an unexplained "Connection failed".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

const { getUserPermissions, authState } = vi.hoisted(() => ({
  getUserPermissions: vi.fn(),
  authState: {
    current: null as null | Record<string, unknown>,
  },
}));

vi.mock('../../services/permissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/permissions')>();
  return { ...actual, getUserPermissions };
});

// Real requirePermission; only the token/MFA layers are stubbed so the test
// exercises the gate exactly as remoteRoutes wires it.
vi.mock('../../middleware/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../middleware/auth')>();
  return {
    ...actual,
    authMiddleware: async (c: any, next: any) => {
      c.set('auth', authState.current);
      await next();
    },
    requireMfa: () => async (_c: any, next: any) => next(),
  };
});

vi.mock('./sessions', async () => {
  const { Hono: H } = await import('hono');
  const r = new H();
  r.post('/sessions', (c) => c.json({ id: 'session-1' }, 201));
  return { sessionRoutes: r };
});
vi.mock('./supportSessions', async () => {
  const { Hono: H } = await import('hono');
  return { supportSessionRoutes: new H() };
});
vi.mock('./deviceActiveSessions', async () => {
  const { Hono: H } = await import('hono');
  return { deviceActiveSessionRoutes: new H() };
});
vi.mock('../../services/remoteAccessProviders', () => ({
  readPartnerRemoteAccessSettings: vi.fn(async () => undefined),
  readRemoteAccessSettingsForPartner: vi.fn(async () => undefined),
  toProviderSummaries: vi.fn(() => []),
}));

import { remoteRoutes } from './index';
import { httpExceptionResponse } from '../../middleware/httpExceptionResponse';
import { SYSTEM_ROLES } from '../../db/seed';

function buildApp() {
  const app = new Hono();
  app.onError((err, c) => {
    if (err instanceof HTTPException) return httpExceptionResponse(err, c);
    return c.json({ error: 'internal' }, 500);
  });
  app.route('/remote', remoteRoutes);
  return app;
}

function grantsOf(roleName: string) {
  const role = SYSTEM_ROLES.find((r) => r.name === roleName);
  if (!role) throw new Error(`no system role ${roleName}`);
  return role.permissions.map((p) => {
    const [resource, action] = p.split(':');
    return { resource: resource!, action: action! };
  });
}

const partnerAuth = {
  user: { id: 'user-1', email: 'viewer@example.test', name: 'Viewer' },
  scope: 'partner',
  partnerId: 'partner-1',
  orgId: null,
  accessibleOrgIds: ['org-1'],
};
const orgAuth = { ...partnerAuth, scope: 'organization', partnerId: null, orgId: 'org-1' };

function postSession(app: Hono) {
  return app.request('/remote/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: '00000000-0000-0000-0000-000000000001', type: 'desktop' }),
  });
}

describe('remote:access gate on /remote/* (#11621)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(['Partner Viewer', 'Org Viewer'])('%s does not hold remote:access (the fix must not grant it)', (roleName) => {
    expect(grantsOf(roleName)).not.toContainEqual({ resource: 'remote', action: 'access' });
  });

  it.each([
    ['Partner Viewer', partnerAuth],
    ['Org Viewer', orgAuth],
  ])('%s starting a desktop session gets a 403 naming remote:access with a code', async (roleName, auth) => {
    authState.current = auth;
    getUserPermissions.mockResolvedValue({
      permissions: grantsOf(roleName),
      partnerId: auth.partnerId,
      orgId: auth.orgId,
      roleId: 'role-viewer',
      scope: auth.scope,
    });

    const res = await postSession(buildApp());

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string; message?: string; code?: string };
    expect(body.code).toBe('REMOTE_ACCESS_PERMISSION_REQUIRED');
    expect(body.error).toContain('remote:access');
    expect(body.error).not.toBe('Permission denied');
    expect(body.message).toBe(body.error);
  });

  it('a custom role without remote:access gets the same readable 403', async () => {
    authState.current = partnerAuth;
    getUserPermissions.mockResolvedValue({
      permissions: [
        { resource: 'devices', action: 'read' },
        { resource: 'devices', action: 'execute' },
      ],
      partnerId: 'partner-1',
      orgId: null,
      roleId: 'role-custom',
      scope: 'partner',
    });

    const res = await postSession(buildApp());

    expect(res.status).toBe(403);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('REMOTE_ACCESS_PERMISSION_REQUIRED');
  });

  // No resolvable role is a membership/context problem, not a missing grant:
  // telling that user "add remote:access to your role" would send them the
  // wrong way, so it keeps the plain refusal.
  it('a user with no resolvable role keeps the plain 403, not the remote:access denial', async () => {
    authState.current = orgAuth;
    getUserPermissions.mockResolvedValue(null);

    const res = await postSession(buildApp());

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string; code?: string };
    expect(body.code).toBeUndefined();
    expect(body.error).toBe('No permissions found');
  });

  it.each([
    ['Partner Admin', partnerAuth],
    ['Org Technician', orgAuth],
  ])('%s (holds remote:access) passes the gate', async (roleName, auth) => {
    authState.current = auth;
    getUserPermissions.mockResolvedValue({
      permissions: grantsOf(roleName),
      partnerId: auth.partnerId,
      orgId: auth.orgId,
      roleId: 'role-tech',
      scope: auth.scope,
    });

    const res = await postSession(buildApp());

    expect(res.status).toBe(201);
  });

  it('resolves permissions on the caller\'s own scope axis (partner vs org)', async () => {
    authState.current = partnerAuth;
    getUserPermissions.mockResolvedValue(null);
    await postSession(buildApp());
    expect(getUserPermissions).toHaveBeenCalledWith('user-1', {
      partnerId: 'partner-1',
      orgId: undefined,
      scope: 'partner',
    });

    authState.current = orgAuth;
    await postSession(buildApp());
    expect(getUserPermissions).toHaveBeenLastCalledWith('user-1', {
      partnerId: undefined,
      orgId: 'org-1',
      scope: 'organization',
    });
  });
});
