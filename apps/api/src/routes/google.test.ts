import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// --- mutable mock state, set per-test ---
let selectRows: unknown[] = [];
let insertRows: unknown[] = [];
let deleteRows: unknown[] = [];
let parseThrows = false;
let dirGetThrows = false;

vi.mock('../config/env', () => ({ GOOGLE_WORKSPACE_ENABLED: true }));
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
vi.mock('../db/schema/google', () => ({ googleWorkspaceConnections: { orgId: 'org_id' } }));
vi.mock('../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../services/secretCrypto', () => ({ encryptSecret: vi.fn(() => 'ENCRYPTED-KEY') }));
vi.mock('./c2c/helpers', () => ({ resolveScopedOrgId: vi.fn(() => 'org-1') }));
vi.mock('../services/googleClient', () => ({
  parseServiceAccountKey: vi.fn(() => {
    if (parseThrows) throw new Error('not valid JSON');
    return { client_email: 'sa@proj.iam.gserviceaccount.com', private_key: 'k' };
  }),
  getDirectoryClient: vi.fn(() => ({
    users: { get: vi.fn(async () => { if (dirGetThrows) throw new Error('domain-wide delegation not authorized'); return { data: {} }; }) },
  })),
  normalizeGoogleError: vi.fn((e: any) => ({ code: 'google_error', message: e?.message ?? String(e) })),
}));
vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(async () => selectRows) })) })) })),
    insert: vi.fn(() => ({ values: vi.fn(() => ({ onConflictDoUpdate: vi.fn(() => ({ returning: vi.fn(async () => insertRows) })) })) })),
    delete: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn(async () => deleteRows) })) })),
  },
}));

import { googleRoutes } from './google';
import { authMiddleware } from '../middleware/auth';
import { encryptSecret } from '../services/secretCrypto';

function app() {
  const a = new Hono();
  a.use('*', authMiddleware as any);
  a.route('/google', googleRoutes);
  return a;
}

const storedRow = {
  id: 'conn-1', orgId: 'org-1', customerDomain: 'example.com', adminEmail: 'admin@example.com',
  serviceAccountEmail: 'sa@proj.iam.gserviceaccount.com', serviceAccountKey: 'ENCRYPTED-KEY',
  status: 'active', createdBy: 'user-1', lastVerifiedAt: new Date('2026-06-01T00:00:00Z'),
  createdAt: new Date('2026-06-01T00:00:00Z'), updatedAt: new Date('2026-06-01T00:00:00Z'),
};
const validBody = { customerDomain: 'example.com', adminEmail: 'admin@example.com', serviceAccountKey: '{"type":"service_account"}' };

beforeEach(() => {
  vi.clearAllMocks();
  selectRows = []; insertRows = []; deleteRows = [];
  parseThrows = false; dirGetThrows = false;
});

describe('google connection routes', () => {
  it('GET /connection with no row → connected:false', async () => {
    const res = await app().request('/google/connection');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connected: false });
  });

  it('GET /connection with a row → connected:true and NEVER returns the service-account key', async () => {
    selectRows = [storedRow];
    const res = await app().request('/google/connection');
    const body = await res.json();
    expect(body.connected).toBe(true);
    expect(body.customerDomain).toBe('example.com');
    expect(body.serviceAccountEmail).toBe('sa@proj.iam.gserviceaccount.com');
    expect(body).not.toHaveProperty('serviceAccountKey');
    expect(JSON.stringify(body)).not.toContain('ENCRYPTED-KEY');
  });

  it('POST /connection verifies via a live Directory call, encrypts the key, returns 201 without the key', async () => {
    insertRows = [storedRow];
    const res = await app().request('/google/connection', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(201);
    expect(encryptSecret).toHaveBeenCalledWith('{"type":"service_account"}');
    const body = await res.json();
    expect(body.connected).toBe(true);
    expect(JSON.stringify(body)).not.toContain('service_account');
    expect(JSON.stringify(body)).not.toContain('ENCRYPTED-KEY');
  });

  it('POST /connection returns 400 with a hint when the live Directory verify fails (bad DWD)', async () => {
    dirGetThrows = true;
    const res = await app().request('/google/connection', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.hint).toBeTruthy();
    expect(encryptSecret).not.toHaveBeenCalled();
  });

  it('POST /connection returns 400 when the service-account key is malformed', async () => {
    parseThrows = true;
    const res = await app().request('/google/connection', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(400);
    expect(encryptSecret).not.toHaveBeenCalled();
  });

  it('POST /connection rejects a missing service-account key (zod) with 400', async () => {
    const res = await app().request('/google/connection', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ customerDomain: 'example.com', adminEmail: 'admin@example.com' }),
    });
    expect(res.status).toBe(400);
  });

  it('DELETE /connection → connected:false', async () => {
    deleteRows = [storedRow];
    const res = await app().request('/google/connection', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connected: false });
  });
});
