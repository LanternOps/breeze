import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { psaRoutes } from './psa';

vi.mock('../services', () => ({}));

const { permissionGate, mfaGate, selectMock, insertMock, updateMock, deleteMock } = vi.hoisted(() => {
  function chainMock(resolvedValue: unknown = []) {
    const chain: Record<string, any> = {};
    for (const method of ['from', 'where', 'limit', 'returning', 'values', 'set']) {
      chain[method] = vi.fn(() => Object.assign(Promise.resolve(resolvedValue), chain));
    }
    return Object.assign(Promise.resolve(resolvedValue), chain);
  }
  return {
    permissionGate: { deny: false },
    mfaGate: { deny: false },
    selectMock: vi.fn(() => chainMock([])),
    insertMock: vi.fn(() => chainMock([])),
    updateMock: vi.fn(() => chainMock([])),
    deleteMock: vi.fn(() => chainMock([])),
  };
});

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: (...args: unknown[]) => selectMock(...(args as [])),
    insert: (...args: unknown[]) => insertMock(...(args as [])),
    update: (...args: unknown[]) => updateMock(...(args as [])),
    delete: (...args: unknown[]) => deleteMock(...(args as [])),
  }
}));

vi.mock('../db/schema', () => ({
  psaConnections: {
    id: 'psa_connections.id',
    orgId: 'psa_connections.org_id',
    provider: 'psa_connections.provider',
    name: 'psa_connections.name',
    credentials: 'psa_connections.credentials',
    settings: 'psa_connections.settings',
    syncSettings: 'psa_connections.sync_settings',
    createdAt: 'psa_connections.created_at',
    updatedAt: 'psa_connections.updated_at',
    lastSyncAt: 'psa_connections.last_sync_at',
    lastSyncStatus: 'psa_connections.last_sync_status',
    createdBy: 'psa_connections.created_by',
  },
  psaTicketMappings: {
    id: 'psa_ticket_mappings.id',
    connectionId: 'psa_ticket_mappings.connection_id',
    externalTicketId: 'psa_ticket_mappings.external_ticket_id',
    externalTicketUrl: 'psa_ticket_mappings.external_ticket_url',
    status: 'psa_ticket_mappings.status',
    alertId: 'psa_ticket_mappings.alert_id',
    deviceId: 'psa_ticket_mappings.device_id',
    lastSyncAt: 'psa_ticket_mappings.last_sync_at',
    updatedAt: 'psa_ticket_mappings.updated_at',
    createdAt: 'psa_ticket_mappings.created_at',
  },
  organizations: {
    id: 'id',
    partnerId: 'partnerId'
  }
}));

vi.mock('../services/secretCrypto', () => ({
  encryptSecret: vi.fn((value: string) => `enc:${value}`),
  decryptSecret: vi.fn((value: string) => value.replace(/^enc:/, '')),
}));

vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: vi.fn(),
}));

vi.mock('../services/permissions', () => ({
  PERMISSIONS: {
    ORGS_READ: { resource: 'organizations', action: 'read' },
    ORGS_WRITE: { resource: 'organizations', action: 'write' },
  },
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      scope: 'organization',
      partnerId: null,
      orgId: 'org-123',
      user: { id: 'user-123', email: 'test@example.com' },
      canAccessOrg: (orgId: string) => orgId === 'org-123',
      accessibleOrgIds: ['org-123']
    });
    return next();
  }),
  requireScope: vi.fn((...scopes: string[]) => async (c: any, next: any) => {
    const auth = c.get('auth');
    if (!auth || !scopes.includes(auth.scope)) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    return next();
  }),
  requirePermission: vi.fn(() => async (c: any, next: any) => {
    if (permissionGate.deny) return c.json({ error: 'Permission denied' }, 403);
    return next();
  }),
  requireMfa: vi.fn(() => async (c: any, next: any) => {
    if (mfaGate.deny) return c.json({ error: 'MFA required' }, 403);
    return next();
  })
}));

import { db } from '../db';
import { authMiddleware } from '../middleware/auth';

describe('psa route security gates', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    permissionGate.deny = false;
    mfaGate.deny = false;
    app = new Hono();
    app.route('/psa', psaRoutes);
  });

  it('requires MFA before creating PSA credentials', async () => {
    mfaGate.deny = true;

    const res = await app.request('/psa/connections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'jira',
        name: 'Primary PSA',
        credentials: { apiKey: 'secret' },
        settings: {},
      }),
    });

    expect(res.status).toBe(403);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('allows PSA credential creation after permission and MFA gates pass', async () => {
    const now = new Date('2026-05-02T00:00:00.000Z');
    insertMock.mockReturnValueOnce({
      values: vi.fn(() => ({
        returning: vi.fn(async () => [{
          id: 'conn-1',
          orgId: 'org-123',
          provider: 'jira',
          name: 'Primary PSA',
          credentials: 'enc:{"apiKey":"secret"}',
          settings: {},
          syncSettings: {},
          createdAt: now,
          updatedAt: now,
          lastSyncAt: null,
        }])
      }))
    } as any);

    const res = await app.request('/psa/connections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'jira',
        name: 'Primary PSA',
        credentials: { apiKey: 'secret' },
        settings: {},
      }),
    });

    expect(res.status).toBe(201);
    expect(insertMock).toHaveBeenCalled();
  });

  it('requires MFA before testing or deleting existing PSA credentials', async () => {
    mfaGate.deny = true;

    const testRes = await app.request('/psa/connections/conn-1/test', { method: 'POST' });
    const deleteRes = await app.request('/psa/connections/conn-1', { method: 'DELETE' });

    expect(testRes.status).toBe(403);
    expect(deleteRes.status).toBe(403);
    expect(selectMock).not.toHaveBeenCalled();
    expect(deleteMock).not.toHaveBeenCalled();
  });
});

