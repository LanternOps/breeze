import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => ({
  authMiddleware: vi.fn(),
  requireScope: vi.fn((..._scopes: string[]) => async (_c: any, next: any) => next()),
  requirePermission: vi.fn((_resource: string, _action: string) => async (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
  requireInteractiveSession: vi.fn(() => async (_c: any, next: any) => next()),
  twoFa: { value: true },
  validateStepUpGrant: vi.fn(),
  getUserEpochs: vi.fn(),
  open: vi.fn(),
  close: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
  audit: vi.fn(),
}));

vi.mock('../db', () => ({
  db: { transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({})) },
}));
vi.mock('../middleware/auth', () => ({
  authMiddleware: mocks.authMiddleware,
  requireScope: mocks.requireScope,
  requirePermission: mocks.requirePermission,
  requireMfa: mocks.requireMfa,
  requireInteractiveSession: mocks.requireInteractiveSession,
}));
vi.mock('./auth/schemas', () => ({
  get ENABLE_2FA() { return mocks.twoFa.value; },
}));
vi.mock('../services/authEpochs', () => ({ getUserEpochs: mocks.getUserEpochs }));
vi.mock('../services/mfaStepUpGrant', async (orig) => ({
  ...(await orig<typeof import('../services/mfaStepUpGrant')>()),
  validateStepUpGrant: mocks.validateStepUpGrant,
}));
vi.mock('../services/auditEvents', () => ({ writeRouteAudit: mocks.audit }));
vi.mock('../services/clientIp', () => ({ getTrustedClientIpOrUndefined: () => '203.0.113.7' }));
vi.mock('../services/migrationWindows', () => ({
  openMigrationWindow: mocks.open,
  closeMigrationWindow: mocks.close,
  listMigrationWindows: mocks.list,
  getMigrationWindow: mocks.get,
  MigrationWindowError: class MigrationWindowError extends Error {
    constructor(public code: string, message: string, public status: number, public details?: Record<string, unknown>) {
      super(message);
    }
  },
}));
vi.mock('../services/permissions', () => ({
  PERMISSIONS: {
    ORGS_READ: { resource: 'organizations', action: 'read' },
    ORGS_WRITE: { resource: 'organizations', action: 'write' },
  },
  hasPermission: (perms: { permissions: Array<{ resource: string; action: string }> }, resource: string, action: string) =>
    perms.permissions.some((p) => (p.resource === '*' || p.resource === resource) && (p.action === '*' || p.action === action)),
}));

import { MigrationWindowError } from '../services/migrationWindows';
import { migrationWindowOpenResourceDigest } from '../services/mfaStepUpGrant';
import { migrationWindowRoutes } from './migrationWindows';

const PARTNER_ID = '11111111-1111-4111-8111-111111111111';
const PRINCIPAL_ID = '22222222-2222-4222-8222-222222222222';
const WINDOW_ID = '33333333-3333-4333-8333-333333333333';
const USER_ID = '44444444-4444-4444-8444-444444444444';
const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ENDS_AT = '2030-01-10T12:00:00.000Z';

const registeredScopeCalls = mocks.requireScope.mock.calls.map((call) => call.map(String));
const registeredPermissionCalls = mocks.requirePermission.mock.calls.map((call) => call.map(String));
const registeredInteractiveCount = mocks.requireInteractiveSession.mock.calls.length;

function auth(opts: { orgAccess?: 'all' | 'selected'; permissions?: Array<{ resource: string; action: string }>; aep?: unknown } = {}) {
  mocks.authMiddleware.mockImplementation((c: any, next: any) => {
    c.set('auth', {
      scope: 'partner',
      partnerId: PARTNER_ID,
      partnerOrgAccess: opts.orgAccess ?? 'all',
      user: { id: USER_ID, email: 'owner@example.test' },
      token: { mfa: true, aep: opts.aep === undefined ? 3 : opts.aep, mep: 2, sid: 'session-1' },
    });
    c.set('permissions', { permissions: opts.permissions ?? [{ resource: '*', action: '*' }] });
    return next();
  });
}

function app() {
  const a = new Hono();
  a.route('/migration-windows', migrationWindowRoutes);
  return a;
}

