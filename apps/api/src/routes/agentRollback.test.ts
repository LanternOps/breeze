import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => ({
  authMiddleware: vi.fn(),
  requireScope: vi.fn((...allowed: string[]) => async (c: any, next: any) => (
    allowed.includes(c.get('auth')?.scope)
      ? next()
      : c.json({ error: 'Insufficient scope' }, 403)
  )),
  requirePermission: vi.fn((resource: string, action: string) => async (c: any, next: any) => {
    c.set('permissions', {
      permissions: [{ resource, action }],
      scope: 'organization',
      orgId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });
    return next();
  }),
  requireMfa: vi.fn(() => async (c: any, next: any) => {
    if (c.get('auth')?.token?.mfa !== true) return c.json({ error: 'MFA required' }, 403);
    return next();
  }),
  getDevice: vi.fn(),
  canAccessSite: vi.fn(() => true),
  getUserEpochs: vi.fn(),
  createRollback: vi.fn(),
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: mocks.authMiddleware,
  requireScope: mocks.requireScope,
  requirePermission: mocks.requirePermission,
  requireMfa: mocks.requireMfa,
  isInteractiveUserSession: (auth: any) => auth?.principal?.kind === 'user_session',
}));
vi.mock('./devices/helpers', () => ({
  getDeviceWithOrgCheck: mocks.getDevice,
  canAccessDeviceSite: mocks.canAccessSite,
}));
vi.mock('../services/authEpochs', () => ({ getUserEpochs: mocks.getUserEpochs }));
vi.mock('../services/agentRollback', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/agentRollback')>()),
  createAgentRollbackDirective: mocks.createRollback,
}));

import { AgentRollbackValidationError } from '../services/agentRollback';
import { agentRollbackRoutes } from './agentRollback';

const registeredScopeCalls = mocks.requireScope.mock.calls.map((call) => call.map(String));
const registeredPermissionCalls = mocks.requirePermission.mock.calls.map((call) => call.map(String));
const registeredMfaCalls = mocks.requireMfa.mock.calls.length;

const DEVICE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const USER_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const GRANT_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function auth(overrides: Record<string, unknown> = {}) {
  return {
    principal: { kind: 'user_session' },
    user: { id: USER_ID, email: 'admin@example.com' },
    token: { mfa: true, sid: 'session-1' },
    scope: 'organization',
    orgId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    partnerId: null,
    canAccessOrg: () => true,
    ...overrides,
  };
}

function request(app: Hono) {
  return app.request(`/devices/${DEVICE_ID}/agent-rollback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ targetVersion: '1.9.0', reason: 'Known regression', stepUpGrant: GRANT_ID }),
  });
}

describe('POST /devices/:id/agent-rollback', () => {
  let app: Hono;
  let currentAuth: ReturnType<typeof auth>;

  beforeEach(() => {
    vi.clearAllMocks();
    currentAuth = auth();
    mocks.authMiddleware.mockImplementation((c: any, next: any) => {
      c.set('auth', currentAuth);
      return next();
    });
    mocks.getDevice.mockResolvedValue({ id: DEVICE_ID, orgId: currentAuth.orgId, siteId: null });
    mocks.canAccessSite.mockReturnValue(true);
    mocks.getUserEpochs.mockResolvedValue({ authEpoch: 7, mfaEpoch: 9 });
    mocks.createRollback.mockResolvedValue({ rollbackId: 'rollback-1', directiveSignature: 'sig' });
    app = new Hono();
    app.route('/devices', agentRollbackRoutes);
  });

  it('registers organization/partner, agent_rollback:create, and MFA gates', () => {
    expect(registeredScopeCalls).toContainEqual(['organization', 'partner']);
    expect(registeredPermissionCalls).toContainEqual(['agent_rollback', 'create']);
    expect(registeredMfaCalls).toBeGreaterThan(0);
  });

  it.each(['organization', 'partner'])('creates through the atomic service for an authorized %s admin', async (scope) => {
    currentAuth = auth({ scope });
    const response = await request(app);
    expect(response.status).toBe(202);
    expect(mocks.createRollback).toHaveBeenCalledWith({
      deviceId: DEVICE_ID,
      targetVersion: '1.9.0',
      reason: 'Known regression',
      authorizedBy: USER_ID,
      stepUpGrantId: GRANT_ID,
      authEpoch: 7,
      mfaEpoch: 9,
      sid: 'session-1',
    });
  });

  it('denies system scope because only tenant administrators may authorize rollback', async () => {
    currentAuth = auth({ scope: 'system' });
    const response = await request(app);
    expect(response.status).toBe(403);
    expect(mocks.createRollback).not.toHaveBeenCalled();
  });

  it('returns not found for a foreign or unknown device with zero writes', async () => {
    mocks.getDevice.mockResolvedValue(null);
    const response = await request(app);
    expect(response.status).toBe(404);
    expect(mocks.createRollback).not.toHaveBeenCalled();
  });

  it('denies a site-restricted actor with zero writes', async () => {
    mocks.canAccessSite.mockReturnValue(false);
    const response = await request(app);
    expect(response.status).toBe(403);
    expect(mocks.createRollback).not.toHaveBeenCalled();
  });

  it.each(['api_key', 'oauth_grant', 'client_user', 'ai_agent'])('denies non-interactive %s authority', async (kind) => {
    currentAuth = auth({ principal: { kind } });
    const response = await request(app);
    expect(response.status).toBe(403);
    expect(mocks.createRollback).not.toHaveBeenCalled();
  });

  it('requires an MFA-satisfied session', async () => {
    currentAuth = auth({ token: { mfa: false, sid: 'session-1' } });
    const response = await request(app);
    expect(response.status).toBe(403);
    expect(mocks.createRollback).not.toHaveBeenCalled();
  });

  it('fails closed when live epochs or the session binding are unavailable', async () => {
    mocks.getUserEpochs.mockResolvedValue(null);
    const response = await request(app);
    expect(response.status).toBe(503);
    expect(mocks.createRollback).not.toHaveBeenCalled();
  });

  it('maps stale or wrong-resource grants to forbidden with zero writes', async () => {
    mocks.createRollback.mockRejectedValue(new AgentRollbackValidationError('step-up grant is stale'));
    const response = await request(app);
    expect(response.status).toBe(403);
  });
});
