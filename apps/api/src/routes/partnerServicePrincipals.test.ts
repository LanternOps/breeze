import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => ({
  gateOrder: [] as string[],
  authMiddleware: vi.fn(),
  requireScope: vi.fn((...scopes: string[]) => async (_c: any, next: any) => {
    mocks.gateOrder.push(`scope:${scopes.join(',')}`);
    return next();
  }),
  permissionAllowed: { value: true },
  mfaAllowed: { value: true },
  requirePermission: vi.fn((resource: string, action: string) => async (c: any, next: any) => {
    mocks.gateOrder.push(`permission:${resource}:${action}`);
    return mocks.permissionAllowed.value ? next() : c.json({ error: 'Insufficient permissions' }, 403);
  }),
  requireMfa: vi.fn(() => async (c: any, next: any) => {
    mocks.gateOrder.push('mfa');
    return mocks.mfaAllowed.value ? next() : c.json({ error: 'MFA required' }, 403);
  }),
  issue: vi.fn(),
  rotate: vi.fn(),
  audit: vi.fn(),
}));

vi.mock('../db', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), transaction: vi.fn() },
}));
vi.mock('../db/schema', () => ({
  partnerServicePrincipals: {
    id: 'id', partnerId: 'partnerId', name: 'name', description: 'description',
    status: 'status', scopes: 'scopes', expiresAt: 'expiresAt', sourceCidrs: 'sourceCidrs',
    createdBy: 'createdBy', updatedBy: 'updatedBy', createdAt: 'createdAt', updatedAt: 'updatedAt',
  },
  partnerServicePrincipalKeys: {
    id: 'id', partnerId: 'partnerId', partnerServicePrincipalId: 'partnerServicePrincipalId', name: 'name',
    keyPrefix: 'keyPrefix', status: 'status', expiresAt: 'expiresAt', rateLimit: 'rateLimit',
    lastUsedAt: 'lastUsedAt', revokedAt: 'revokedAt', rotatedFromId: 'rotatedFromId', createdAt: 'createdAt',
  },
}));
vi.mock('../middleware/auth', () => ({
  authMiddleware: mocks.authMiddleware,
  requireScope: mocks.requireScope,
  requirePermission: mocks.requirePermission,
  requireMfa: mocks.requireMfa,
}));
vi.mock('../services/partnerServicePrincipalKeys', () => ({
  issuePartnerServicePrincipalKey: mocks.issue,
  rotatePartnerServicePrincipalKey: mocks.rotate,
  PartnerServicePrincipalKeyError: class PartnerServicePrincipalKeyError extends Error {
    code: string; status: number;
    constructor(code: string, message: string, status = 400) { super(message); this.code = code; this.status = status; }
  },
}));
vi.mock('../services/auditEvents', () => ({ writeRouteAudit: mocks.audit }));
vi.mock('../services/permissions', () => ({
  PERMISSIONS: {
    ORGS_READ: { resource: 'organizations', action: 'read' },
    ORGS_WRITE: { resource: 'organizations', action: 'write' },
  },
}));

import { db } from '../db';
import { partnerServicePrincipalRoutes } from './partnerServicePrincipals';

const registeredScopeCalls: string[][] = mocks.requireScope.mock.calls.map((call) => call.map(String));
const registeredPermissionCalls: string[][] = mocks.requirePermission.mock.calls.map((call) => call.map(String));
const registeredMfaCount = mocks.requireMfa.mock.calls.length;

const PARTNER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_PARTNER_ID = '99999999-9999-4999-8999-999999999999';
const PRINCIPAL_ID = '22222222-2222-4222-8222-222222222222';
const KEY_ID = '33333333-3333-4333-8333-333333333333';
const USER_ID = '44444444-4444-4444-8444-444444444444';

function auth(partnerId: string | null = PARTNER_ID, scope = 'partner') {
  mocks.authMiddleware.mockImplementation((c: any, next: any) => {
    mocks.gateOrder.push('auth');
    c.set('auth', { scope, partnerId, user: { id: USER_ID, email: 'admin@example.com' }, token: { mfa: true } });
    c.set('permissions', { permissions: [{ resource: '*', action: '*' }] });
    return next();
  });
}

function selectRows(...rows: unknown[][]) {
  for (const result of rows) {
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn(() => ({
        where: vi.fn(() => {
          const promise: any = Promise.resolve(result);
          promise.limit = vi.fn(async () => result);
          promise.orderBy = vi.fn(async () => result);
          return promise;
        }),
      })),
    } as any);
  }
}

