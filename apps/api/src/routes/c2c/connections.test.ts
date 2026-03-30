import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { connectionsRoutes } from './connections';

const ORG_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CONNECTION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

vi.mock('../../services', () => ({}));

const writeRouteAuditMock = vi.fn();

function chainMock(resolvedValue: unknown = []) {
  const chain: Record<string, any> = {};
  for (const method of ['from', 'where', 'limit', 'returning', 'values', 'set']) {
    chain[method] = vi.fn(() => Object.assign(Promise.resolve(resolvedValue), chain));
  }
  return Object.assign(Promise.resolve(resolvedValue), chain);
}

const selectMock = vi.fn(() => chainMock([]));
const insertMock = vi.fn(() => chainMock([]));
const updateMock = vi.fn(() => chainMock([]));
let authState = {
  user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
  scope: 'organization' as const,
  partnerId: null,
  orgId: ORG_ID,
  token: { sub: 'user-123' },
};

vi.mock('../../db', () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...(args as [])),
    insert: (...args: unknown[]) => insertMock(...(args as [])),
    update: (...args: unknown[]) => updateMock(...(args as [])),
  },
  runOutsideDbContext: vi.fn((fn: () => any) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => any) => fn()),
}));

vi.mock('../../db/schema', () => ({
  c2cConnections: {
    id: 'c2c_connections.id',
    orgId: 'c2c_connections.org_id',
    provider: 'c2c_connections.provider',
    displayName: 'c2c_connections.display_name',
    tenantId: 'c2c_connections.tenant_id',
    clientId: 'c2c_connections.client_id',
    clientSecret: 'c2c_connections.client_secret',
    scopes: 'c2c_connections.scopes',
    status: 'c2c_connections.status',
    lastSyncAt: 'c2c_connections.last_sync_at',
    createdAt: 'c2c_connections.created_at',
    updatedAt: 'c2c_connections.updated_at',
  },
}));

vi.mock('../../services/auditEvents', () => ({
  writeRouteAudit: (...args: unknown[]) => writeRouteAuditMock(...(args as [])),
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', authState);
    return next();
  }),
  requireScope: vi.fn(() => (c: any, next: any) => next()),
}));

import { authMiddleware } from '../../middleware/auth';

function makeConnection(overrides: Record<string, unknown> = {}) {
  return {
    id: CONNECTION_ID,
    orgId: ORG_ID,
    provider: 'microsoft_365',
    displayName: 'M365 Tenant',
    tenantId: 'tenant-1',
    clientId: 'client-id-1234567890',
    clientSecret: 'super-secret',
    scopes: 'mail calendar',
    status: 'active',
    lastSyncAt: null,
    createdAt: new Date('2026-03-29T00:00:00.000Z'),
    updatedAt: new Date('2026-03-29T00:00:00.000Z'),
    ...overrides,
  };
}

describe('c2c connection routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    authState = {
      user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
      scope: 'organization',
      partnerId: null,
      orgId: ORG_ID,
      token: { sub: 'user-123' },
    };
    vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
      c.set('auth', authState);
      return next();
    });
    app = new Hono();
    app.use('*', authMiddleware);
    app.route('/c2c', connectionsRoutes);
  });

  it('returns an empty connection list', async () => {
    selectMock.mockReturnValueOnce(chainMock([]));

    const res = await app.request('/c2c/connections', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual([]);
  });

  it('creates a connection', async () => {
    insertMock.mockReturnValueOnce(chainMock([makeConnection()]));

    const res = await app.request('/c2c/connections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({
        provider: 'microsoft_365',
        displayName: 'M365 Tenant',
        tenantId: 'tenant-1',
        clientId: 'client-id-1234567890',
        clientSecret: 'super-secret',
        scopes: 'mail calendar',
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBe(CONNECTION_ID);
    expect(body.clientId).toBe('****7890');
    expect(body.clientSecret).toBeUndefined();
  });

  it('revokes a connection', async () => {
    updateMock.mockReturnValueOnce(chainMock([makeConnection({ status: 'revoked' })]));

    const res = await app.request(`/c2c/connections/${CONNECTION_ID}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
  });

  it('should test an active connection', async () => {
    selectMock.mockReturnValueOnce(chainMock([makeConnection({ status: 'active' })]));

    const res = await app.request(`/c2c/connections/${CONNECTION_ID}/test`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(CONNECTION_ID);
    expect(body.status).toBe('success');
    expect(body.message).toBe('Connection is active and credentials are configured');
    expect(body.checkedAt).toBeDefined();
  });

  it('should report failed status when testing a revoked connection', async () => {
    selectMock.mockReturnValueOnce(chainMock([makeConnection({ status: 'revoked' })]));

    const res = await app.request(`/c2c/connections/${CONNECTION_ID}/test`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(CONNECTION_ID);
    expect(body.status).toBe('failed');
    expect(body.message).toBe('Connection status is revoked');
  });

  it('never returns secrets from GET responses', async () => {
    selectMock.mockReturnValueOnce(chainMock([makeConnection()]));

    const res = await app.request('/c2c/connections', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data[0].clientId).toBe('****7890');
    expect(body.data[0].clientSecret).toBeUndefined();
  });
});