const openBody = (extra: Record<string, unknown> = {}) => ({
  principalId: PRINCIPAL_ID,
  orgIds: [ORG_B, ORG_A],
  endsAt: ENDS_AT,
  sourceLabel: 'zammad',
  stepUpGrant: 'grant-1',
  ...extra,
});

const view = { id: WINDOW_ID, partnerId: PARTNER_ID, principalId: PRINCIPAL_ID, sourceLabel: 'zammad', orgIds: [ORG_A, ORG_B], openedAt: '2030-01-01T12:00:00.000Z', endsAt: ENDS_AT, writesPerHour: 6000 };

function post(path: string, body: unknown) {
  return app().request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

describe('migration window routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.twoFa.value = true;
    auth();
    mocks.getUserEpochs.mockResolvedValue({ authEpoch: 3, mfaEpoch: 2 });
    mocks.validateStepUpGrant.mockResolvedValue(true);
    mocks.open.mockResolvedValue(view);
  });

  it('mounts every route behind partner/system scope with organizations permissions, and open behind an interactive session', () => {
    expect(registeredScopeCalls.every((call) => call.join(',') === 'partner,system')).toBe(true);
    expect(registeredPermissionCalls).toEqual(expect.arrayContaining([
      ['organizations', 'read'], ['organizations', 'write'],
    ]));
    expect(registeredInteractiveCount).toBe(1);
  });

  it('refuses every route to an admin without full partner org access', async () => {
    auth({ orgAccess: 'selected' });
    expect((await post('/migration-windows', openBody())).status).toBe(403);
    expect((await post(`/migration-windows/${WINDOW_ID}/close`, {})).status).toBe(403);
    expect((await app().request('/migration-windows')).status).toBe(403);
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.close).not.toHaveBeenCalled();
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it('refuses to open without tickets:write, the permission the delegation table requires', async () => {
    auth({ permissions: [{ resource: 'organizations', action: 'write' }] });
    const res = await post('/migration-windows', openBody());
    expect(res.status).toBe(403);
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it('binds the step-up grant to the window, independent of org order', async () => {
    await post('/migration-windows', openBody({ orgIds: [ORG_B, ORG_A] }));
    await post('/migration-windows', openBody({ orgIds: [ORG_A, ORG_B, ORG_A] }));
    const digests = mocks.validateStepUpGrant.mock.calls.map((call) => call[1].resourceDigest);
    const expected = migrationWindowOpenResourceDigest({
      partnerId: PARTNER_ID, principalId: PRINCIPAL_ID, orgIds: [ORG_A, ORG_B], endsAt: ENDS_AT,
    });
    expect(digests).toEqual([expected, expected]);
    expect(mocks.validateStepUpGrant.mock.calls[0]![1]).toMatchObject({
      userId: USER_ID, operation: 'migration_window_open', authEpoch: 3, mfaEpoch: 2, sid: 'session-1',
    });
    // A wider or longer window is a different digest.
    expect(migrationWindowOpenResourceDigest({
      partnerId: PARTNER_ID, principalId: PRINCIPAL_ID, orgIds: [ORG_A], endsAt: ENDS_AT,
    })).not.toBe(expected);
    expect(migrationWindowOpenResourceDigest({
      partnerId: PARTNER_ID, principalId: PRINCIPAL_ID, orgIds: [ORG_A, ORG_B], endsAt: ENDS_AT, writesPerHour: 20000,
    })).not.toBe(expected);
  });

  it('refuses to open without a valid step-up grant, and passes the grant to the service otherwise', async () => {
    const missing = await post('/migration-windows', openBody({ stepUpGrant: undefined }));
    expect(missing.status).toBe(403);
    expect((await missing.json()).code).toBe('STEP_UP_REQUIRED');
    mocks.validateStepUpGrant.mockResolvedValueOnce(false);
    expect((await post('/migration-windows', openBody())).status).toBe(403);
    expect(mocks.open).not.toHaveBeenCalled();

    const ok = await post('/migration-windows', openBody());
    expect(ok.status).toBe(201);
    expect(mocks.open).toHaveBeenCalledWith(expect.objectContaining({
      partnerId: PARTNER_ID,
      principalId: PRINCIPAL_ID,
      orgIds: [ORG_B, ORG_A],
      endsAt: new Date(ENDS_AT),
      sourceLabel: 'zammad',
      opener: { userId: USER_ID, authEpoch: 3, mfaEpoch: 2 },
      stepUp: expect.objectContaining({ grantId: 'grant-1' }),
    }));
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      orgId: null, action: 'migration_window.opened', resourceId: WINDOW_ID,
      details: expect.objectContaining({ orgIds: [ORG_A, ORG_B], partnerServicePrincipalId: PRINCIPAL_ID }),
    }));
  });

  it('needs no step-up grant when two-factor authentication is off', async () => {
    mocks.twoFa.value = false;
    const res = await post('/migration-windows', openBody({ stepUpGrant: undefined }));
    expect(res.status).toBe(201);
    expect(mocks.validateStepUpGrant).not.toHaveBeenCalled();
    expect(mocks.open).toHaveBeenCalledWith(expect.objectContaining({ stepUp: null }));
  });

  it('refuses a session without numeric epochs', async () => {
    auth({ aep: undefined });
    mocks.authMiddleware.mockImplementation((c: any, next: any) => {
      c.set('auth', { scope: 'partner', partnerId: PARTNER_ID, partnerOrgAccess: 'all', user: { id: USER_ID }, token: { sid: 's' } });
      c.set('permissions', { permissions: [{ resource: '*', action: '*' }] });
      return next();
    });
    expect((await post('/migration-windows', openBody())).status).toBe(401);
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it.each([
    ['SERVICE_PRINCIPAL_OWNER_REQUIRED', 403],
    ['MIGRATION_WINDOW_PRINCIPAL_HAS_KEY', 409],
    ['MIGRATION_WINDOW_PRINCIPAL_INACTIVE', 409],
    ['MIGRATION_WINDOW_ALREADY_OPEN', 409],
    ['MIGRATION_WINDOW_INVALID_SPAN', 400],
  ] as const)('maps %s from the service to %i', async (code, status) => {
    mocks.open.mockRejectedValueOnce(new MigrationWindowError(code as any, 'refused', status));
    const res = await post('/migration-windows', openBody());
    expect(res.status).toBe(status);
    expect((await res.json()).code).toBe(code);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('names the refused orgs', async () => {
    mocks.open.mockRejectedValueOnce(new MigrationWindowError('MIGRATION_WINDOW_ORG_NOT_ALLOWED' as any, 'refused', 403, { orgIds: [ORG_B] }));
    const res = await post('/migration-windows', openBody());
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'MIGRATION_WINDOW_ORG_NOT_ALLOWED', details: { orgIds: [ORG_B] } });
  });

  it('rejects unknown body fields, an empty org list and an over-long label', async () => {
    expect((await post('/migration-windows', openBody({ status: 'open' }))).status).toBe(400);
    expect((await post('/migration-windows', openBody({ orgIds: [] }))).status).toBe(400);
    expect((await post('/migration-windows', openBody({ sourceLabel: 'x'.repeat(65) }))).status).toBe(400);
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it('lets any partner-wide admin close a window, with the request metadata for the audit row', async () => {
    mocks.close.mockResolvedValueOnce({ window: { ...view, status: 'closed' }, alreadyClosed: false });
    const res = await post(`/migration-windows/${WINDOW_ID}/close`, {});
    expect(res.status).toBe(200);
    expect(mocks.close).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      windowId: WINDOW_ID,
      partnerId: PARTNER_ID,
      reason: 'closed_by_admin',
      closedBy: USER_ID,
      audit: expect.objectContaining({ actorEmail: 'owner@example.test', ipAddress: '203.0.113.7' }),
    }));
    // No route audit here: the service writes it inside the close transaction.
    expect(mocks.audit).not.toHaveBeenCalled();

    mocks.close.mockResolvedValueOnce(null);
    expect((await post(`/migration-windows/${WINDOW_ID}/close`, {})).status).toBe(404);
  });

  it('lists and reads windows of the caller\'s partner only', async () => {
    mocks.list.mockResolvedValueOnce([view]);
    const list = await app().request('/migration-windows');
    expect(list.status).toBe(200);
    expect(mocks.list).toHaveBeenCalledWith(PARTNER_ID);
    expect((await app().request('/migration-windows?partnerId=99999999-9999-4999-8999-999999999999')).status).toBe(403);
    mocks.get.mockResolvedValueOnce(null);
    expect((await app().request(`/migration-windows/${WINDOW_ID}`)).status).toBe(404);
  });
});
