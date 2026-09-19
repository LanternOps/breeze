import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const {
  authRef,
  selectRowsRef,
  dbSelectMock,
  dbInsertMock,
  dbUpdateMock,
  dbTransactionMock,
  issueKeyMock,
  rotateKeyMock,
} = vi.hoisted(() => ({
  authRef: {
    current: {
      scope: 'partner' as const,
      partnerId: 'p-1' as string | null,
      partnerOrgAccess: 'all' as 'all' | 'selected' | 'none' | null | undefined,
      user: { id: 'u-1', email: 'admin@example.com' },
    },
  },
  selectRowsRef: { current: [] as unknown[][] },
  dbSelectMock: vi.fn(),
  dbInsertMock: vi.fn(),
  dbUpdateMock: vi.fn(),
  dbTransactionMock: vi.fn(),
  issueKeyMock: vi.fn(),
  rotateKeyMock: vi.fn(),
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn(async (c: any, next: any) => {
    c.set('auth', authRef.current);
    await next();
  }),
  requireScope: () => async (_c: any, next: any) => next(),
  requirePermission: () => async (_c: any, next: any) => next(),
  requireMfa: () => async (_c: any, next: any) => next(),
}));

vi.mock('../db', () => ({
  db: {
    select: dbSelectMock,
    insert: dbInsertMock,
    update: dbUpdateMock,
    transaction: dbTransactionMock,
  },
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
    rotatedFromId: 'rotatedFromId', createdAt: 'createdAt',
  },
}));

vi.mock('../services/partnerServicePrincipalKeys', () => ({
  issuePartnerServicePrincipalKey: issueKeyMock,
  rotatePartnerServicePrincipalKey: rotateKeyMock,
  PartnerServicePrincipalKeyError: class PartnerServicePrincipalKeyError extends Error {
    code: string;
    status: number;
    constructor(code: string, message: string, status = 400) {
      super(message);
      this.code = code;
      this.status = status;
    }
  },
}));

vi.mock('../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
vi.mock('../services/permissions', () => ({
  PERMISSIONS: {
    ORGS_READ: { resource: 'organizations', action: 'read' },
    ORGS_WRITE: { resource: 'organizations', action: 'write' },
  },
}));

import { PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../services/partnerWideAccess';
import { partnerServicePrincipalRoutes } from './partnerServicePrincipals';

const PRINCIPAL_ID = '22222222-2222-4222-8222-222222222222';
const KEY_ID = '33333333-3333-4333-8333-333333333333';
const SUCCESSOR_KEY_ID = '44444444-4444-4444-8444-444444444444';

function setPartnerOrgAccess(value: 'all' | 'selected' | 'none' | undefined) {
  authRef.current = {
    scope: 'partner',
    partnerId: 'p-1',
    partnerOrgAccess: value,
    user: { id: 'u-1', email: 'admin@example.com' },
  };
}

function makeApp() {
  const app = new Hono();
  app.route('/partner-service-principals', partnerServicePrincipalRoutes);
  return app;
}

function queueSelectRows(...rows: unknown[][]) {
  selectRowsRef.current.push(...rows);
}

function requestCreate(app: Hono) {
  return app.request('/partner-service-principals', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Automation', scopes: ['devices:read'], sourceCidrs: [] }),
  });
}

function requestPatch(app: Hono) {
  return app.request(`/partner-service-principals/${PRINCIPAL_ID}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'disabled' }),
  });
}

function requestIssue(app: Hono) {
  return app.request(`/partner-service-principals/${PRINCIPAL_ID}/keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Production' }),
  });
}

function requestRotate(app: Hono) {
  return app.request(`/partner-service-principals/${PRINCIPAL_ID}/keys/${KEY_ID}/rotate`, {
    method: 'POST',
  });
}

function requestRevoke(app: Hono) {
  return app.request(`/partner-service-principals/${PRINCIPAL_ID}/keys/${KEY_ID}`, {
    method: 'DELETE',
  });
}