describe.skip('psa routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
      c.set('auth', {
        scope: 'organization',
        partnerId: null,
        orgId: 'org-123',
        user: { id: 'user-123', email: 'test@example.com' }
      });
      return next();
    });
    app = new Hono();
    app.route('/psa', psaRoutes);
  });

  const createConnection = async (overrides: Record<string, unknown> = {}) => {
    return app.request('/psa', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orgId: 'org-override',
        provider: 'jira',
        name: 'Primary PSA',
        credentials: { apiKey: 'secret' },
        settings: { region: 'us-east-1' },
        ...overrides
      })
    });
  };

  it('should create a PSA connection for org scope', async () => {
    const res = await createConnection();

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBeDefined();
    expect(body.orgId).toBe('org-123');
    expect(body.credentials).toBeDefined();
  });

  it('should list PSA connections without credentials', async () => {
    const createRes = await createConnection({ name: 'List PSA' });
    const created = await createRes.json();

    const res = await app.request('/psa', { method: 'GET' });

    expect(res.status).toBe(200);
    const body = await res.json();
    const match = body.data.find((item: { id: string }) => item.id === created.id);
    expect(match).toBeDefined();
    expect(match.credentials).toBeUndefined();
  });

  it('should fetch a PSA connection with credentials', async () => {
    const createRes = await createConnection({ name: 'Fetch PSA' });
    const created = await createRes.json();

    const res = await app.request(`/psa/${created.id}`, { method: 'GET' });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(created.id);
    expect(body.credentials).toBeDefined();
  });

  it('should update a PSA connection', async () => {
    const createRes = await createConnection({ name: 'Update PSA' });
    const created = await createRes.json();

    const res = await app.request(`/psa/${created.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Updated PSA' })
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe('Updated PSA');
  });

  it('should reject empty updates', async () => {
    const createRes = await createConnection({ name: 'Empty Update PSA' });
    const created = await createRes.json();

    const res = await app.request(`/psa/${created.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });

    expect(res.status).toBe(400);
  });

  it('should delete a PSA connection', async () => {
    const createRes = await createConnection({ name: 'Delete PSA' });
    const created = await createRes.json();

    const res = await app.request(`/psa/${created.id}`, { method: 'DELETE' });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);

    const followUp = await app.request(`/psa/${created.id}`, { method: 'GET' });
    expect(followUp.status).toBe(404);
  });

  it('should test PSA credentials', async () => {
    const createRes = await createConnection({ name: 'Test PSA' });
    const created = await createRes.json();

    const res = await app.request(`/psa/${created.id}/test`, { method: 'POST' });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.success).toBe(true);
    expect(body.testedAt).toBeDefined();
  });

  it('should enqueue a PSA sync', async () => {
    const createRes = await createConnection({ name: 'Sync PSA' });
    const created = await createRes.json();

    const res = await app.request(`/psa/${created.id}/sync`, { method: 'POST' });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('queued');
    expect(body.syncedAt).toBeDefined();
  });

  it('should list PSA tickets for a connection', async () => {
    const createRes = await createConnection({ name: 'Tickets PSA' });
    const created = await createRes.json();

    const res = await app.request(`/psa/${created.id}/tickets?page=1&limit=10`, {
      method: 'GET'
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.pagination).toBeDefined();
  });

  it('should deny partner access when organization is not linked', async () => {
    vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
      c.set('auth', {
        scope: 'system',
        partnerId: null,
        orgId: null,
        user: { id: 'user-123', email: 'test@example.com' }
      });
      return next();
    });

    const createRes = await createConnection({
      orgId: 'org-denied',
      name: 'Denied PSA'
    });
    const created = await createRes.json();

    vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
      c.set('auth', {
        scope: 'partner',
        partnerId: 'partner-123',
        orgId: null,
        user: { id: 'user-123', email: 'test@example.com' }
      });
      return next();
    });
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([])
        })
      })
    } as any);

    const res = await app.request(`/psa/${created.id}`, { method: 'GET' });

    expect(res.status).toBe(403);
  });
});
