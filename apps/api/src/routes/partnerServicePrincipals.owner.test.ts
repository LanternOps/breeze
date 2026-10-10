/**
 * Who may change what a partner service principal can do.
 *
 * The principal's MCP authority is its owner's (created_by) live partner role,
 * and its Partner API authority is its stored scopes. So only the owner may
 * hand out more of it: issue or rotate a key, re-enable the principal, add
 * scopes, or loosen its expiry / source CIDRs. Every partner-wide admin can
 * still reduce it (revoke a key, disable, narrow) and rename it. Every scope,
 * not only ai:*, is a delegation the granter must hold.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => ({
  auth: null as any,
  permissions: null as any,
  selectRows: [] as unknown[][],
  select: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  transaction: vi.fn(),
  issue: vi.fn(),
  rotate: vi.fn(),
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn(async (c: any, next: any) => {
    c.set('auth', mocks.auth);
    c.set('permissions', mocks.permissions);
    await next();
  }),
  requireScope: () => async (_c: any, next: any) => next(),
  requirePermission: () => async (_c: any, next: any) => next(),
  requireMfa: () => async (_c: any, next: any) => next(),
}));

vi.mock('../db', () => ({
  db: { select: mocks.select, insert: mocks.insert, update: mocks.update, transaction: mocks.transaction },
}));

vi.mock('../db/schema', () => ({
  partnerServicePrincipals: {
    id: 'id', partnerId: 'partnerId', name: 'name', description: 'description',
    status: 'status', scopes: 'scopes', expiresAt: 'expiresAt', sourceCidrs: 'sourceCidrs',
    createdBy: 'createdBy', updatedBy: 'updatedBy', createdAt: 'createdAt', updatedAt: 'updatedAt',
  },
  partnerServicePrincipalKeys: {
    id: 'id', partnerId: 'partnerId', partnerServicePrincipalId: 'partnerServicePrincipalId',
    name: 'name', keyPrefix: 'keyPrefix', status: 'status', expiresAt: 'expiresAt',
    rateLimit: 'rateLimit', lastUsedAt: 'lastUsedAt', revokedAt: 'revokedAt',
    rotatedFromId: 'rotatedFromId', createdBy: 'createdBy', createdAt: 'createdAt',
  },
}));

vi.mock('../services/partnerServicePrincipalKeys', () => ({
  issuePartnerServicePrincipalKey: mocks.issue,
  rotatePartnerServicePrincipalKey: mocks.rotate,
  PartnerServicePrincipalKeyError: class PartnerServicePrincipalKeyError extends Error {
    code: string; status: number;
    constructor(code: string, message: string, status = 400) { super(message); this.code = code; this.status = status; }
  },
}));

vi.mock('../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));

import { partnerServicePrincipalRoutes } from './partnerServicePrincipals';

const PARTNER_ID = '11111111-1111-4111-8111-111111111111';
const PRINCIPAL_ID = '22222222-2222-4222-8222-222222222222';
const KEY_ID = '33333333-3333-4333-8333-333333333333';
const CALLER_ID = '44444444-4444-4444-8444-444444444444';
const OWNER_ID = '66666666-6666-4666-8666-666666666666';

const FULL = [{ resource: '*', action: '*' }];

function as(userId: string, perms: Array<{ resource: string; action: string }> = FULL, token: Record<string, unknown> = { mfa: true, aep: 3, mep: 2 }) {
  mocks.auth = { scope: 'partner', partnerId: PARTNER_ID, partnerOrgAccess: 'all', user: { id: userId, email: 'a@example.com' }, token };
  mocks.permissions = { permissions: perms, partnerId: PARTNER_ID, orgId: null, roleId: 'r', scope: 'partner' };
}

function principal(overrides: Record<string, unknown> = {}) {
  return {
    createdBy: OWNER_ID,
    scopes: ['devices:read'],
    sourceCidrs: [] as string[],
    expiresAt: null,
    status: 'active',
    ...overrides,
  };
}

function json(method: string, path: string, body?: unknown) {
  const app = new Hono();
  app.route('/partner-service-principals', partnerServicePrincipalRoutes);
  return app.request(`/partner-service-principals${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.selectRows = [];
  mocks.select.mockImplementation(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => {
        const result = mocks.selectRows.shift() ?? [];
        const promise: any = Promise.resolve(result);
        promise.limit = vi.fn(() => {
          const limited: any = Promise.resolve(result);
          limited.for = vi.fn(async () => result);
          return limited;
        });
        promise.orderBy = vi.fn(async () => result);
        return promise;
      }),
    })),
  }));
  mocks.update.mockImplementation(() => ({
    set: vi.fn(() => ({
      where: vi.fn(() => ({ returning: vi.fn(async () => [{ id: PRINCIPAL_ID, name: 'p' }]) })),
    })),
  }));
  mocks.transaction.mockImplementation(async (callback: any) => callback({ update: mocks.update }));
  mocks.issue.mockResolvedValue({ keyId: KEY_ID, rawKey: 'brz_sp_ONETIME', keyPrefix: 'brz_sp_ONE' });
  mocks.rotate.mockResolvedValue({ keyId: KEY_ID, rawKey: 'brz_sp_NEW', keyPrefix: 'brz_sp_NEW' });
  as(CALLER_ID);
});

describe('issuing and rotating keys is the owner\'s action', () => {
  it('refuses to issue a key on a principal the caller does not own', async () => {
    mocks.selectRows.push([principal()]);
    const res = await json('POST', `/${PRINCIPAL_ID}/keys`, { name: 'k' });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('SERVICE_PRINCIPAL_OWNER_REQUIRED');
    expect(JSON.stringify(body)).not.toContain('ONETIME');
    expect(mocks.issue).not.toHaveBeenCalled();
  });

  it('lets the owner issue a key and binds it to the owner\'s current session', async () => {
    as(OWNER_ID);
    mocks.selectRows.push([principal()]);
    const res = await json('POST', `/${PRINCIPAL_ID}/keys`, { name: 'k' });
    expect(res.status).toBe(201);
    expect(mocks.issue).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      actorId: OWNER_ID,
      actorSessionEpochs: { authEpoch: 3, mfaEpoch: 2 },
    }));
  });

  it('refuses to issue when the session carries no epoch claims', async () => {
    as(OWNER_ID, FULL, { mfa: true });
    mocks.selectRows.push([principal()]);
    const res = await json('POST', `/${PRINCIPAL_ID}/keys`, { name: 'k' });
    expect(res.status).toBe(401);
    expect(mocks.issue).not.toHaveBeenCalled();
  });

  it('returns 404 for a principal that does not exist', async () => {
    mocks.selectRows.push([]);
    const res = await json('POST', `/${PRINCIPAL_ID}/keys`, { name: 'k' });
    expect(res.status).toBe(404);
    expect(mocks.issue).not.toHaveBeenCalled();
  });

  it('refuses to rotate a key on a principal the caller does not own', async () => {
    mocks.selectRows.push([principal()]);
    const res = await json('POST', `/${PRINCIPAL_ID}/keys/${KEY_ID}/rotate`);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('SERVICE_PRINCIPAL_OWNER_REQUIRED');
    expect(mocks.rotate).not.toHaveBeenCalled();
  });

  it('lets the owner rotate a key', async () => {
    as(OWNER_ID);
    mocks.selectRows.push([principal()]);
    const res = await json('POST', `/${PRINCIPAL_ID}/keys/${KEY_ID}/rotate`);
    expect(res.status).toBe(200);
    expect(mocks.rotate).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      actorId: OWNER_ID,
      actorSessionEpochs: { authEpoch: 3, mfaEpoch: 2 },
    }));
  });

  it('still lets any partner-wide admin revoke a key', async () => {
    mocks.selectRows.push([{ id: KEY_ID, name: 'k', status: 'active', keyPrefix: 'brz_sp_x' }]);
    const res = await json('DELETE', `/${PRINCIPAL_ID}/keys/${KEY_ID}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, alreadyRevoked: false });
  });

  it('refuses an owner who no longer holds a scope the principal carries', async () => {
    as(OWNER_ID, [{ resource: 'organizations', action: 'write' }, { resource: 'devices', action: 'read' }]);
    mocks.selectRows.push([principal({ scopes: ['devices:read', 'tickets:read'] })]);
    const res = await json('POST', `/${PRINCIPAL_ID}/keys`, { name: 'k' });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain('tickets:read');
    expect(mocks.issue).not.toHaveBeenCalled();
  });
});

describe('PATCH: restoring or widening is the owner\'s action, reducing is anyone\'s', () => {
  it.each([
    ['re-enables', { status: 'active' }, { status: 'disabled' }],
    ['adds a scope', { scopes: ['devices:read', 'alerts:read'] }, {}],
    ['removes the expiry', { expiresAt: null }, { expiresAt: new Date(Date.now() + 86_400_000) }],
    ['removes the CIDR restriction', { sourceCidrs: [] }, { sourceCidrs: ['203.0.113.0/24'] }],
  ])('refuses a non-owner PATCH that %s', async (_label, body, existing) => {
    mocks.selectRows.push([principal(existing)]);
    const res = await json('PATCH', `/${PRINCIPAL_ID}`, body);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('SERVICE_PRINCIPAL_OWNER_REQUIRED');
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it.each([
    ['disables', { status: 'disabled' }, {}],
    ['narrows the scopes', { scopes: ['devices:read'] }, { scopes: ['devices:read', 'tickets:read'] }],
    ['shortens the expiry', { expiresAt: new Date(Date.now() + 3_600_000).toISOString() }, { expiresAt: new Date(Date.now() + 86_400_000) }],
    ['renames', { name: 'renamed' }, {}],
  ])('lets a non-owner partner-wide admin PATCH that %s', async (_label, body, existing) => {
    mocks.selectRows.push([principal(existing)], []);
    const res = await json('PATCH', `/${PRINCIPAL_ID}`, body);
    expect(res.status).toBe(200);
    expect(mocks.update).toHaveBeenCalledOnce();
  });

  it('lets a non-owner narrow scopes they could not grant themselves', async () => {
    as(CALLER_ID, [{ resource: 'organizations', action: 'write' }]);
    mocks.selectRows.push([principal({ scopes: ['devices:read', 'tickets:read', 'tickets:write'] })]);
    const res = await json('PATCH', `/${PRINCIPAL_ID}`, { scopes: ['tickets:read'] });
    expect(res.status).toBe(200);
  });

  it('lets the owner add a scope they hold', async () => {
    as(OWNER_ID);
    mocks.selectRows.push([principal()]);
    const res = await json('PATCH', `/${PRINCIPAL_ID}`, { scopes: ['devices:read', 'tickets:read'] });
    expect(res.status).toBe(200);
  });

  it('refuses the owner adding a scope they do not hold', async () => {
    as(OWNER_ID, [{ resource: 'organizations', action: 'write' }, { resource: 'devices', action: 'read' }]);
    mocks.selectRows.push([principal()]);
    const res = await json('PATCH', `/${PRINCIPAL_ID}`, { scopes: ['devices:read', 'tickets:write'] });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain('tickets:write');
    expect(mocks.update).not.toHaveBeenCalled();
  });
});

describe('every scope granted at creation is a delegation', () => {
  function insertReturns() {
    mocks.insert.mockReturnValue({
      values: vi.fn(() => ({
        onConflictDoNothing: vi.fn(() => ({
          returning: vi.fn(async () => [{ id: PRINCIPAL_ID, name: 'n', scopes: ['tickets:read'] }]),
        })),
      })),
    });
  }

  it('refuses tickets:read for an admin whose role lacks tickets.read', async () => {
    as(CALLER_ID, [{ resource: 'organizations', action: 'write' }, { resource: 'organizations', action: 'read' }]);
    insertReturns();
    const res = await json('POST', '', { name: 'n', scopes: ['tickets:read', 'tickets:write'], sourceCidrs: [] });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain('tickets:read');
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it('allows tickets:read for an admin who holds tickets.read', async () => {
    as(CALLER_ID, [{ resource: 'organizations', action: 'write' }, { resource: 'tickets', action: 'read' }]);
    mocks.selectRows.push([]);
    insertReturns();
    const res = await json('POST', '', { name: 'n', scopes: ['tickets:read'], sourceCidrs: [] });
    expect(res.status).toBe(201);
  });
});
