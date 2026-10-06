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
    DEVICES_READ: { resource: 'devices', action: 'read' },
    DEVICES_WRITE: { resource: 'devices', action: 'write' },
    DEVICES_EXECUTE: { resource: 'devices', action: 'execute' },
    SCRIPTS_READ: { resource: 'scripts', action: 'read' },
    SCRIPTS_WRITE: { resource: 'scripts', action: 'write' },
    SCRIPTS_EXECUTE: { resource: 'scripts', action: 'execute' },
    ALERTS_READ: { resource: 'alerts', action: 'read' },
    ALERTS_WRITE: { resource: 'alerts', action: 'write' },
    AUTOMATIONS_READ: { resource: 'automations', action: 'read' },
    AUTOMATIONS_WRITE: { resource: 'automations', action: 'write' },
    REPORTS_READ: { resource: 'reports', action: 'read' },
    REPORTS_WRITE: { resource: 'reports', action: 'write' },
    USERS_READ: { resource: 'users', action: 'read' },
    ADMIN_ALL: { resource: '*', action: '*' },
  },
  hasPermission: (perms: { permissions: Array<{ resource: string; action: string }> }, resource: string, action: string) =>
    perms.permissions.some((p) => (p.resource === '*' || p.resource === resource) && (p.action === '*' || p.action === action)),
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
    // partnerOrgAccess: 'all' — these routes mint partner-wide machine
    // credentials, so every mutation now requires the full-partner capability
    // (security review 2026-08-16 §1.1 #6). The denial cases live in
    // partnerServicePrincipals.partnerWide.test.ts.
    c.set('auth', { scope, partnerId, partnerOrgAccess: 'all', user: { id: USER_ID, email: 'admin@example.com' }, token: { mfa: true } });
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
    vi.mocked(db.select).mockReset();
    vi.mocked(db.insert).mockReset();
    vi.mocked(db.update).mockReset();
    vi.mocked(db.transaction).mockReset();
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
    selectRows([{ scopes: ['devices:read'], sourceCidrs: [], expiresAt: null }], []);
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
    [{ name: 'Write without controls', scopes: ['enrollment-keys:write'], sourceCidrs: [], expiresAt: null }],
    [{ name: 'Write without expiry', scopes: ['enrollment-keys:write'], sourceCidrs: ['203.0.113.0/24'], expiresAt: null }],
    [{ name: 'Write without CIDR', scopes: ['enrollment-keys:write'], sourceCidrs: [], expiresAt: '2027-01-01T00:00:00.000Z' }],
  ])('rejects enrollment-key write principals without both security controls', async (payload) => {
    const res = await app.request('/partner-service-principals', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'ENROLLMENT_KEY_SCOPE_RESTRICTIONS_REQUIRED' });
  });

  it('validates effective PATCH state when adding the write scope', async () => {
    selectRows([{ scopes: ['devices:read'], sourceCidrs: [], expiresAt: null }]);
    const res = await app.request(`/partner-service-principals/${PRINCIPAL_ID}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scopes: ['devices:read', 'enrollment-keys:write'] }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'ENROLLMENT_KEY_SCOPE_RESTRICTIONS_REQUIRED' });
    expect(db.update).not.toHaveBeenCalled();
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

  describe('MCP (ai:*) scopes are a delegation the acting admin must hold', () => {
    function permissionsOf(perms: Array<{ resource: string; action: string }>) {
      mocks.authMiddleware.mockImplementation((c: any, next: any) => {
        c.set('auth', { scope: 'partner', partnerId: PARTNER_ID, partnerOrgAccess: 'all', user: { id: USER_ID }, token: { mfa: true } });
        c.set('permissions', { permissions: perms });
        return next();
      });
    }
    const READ_ONLY = [
      { resource: 'organizations', action: 'write' },
      { resource: 'devices', action: 'read' }, { resource: 'alerts', action: 'read' },
      { resource: 'scripts', action: 'read' }, { resource: 'automations', action: 'read' },
    ];

    it('refuses to create an ai:execute_admin principal for an admin without admin:all, before any write', async () => {
      permissionsOf(READ_ONLY);
      const res = await app.request('/partner-service-principals', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'claude-automation', scopes: ['ai:read', 'ai:execute_admin'], sourceCidrs: [] }),
      });
      expect(res.status).toBe(403);
      expect((await res.json()).error).toMatch(/ai:execute_admin/);
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('lets a read-capable admin create an ai:read principal', async () => {
      permissionsOf(READ_ONLY);
      selectRows([]);
      const returning = vi.fn().mockResolvedValue([{ id: PRINCIPAL_ID, name: 'reader', scopes: ['ai:read'] }]);
      vi.mocked(db.insert).mockReturnValue({
        values: vi.fn(() => ({ onConflictDoNothing: vi.fn(() => ({ returning })) })),
      } as any);
      const res = await app.request('/partner-service-principals', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'reader', scopes: ['ai:read'], sourceCidrs: [] }),
      });
      expect(res.status).toBe(201);
    });

    it('refuses a PATCH that adds ai:write for an admin without the write baseline, before any update', async () => {
      permissionsOf(READ_ONLY);
      const res = await app.request(`/partner-service-principals/${PRINCIPAL_ID}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scopes: ['ai:read', 'ai:write'] }),
      });
      expect(res.status).toBe(403);
      expect(db.update).not.toHaveBeenCalled();
    });

    it.each([['ai:write'], ['ai:execute'], ['ai:execute_admin']])('rejects %s without ai:read on create and update, before any write', async (scope) => {
      const created = await app.request('/partner-service-principals', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'no-read', scopes: [scope], sourceCidrs: [] }),
      });
      expect(created.status).toBe(400);
      expect(await created.json()).toMatchObject({ code: 'MCP_SCOPE_REQUIRES_AI_READ' });
      const updated = await app.request(`/partner-service-principals/${PRINCIPAL_ID}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scopes: ['devices:read', scope] }),
      });
      expect(updated.status).toBe(400);
      expect(await updated.json()).toMatchObject({ code: 'MCP_SCOPE_REQUIRES_AI_READ' });
      expect(db.insert).not.toHaveBeenCalled();
      expect(db.update).not.toHaveBeenCalled();
    });

    it('refuses to ISSUE a key for a principal holding MCP scopes the acting admin cannot delegate', async () => {
      permissionsOf(READ_ONLY);
      selectRows([{ scopes: ['ai:read', 'ai:execute_admin'] }]);
      mocks.issue.mockResolvedValue({ keyId: KEY_ID, rawKey: 'brz_sp_ONETIME', keyPrefix: 'brz_sp_ONE' });
      const res = await app.request(`/partner-service-principals/${PRINCIPAL_ID}/keys`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'escalate' }),
      });
      expect(res.status).toBe(403);
      expect(JSON.stringify(await res.json())).not.toContain('ONETIME');
      expect(mocks.issue).not.toHaveBeenCalled();
    });

    it('refuses to ROTATE a key for a principal holding MCP scopes the acting admin cannot delegate', async () => {
      permissionsOf(READ_ONLY);
      selectRows([{ scopes: ['ai:read', 'ai:write'] }]);
      mocks.rotate.mockResolvedValue({ keyId: KEY_ID, rawKey: 'brz_sp_NEW', keyPrefix: 'brz_sp_NEW' });
      vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn({}));
      const res = await app.request(`/partner-service-principals/${PRINCIPAL_ID}/keys/${KEY_ID}/rotate`, { method: 'POST' });
      expect(res.status).toBe(403);
      expect(mocks.rotate).not.toHaveBeenCalled();
    });

    it('lets a read-capable admin issue a key for an ai:read principal', async () => {
      permissionsOf(READ_ONLY);
      selectRows([{ scopes: ['ai:read'] }]);
      mocks.issue.mockResolvedValue({ keyId: KEY_ID, rawKey: 'brz_sp_ONETIME', keyPrefix: 'brz_sp_ONE' });
      const res = await app.request(`/partner-service-principals/${PRINCIPAL_ID}/keys`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'ok' }),
      });
      expect(res.status).toBe(201);
    });

    const EXISTING_STRONG = {
      scopes: ['ai:read', 'ai:execute_admin'], sourceCidrs: ['203.0.113.0/24'],
      expiresAt: new Date(Date.now() + 86_400_000), status: 'disabled',
    };

    it.each([
      ['re-enables', { status: 'active' }],
      ['removes the expiry', { expiresAt: null }],
      ['extends the expiry', { expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString() }],
      ['removes the CIDR restriction', { sourceCidrs: [] }],
      ['adds a CIDR', { sourceCidrs: ['203.0.113.0/24', '198.51.100.0/24'] }],
    ])('refuses a scope-omitting PATCH that %s a principal the admin cannot delegate', async (_label, body) => {
      permissionsOf(READ_ONLY);
      selectRows([EXISTING_STRONG]);
      const res = await app.request(`/partner-service-principals/${PRINCIPAL_ID}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      expect(res.status).toBe(403);
      expect((await res.json()).error).toMatch(/ai:execute_admin/);
      expect(db.update).not.toHaveBeenCalled();
    });

    it.each([
      ['disables', { status: 'disabled' }, 'active'],
      ['shortens the expiry', { expiresAt: new Date(Date.now() + 3_600_000).toISOString() }, 'active'],
      ['narrows the CIDRs', { sourceCidrs: ['203.0.113.0/25'] }, 'active'],
    ])('still lets a lower-privileged admin tighten: %s', async (_label, body, status) => {
      permissionsOf(READ_ONLY);
      selectRows([{ ...EXISTING_STRONG, status, sourceCidrs: ['203.0.113.0/24', '203.0.113.0/25'] }]);
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn(() => ({
          where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([{ id: PRINCIPAL_ID, name: 'p' }]) })),
        })),
      } as any);
      vi.mocked(db.transaction).mockImplementation(async (callback: any) => callback({ update: db.update }));
      const res = await app.request(`/partner-service-principals/${PRINCIPAL_ID}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      expect(res.status).toBe(200);
    });

    it('lets a full admin grant every MCP scope', async () => {
      selectRows([]);
      const returning = vi.fn().mockResolvedValue([{ id: PRINCIPAL_ID, name: 'claude-automation', scopes: [] }]);
      vi.mocked(db.insert).mockReturnValue({
        values: vi.fn(() => ({ onConflictDoNothing: vi.fn(() => ({ returning })) })),
      } as any);
      const res = await app.request('/partner-service-principals', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'claude-automation', scopes: ['ai:read', 'ai:write', 'ai:execute', 'ai:execute_admin'], sourceCidrs: [] }),
      });
      expect(res.status).toBe(201);
    });
  });

  it('issues a key and audits only sanitized identifiers', async () => {
    selectRows([{ scopes: ['devices:read'] }]); // principal's scopes for the delegation ceiling
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
    selectRows([{ scopes: ['devices:read'] }]); // principal's scopes for the delegation ceiling
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