describe('service principal management routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.gateOrder.length = 0;
    mocks.permissionAllowed.value = true;
    mocks.mfaAllowed.value = true;
    auth();
    app = new Hono();
    app.route('/partner-service-principals', partnerServicePrincipalRoutes);
  });

  it('registers partner/system, administrator permission, and MFA gates', () => {
    expect(registeredScopeCalls.some((call) => call.includes('partner') && call.includes('system'))).toBe(true);
    expect(registeredPermissionCalls.some((call) => call.join(':') === 'organizations:read')).toBe(true);
    expect(registeredPermissionCalls.some((call) => call.join(':') === 'organizations:write')).toBe(true);
    expect(registeredMfaCount).toBeGreaterThan(0);
  });

  it('lists principals and masked keys without hashes or plaintext', async () => {
    selectRows(
      [{ id: PRINCIPAL_ID, partnerId: PARTNER_ID, name: 'Weavestream', status: 'active', scopes: ['devices:read'] }],
      [{ id: KEY_ID, partnerServicePrincipalId: PRINCIPAL_ID, keyPrefix: 'brz_sp_abc123', status: 'active' }],
    );
    const res = await app.request('/partner-service-principals');
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data[0].keys[0].keyPrefix).toBe('brz_sp_abc123');
    expect(JSON.stringify(body)).not.toMatch(/keyHash|rawKey|"key":/);
  });

  it('rejects duplicate principal names for a partner', async () => {
    selectRows([{ id: PRINCIPAL_ID }]);
    const res = await app.request('/partner-service-principals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Weavestream', scopes: ['devices:read'], sourceCidrs: [] }),
    });
    expect(res.status).toBe(409);
  });

  it('maps a create race suppressed by the database unique constraint to 409', async () => {
    selectRows([]);
    const returning = vi.fn().mockResolvedValue([]);
    const onConflictDoNothing = vi.fn(() => ({ returning }));
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn(() => ({ onConflictDoNothing })),
    } as any);

    const res = await app.request('/partner-service-principals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Concurrent', scopes: ['devices:read'], sourceCidrs: [] }),
    });

    expect(res.status).toBe(409);
    expect(onConflictDoNothing).toHaveBeenCalledOnce();
  });

  it('maps a wrapped name unique violation during rename to 409', async () => {
    selectRows([]);
    const pgError = Object.assign(new Error('duplicate'), {
      code: '23505',
      constraint_name: 'partner_service_principals_partner_name_unique',
    });
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn(() => ({
        where: vi.fn(() => ({ returning: vi.fn().mockRejectedValue({ cause: pgError }) })),
      })),
    } as any);
    vi.mocked(db.transaction).mockImplementation(async (callback: any) => callback({ update: db.update }));

    const res = await app.request(`/partner-service-principals/${PRINCIPAL_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Concurrent rename' }),
    });

    expect(res.status).toBe(409);
  });

  it.each([
    [{ name: 'Bad scope', scopes: ['devices:write'], sourceCidrs: [] }, 'scope'],
    [{ name: 'Bad CIDR', scopes: ['devices:read'], sourceCidrs: ['10.0.0.0/99'] }, 'CIDR'],
  ])('rejects invalid principal input', async (payload, message) => {
    const res = await app.request('/partner-service-principals', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(new RegExp(message, 'i'));
  });

  it('issues a key and audits only sanitized identifiers', async () => {
    mocks.issue.mockResolvedValue({ keyId: KEY_ID, rawKey: 'brz_sp_ONETIME', keyPrefix: 'brz_sp_ONE' });
    const res = await app.request(`/partner-service-principals/${PRINCIPAL_ID}/keys`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Production' }),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ key: 'brz_sp_ONETIME', keyPrefix: 'brz_sp_ONE' });
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      resourceId: KEY_ID,
      details: expect.objectContaining({ principalType: 'partner_service_principal', partnerId: PARTNER_ID, keyId: KEY_ID }),
    }));
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toMatch(/ONETIME|keyHash/);
  });

  it('rotates atomically and reveals only the successor plaintext', async () => {
    mocks.rotate.mockResolvedValue({ keyId: '55555555-5555-4555-8555-555555555555', rawKey: 'brz_sp_NEW', keyPrefix: 'brz_sp_NEW' });
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn({}));
    const res = await app.request(`/partner-service-principals/${PRINCIPAL_ID}/keys/${KEY_ID}/rotate`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect((await res.json()).key).toBe('brz_sp_NEW');
    expect(db.transaction).toHaveBeenCalledOnce();
  });

  it('revokes idempotently and scopes lookup to the current partner', async () => {
    selectRows([{ id: KEY_ID, name: 'Production', status: 'revoked', keyPrefix: 'brz_sp_abc' }]);
    const res = await app.request(`/partner-service-principals/${PRINCIPAL_ID}/keys/${KEY_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, alreadyRevoked: true });
    expect(db.update).not.toHaveBeenCalled();
  });

  it('does not accept another partner identifier from a partner-scoped caller', async () => {
    const res = await app.request(`/partner-service-principals?partnerId=${OTHER_PARTNER_ID}`);
    expect(res.status).toBe(403);
    expect(db.select).not.toHaveBeenCalled();
  });

  it.each([
    ['administrator permission', () => { mocks.permissionAllowed.value = false; }],
    ['MFA', () => { mocks.mfaAllowed.value = false; }],
  ])('rejects mutation without %s', async (_gate, deny) => {
    deny();
    const res = await app.request('/partner-service-principals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Denied', scopes: ['devices:read'], sourceCidrs: [] }),
    });
    expect(res.status).toBe(403);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it.each([
    ['POST principal', '', { method: 'POST', body: JSON.stringify({ name: 'Stack', scopes: ['devices:read'] }) }],
    ['PATCH principal', `/${PRINCIPAL_ID}`, { method: 'PATCH', body: JSON.stringify({ status: 'disabled' }) }],
    ['POST key', `/${PRINCIPAL_ID}/keys`, { method: 'POST', body: JSON.stringify({ name: 'Stack key' }) }],
    ['POST rotation', `/${PRINCIPAL_ID}/keys/${KEY_ID}/rotate`, { method: 'POST' }],
    ['DELETE key', `/${PRINCIPAL_ID}/keys/${KEY_ID}`, { method: 'DELETE' }],
  ])('runs auth, partner/system scope, write permission, and MFA in order for %s', async (_label, path, init) => {
    mocks.mfaAllowed.value = false;
    const res = await app.request(`/partner-service-principals${path}`, {
      ...init,
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(403);
    expect(mocks.gateOrder).toEqual([
      'auth',
      'scope:partner,system',
      'permission:organizations:write',
      'mfa',
    ]);
  });
});
