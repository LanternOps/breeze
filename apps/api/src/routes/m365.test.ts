import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// --- mutable mock state, set per-test ---
let selectRows: unknown[] = [];
let insertRows: unknown[] = [];
let deleteRows: unknown[] = [];
let tokenResult: { accessToken: string; expiresIn: number };
let graphResult: { ok: boolean; orgDisplayName?: string; error?: string };
let tokenThrows = false;

vi.mock('../config/env', () => ({ M365_ENABLED: true }));
vi.mock('../services/permissions', () => ({
  PERMISSIONS: {
    ORGS_READ: { resource: 'organizations', action: 'read' },
    ORGS_WRITE: { resource: 'organizations', action: 'write' },
  },
}));
vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', { scope: 'organization', orgId: 'org-1', user: { id: 'user-1' } });
    return next();
  }),
  requirePermission: vi.fn(() => (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => (_c: any, next: any) => next()),
}));
vi.mock('../db/schema/m365', () => ({ m365Connections: { orgId: 'org_id' } }));
vi.mock('../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../services/secretCrypto', () => ({ encryptSecret: vi.fn(() => 'ENCRYPTED-SECRET') }));
vi.mock('./c2c/helpers', () => ({ resolveScopedOrgId: vi.fn(() => 'org-1') }));
vi.mock('../services/c2cM365', () => ({
  acquireClientCredentialsToken: vi.fn(async () => {
    if (tokenThrows) throw new Error('AADSTS7000215 invalid client secret');
    return tokenResult;
  }),
  testGraphAccess: vi.fn(async () => graphResult),
  isM365TenantId: (x: string) => /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(x),
}));
vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(async () => selectRows) })) })) })),
    insert: vi.fn(() => ({ values: vi.fn(() => ({ onConflictDoUpdate: vi.fn(() => ({ returning: vi.fn(async () => insertRows) })) })) })),
    delete: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn(async () => deleteRows) })) })),
  },
}));

import { m365Routes } from './m365';
import { authMiddleware } from '../middleware/auth';
import { encryptSecret } from '../services/secretCrypto';
import { acquireClientCredentialsToken, testGraphAccess } from '../services/c2cM365';

function app() {
  const a = new Hono();
  a.use('*', authMiddleware as any);
  a.route('/m365', m365Routes);
  return a;
}

const storedRow = {
  id: 'conn-1', orgId: 'org-1', tenantId: '11111111-1111-1111-1111-111111111111', clientId: 'client-1',
  clientSecret: 'ENCRYPTED-SECRET', displayName: 'Contoso', status: 'active',
  lastVerifiedAt: new Date('2026-06-01T00:00:00Z'), createdAt: new Date('2026-06-01T00:00:00Z'),
  updatedAt: new Date('2026-06-01T00:00:00Z'),
};

beforeEach(() => {
  vi.clearAllMocks();
  selectRows = []; insertRows = []; deleteRows = [];
  tokenResult = { accessToken: 'tok', expiresIn: 3600 };
  graphResult = { ok: true, orgDisplayName: 'Contoso' };
  tokenThrows = false;
});

describe('m365 connection routes', () => {
  it('GET /connection with no row → connected:false', async () => {
    const res = await app().request('/m365/connection');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connected: false });
  });

  it('GET /connection with a row → connected:true and NEVER returns the secret', async () => {
    selectRows = [storedRow];
    const res = await app().request('/m365/connection');
    const body = await res.json();
    expect(body.connected).toBe(true);
    expect(body.tenantId).toBe('11111111-1111-1111-1111-111111111111');
    expect(body.displayName).toBe('Contoso');
    expect(body).not.toHaveProperty('clientSecret');
    expect(JSON.stringify(body)).not.toContain('ENCRYPTED-SECRET');
  });

  it('POST /connection verifies via Graph, encrypts the secret, returns 201 without the secret', async () => {
    insertRows = [storedRow];
    const res = await app().request('/m365/connection', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tenantId: '11111111-1111-1111-1111-111111111111', clientId: 'client-1', clientSecret: 'super-secret' }),
    });
    expect(res.status).toBe(201);
    expect(acquireClientCredentialsToken).toHaveBeenCalledOnce();
    expect(testGraphAccess).toHaveBeenCalledWith('tok');
    expect(encryptSecret).toHaveBeenCalledWith('super-secret');
    const body = await res.json();
    expect(body.connected).toBe(true);
    expect(JSON.stringify(body)).not.toContain('super-secret');
    expect(JSON.stringify(body)).not.toContain('ENCRYPTED-SECRET');
  });

  it('POST /connection returns 400 with a hint when Graph verification fails', async () => {
    graphResult = { ok: false, error: 'insufficient privileges' };
    const res = await app().request('/m365/connection', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tenantId: '11111111-1111-1111-1111-111111111111', clientId: 'client-1', clientSecret: 'super-secret' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Could not verify');
    expect(body.hint).toBeTruthy();
    expect(encryptSecret).not.toHaveBeenCalled();
  });

  it('POST /connection returns 400 when token acquisition throws (bad credentials)', async () => {
    tokenThrows = true;
    const res = await app().request('/m365/connection', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tenantId: '11111111-1111-1111-1111-111111111111', clientId: 'client-1', clientSecret: 'bad' }),
    });
    expect(res.status).toBe(400);
    expect(encryptSecret).not.toHaveBeenCalled();
  });

  it('POST /connection rejects a missing client secret (zod) with 400', async () => {
    const res = await app().request('/m365/connection', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tenantId: '11111111-1111-1111-1111-111111111111', clientId: 'client-1' }),
    });
    expect(res.status).toBe(400);
  });

  it('POST /connection rejects a non-GUID tenant id with 400 before any token call', async () => {
    const res = await app().request('/m365/connection', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tenantId: 'contoso.onmicrosoft.com', clientId: 'client-1', clientSecret: 'super-secret' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/tenant guid/i);
    expect(encryptSecret).not.toHaveBeenCalled();
  });

  it('DELETE /connection → connected:false', async () => {
    deleteRows = [storedRow];
    const res = await app().request('/m365/connection', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connected: false });
  });

  // Regression: the route module itself must attach authMiddleware. index.ts
  // does NOT apply a global auth middleware to the /api/v1 group, so a route
  // that forgets `.use('*', authMiddleware)` reaches requirePermission with no
  // auth context and 401s every authenticated request. Mount the router WITHOUT
  // the harness auth and assert the router invoked authMiddleware on its own.
  it('attaches authMiddleware itself (regression: 401 for all callers when missing)', async () => {
    const bare = new Hono();
    bare.route('/m365', m365Routes);
    await bare.request('/m365/connection');
    expect(authMiddleware).toHaveBeenCalled();
  });
});