describe('partner service principal partner-wide capability gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectRowsRef.current = [];
    setPartnerOrgAccess('all');

    dbSelectMock.mockImplementation(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => selectRowsRef.current.shift() ?? []),
          orderBy: vi.fn(async () => selectRowsRef.current.shift() ?? []),
        })),
      })),
    }));
    dbUpdateMock.mockImplementation(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(async () => [{ id: PRINCIPAL_ID, name: 'Automation', status: 'disabled' }]),
        })),
      })),
    }));
    dbTransactionMock.mockImplementation(async (callback: any) => callback({ update: dbUpdateMock }));
    issueKeyMock.mockResolvedValue({ keyId: KEY_ID, rawKey: 'brz_sp_secret', keyPrefix: 'brz_sp_sec' });
    rotateKeyMock.mockResolvedValue({
      keyId: SUCCESSOR_KEY_ID,
      rawKey: 'brz_sp_successor',
      keyPrefix: 'brz_sp_suc',
    });
  });

  const deniedMutations = [
    ['POST /', requestCreate],
    ['PATCH /:id', requestPatch],
    ['POST /:id/keys', requestIssue],
    ['POST /:id/keys/:keyId/rotate', requestRotate],
    ['DELETE /:id/keys/:keyId', requestRevoke],
  ] as const;

  it.each(deniedMutations)('%s returns the partner-wide 403 for selected access', async (_name, request) => {
    setPartnerOrgAccess('selected');

    const res = await request(makeApp());

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE });
  });

  it.each(['none', undefined] as const)('POST / returns 403 when partnerOrgAccess is %s', async (access) => {
    setPartnerOrgAccess(access);

    const res = await requestCreate(makeApp());

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE });
    expect(dbInsertMock).not.toHaveBeenCalled();
  });

  it('POST / succeeds with all access and inserts the principal', async () => {
    queueSelectRows([]);
    dbInsertMock.mockReturnValue({
      values: vi.fn(() => ({
        onConflictDoNothing: vi.fn(() => ({
          returning: vi.fn(async () => [{ id: PRINCIPAL_ID, name: 'Automation', scopes: ['devices:read'] }]),
        })),
      })),
    });

    const res = await requestCreate(makeApp());

    expect(res.status).toBe(201);
    expect((await res.json()).data.id).toBe(PRINCIPAL_ID);
    expect(dbInsertMock).toHaveBeenCalledOnce();
  });

  it('PATCH /:id succeeds with all access and updates the principal', async () => {
    // Primes the existing-principal lookup PATCH runs before evaluating
    // enrollment-keys:write restrictions.
    queueSelectRows([{ scopes: ['devices:read'], sourceCidrs: [], expiresAt: null }]);
    const res = await requestPatch(makeApp());

    expect(res.status).toBe(200);
    expect((await res.json()).data.status).toBe('disabled');
    expect(dbUpdateMock).toHaveBeenCalledOnce();
  });

  it('POST /:id/keys succeeds with all access and issues a key', async () => {
    const res = await requestIssue(makeApp());

    expect(res.status).toBe(201);
    expect((await res.json()).keyId).toBe(KEY_ID);
    expect(issueKeyMock).toHaveBeenCalledOnce();
  });

  it('POST /:id/keys/:keyId/rotate succeeds with all access and rotates the key', async () => {
    const res = await requestRotate(makeApp());

    expect(res.status).toBe(200);
    expect((await res.json()).keyId).toBe(SUCCESSOR_KEY_ID);
    expect(rotateKeyMock).toHaveBeenCalledOnce();
  });

  it('DELETE /:id/keys/:keyId succeeds with all access and revokes the key', async () => {
    queueSelectRows([{ id: KEY_ID, name: 'Production', status: 'active', keyPrefix: 'brz_sp_sec' }]);

    const res = await requestRevoke(makeApp());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, alreadyRevoked: false });
    expect(dbUpdateMock).toHaveBeenCalledOnce();
  });

  it('GET / remains readable with selected access', async () => {
    setPartnerOrgAccess('selected');
    queueSelectRows([], []);

    const res = await makeApp().request('/partner-service-principals');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [] });
    expect(dbSelectMock).toHaveBeenCalledTimes(2);
  });
});
