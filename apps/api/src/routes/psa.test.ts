import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { psaRoutes } from './psa';
import { PsaConfigError } from '../services/psa/credentials';

vi.mock('../services', () => ({}));

// Service boundary: the routes construct adapters via createPSAProvider; the
// adapters themselves are covered by their own unit tests.
const { createPSAProviderMock } = vi.hoisted(() => ({
  createPSAProviderMock: vi.fn(),
}));

vi.mock('../services/psa', () => ({
  createPSAProvider: createPSAProviderMock,
}));

const { permissionGate, mfaGate, selectMock, insertMock, updateMock, deleteMock } = vi.hoisted(() => {
  function chainMock(resolvedValue: unknown = []) {
    const chain: Record<string, any> = {};
    for (const method of ['from', 'where', 'limit', 'returning', 'values', 'set', 'innerJoin', 'leftJoin', 'orderBy', 'offset']) {
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
  devices: {
    id: 'devices.id',
    siteId: 'devices.site_id',
  },
  organizations: {
    id: 'id',
    partnerId: 'partnerId'
  }
}));

vi.mock('../services/secretCrypto', () => ({
  encryptSecret: vi.fn((value: string) => `enc:${value}`),
  decryptSecret: vi.fn((value: string) => value.replace(/^enc:/, '')),
  decryptForColumn: vi.fn((_t: string, _c: string, value: string) => value.replace(/^enc:/, '')),
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
  dbAccessContextFromAuth: vi.fn(() => ({})),
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
    const restrict = c.req.header('x-restrict-site');
    c.set('permissions', restrict ? {
      permissions: [{ resource: 'organizations', action: 'read' }],
      partnerId: null,
      orgId: 'org-123',
      roleId: 'role-1',
      scope: 'organization',
      allowedSiteIds: restrict === '__empty__' ? [] : [restrict],
    } : undefined);
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

  it('rejects unsafe PSA credential base URLs before storing credentials', async () => {
    const res = await app.request('/psa/connections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'jira',
        name: 'Metadata PSA',
        credentials: {
          baseUrl: 'https://169.254.169.254/latest/meta-data',
          apiKey: 'secret',
        },
        settings: {},
      }),
    });

    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toContain('credentials.baseUrl rejected');
    expect(insertMock).not.toHaveBeenCalled();
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

describe('psa routes', () => {
  let app: Hono;

  const NOW = new Date('2026-05-02T00:00:00.000Z');

  const connectionRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'conn-1',
    orgId: 'org-123',
    provider: 'jira',
    name: 'Primary PSA',
    credentials: `enc:${JSON.stringify({
      baseUrl: 'https://acme.atlassian.net',
      username: 'admin@acme.com',
      apiToken: 'tok-123',
      password: 'pw-456'
    })}`,
    settings: { defaultQueue: 'OPS' },
    syncSettings: {},
    createdAt: NOW,
    updatedAt: NOW,
    lastSyncAt: null,
    ...overrides
  });

  const makeChain = (rows: unknown[]) => {
    const chain: Record<string, any> = {};
    for (const method of ['from', 'where', 'limit', 'returning', 'values', 'set', 'innerJoin', 'leftJoin', 'orderBy', 'offset']) {
      chain[method] = vi.fn(() => Object.assign(Promise.resolve(rows), chain));
    }
    return Object.assign(Promise.resolve(rows), chain);
  };

  beforeEach(() => {
    vi.clearAllMocks();
    permissionGate.deny = false;
    mfaGate.deny = false;
    vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
      c.set('auth', {
        scope: 'organization',
        partnerId: null,
        orgId: 'org-123',
        user: { id: 'user-123', email: 'test@example.com' },
        canAccessOrg: (orgId: string) => orgId === 'org-123',
        accessibleOrgIds: ['org-123']
      });
      return next();
    });
    app = new Hono();
    app.route('/psa', psaRoutes);
  });

  it('creates a PSA connection and never echoes credentials', async () => {
    insertMock.mockReturnValueOnce({
      values: vi.fn(() => ({
        returning: vi.fn(async () => [connectionRow()])
      }))
    } as any);

    const res = await app.request('/psa/connections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'jira',
        name: 'Primary PSA',
        credentials: { baseUrl: 'https://acme.atlassian.net', username: 'admin@acme.com', apiToken: 'tok-123' },
        settings: { defaultQueue: 'OPS' }
      })
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBe('conn-1');
    expect(body.orgId).toBe('org-123');
    expect(body.status).toBe('active');
    expect(body.credentials).toBeUndefined();
    expect(body.hasCredentials).toBeUndefined();
  });

  it('rejects providers outside the shared implemented list', async () => {
    const res = await app.request('/psa/connections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'halo', // DB enum value with no adapter — the route zod is the gate
        name: 'Dead provider',
        credentials: { baseUrl: 'https://halo.example.com' }
      })
    });

    expect(res.status).toBe(400);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('lists PSA connections without credential material', async () => {
    selectMock
      .mockReturnValueOnce(makeChain([connectionRow()]) as never)
      .mockReturnValueOnce(makeChain([{ count: 1 }]) as never);

    const res = await app.request('/psa/connections', { method: 'GET' });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe('conn-1');
    expect(body.data[0].status).toBe('active');
    expect(body.data[0].credentials).toBeUndefined();
    expect(body.data[0].hasCredentials).toBeUndefined();
    expect(body.pagination.total).toBe(1);
  });

  it('returns non-secret prefill fields and per-field secret flags on detail GET', async () => {
    selectMock.mockReturnValueOnce(makeChain([connectionRow()]) as never);

    const res = await app.request('/psa/connections/conn-1', { method: 'GET' });

    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.credentials).toEqual({
      baseUrl: 'https://acme.atlassian.net',
      username: 'admin@acme.com'
    });
    expect(data.credentials.apiToken).toBeUndefined();
    expect(data.credentials.password).toBeUndefined();
    expect(data.hasCredentials).toEqual({
      password: true,
      apiToken: true,
      clientSecret: false
    });
    expect(data.settings).toEqual({ defaultQueue: 'OPS' });
  });

  it('derives paused status from settings.status', async () => {
    selectMock.mockReturnValueOnce(
      makeChain([connectionRow({ settings: { status: 'paused' } })]) as never
    );

    const res = await app.request('/psa/connections/conn-1', { method: 'GET' });

    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.status).toBe('paused');
  });

  it('updates name without touching credentials', async () => {
    selectMock.mockReturnValueOnce(makeChain([connectionRow()]) as never);
    const setSpy = vi.fn((_values: Record<string, unknown>) => ({
      where: vi.fn(() => ({
        returning: vi.fn(async () => [connectionRow({ name: 'Renamed PSA' })])
      }))
    }));
    updateMock.mockReturnValueOnce({ set: setSpy } as any);

    const res = await app.request('/psa/connections/conn-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed PSA' })
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe('Renamed PSA');
    expect(setSpy).toHaveBeenCalledWith(expect.not.objectContaining({ credentials: expect.anything() }));
  });

  it('merges PATCHed credentials over the stored blob (untouched secrets survive)', async () => {
    selectMock.mockReturnValueOnce(makeChain([connectionRow()]) as never);
    const setSpy = vi.fn((_values: Record<string, unknown>) => ({
      where: vi.fn(() => ({
        returning: vi.fn(async () => [connectionRow()])
      }))
    }));
    updateMock.mockReturnValueOnce({ set: setSpy } as any);

    const res = await app.request('/psa/connections/conn-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        credentials: { apiToken: 'tok-NEW', password: null }
      })
    });

    expect(res.status).toBe(200);
    const setArg = setSpy.mock.calls[0]![0] as { credentials: string };
    const persisted = JSON.parse(setArg.credentials.replace(/^enc:/, ''));
    // apiToken overwritten, password deleted via explicit null, the rest kept.
    expect(persisted).toEqual({
      baseUrl: 'https://acme.atlassian.net',
      username: 'admin@acme.com',
      apiToken: 'tok-NEW'
    });
  });

  it('rejects empty updates', async () => {
    const res = await app.request('/psa/connections/conn-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });

    expect(res.status).toBe(400);
  });

  it('deletes a PSA connection and its ticket mappings', async () => {
    selectMock.mockReturnValueOnce(makeChain([connectionRow()]) as never);

    const res = await app.request('/psa/connections/conn-1', { method: 'DELETE' });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(deleteMock).toHaveBeenCalledTimes(2);
  });

  it('runs a real connection test and persists verified on success', async () => {
    selectMock.mockReturnValueOnce(makeChain([connectionRow()]) as never);
    const setSpy = vi.fn((_values: Record<string, unknown>) => ({ where: vi.fn(async () => []) }));
    updateMock.mockReturnValueOnce({ set: setSpy } as any);
    const testConnection = vi.fn(async () => ({ success: true, message: 'Connected as Admin' }));
    createPSAProviderMock.mockReturnValueOnce({ testConnection });

    const res = await app.request('/psa/connections/conn-1/test', { method: 'POST' });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ success: true, message: 'Connected as Admin' });

    expect(createPSAProviderMock).toHaveBeenCalledWith(
      'jira',
      expect.objectContaining({ baseUrl: 'https://acme.atlassian.net', apiToken: 'tok-123' }),
      { defaultQueue: 'OPS' }
    );
    expect(testConnection).toHaveBeenCalledTimes(1);
    const setArg = setSpy.mock.calls[0]![0] as { syncSettings: Record<string, unknown> };
    expect(setArg.syncSettings.status).toBe('verified');
    expect(typeof setArg.syncSettings.lastTestedAt).toBe('string');
  });

  it('returns success:false and persists failed when the provider rejects the credentials', async () => {
    selectMock.mockReturnValueOnce(makeChain([connectionRow()]) as never);
    const setSpy = vi.fn((_values: Record<string, unknown>) => ({ where: vi.fn(async () => []) }));
    updateMock.mockReturnValueOnce({ set: setSpy } as any);
    createPSAProviderMock.mockReturnValueOnce({
      testConnection: vi.fn(async () => ({ success: false, message: 'Jira API error (401): bad token' }))
    });

    const res = await app.request('/psa/connections/conn-1/test', { method: 'POST' });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe('Jira API error (401): bad token');

    const setArg = setSpy.mock.calls[0]![0] as { syncSettings: Record<string, unknown> };
    expect(setArg.syncSettings.status).toBe('failed');
  });

  it('maps PsaConfigError to a 400 instead of a deep TypeError', async () => {
    selectMock.mockReturnValueOnce(makeChain([connectionRow()]) as never);
    createPSAProviderMock.mockImplementationOnce(() => {
      throw new PsaConfigError('jira connection is missing required credential field(s): baseUrl');
    });

    const res = await app.request('/psa/connections/conn-1/test', { method: 'POST' });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('missing required credential field');
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('returns 404 when testing a nonexistent connection', async () => {
    selectMock.mockReturnValueOnce(makeChain([]) as never);

    const res = await app.request('/psa/connections/missing/test', { method: 'POST' });

    expect(res.status).toBe(404);
    expect(createPSAProviderMock).not.toHaveBeenCalled();
  });

  it('answers sync with an honest 501 and performs no DB work', async () => {
    const res = await app.request('/psa/connections/conn-1/sync', { method: 'POST' });

    expect(res.status).toBe(501);
    const body = await res.json();
    expect(body.error).toBe('PSA ticket sync is not implemented yet');
    expect(selectMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('lists PSA tickets for a connection', async () => {
    selectMock.mockReturnValueOnce(makeChain([connectionRow()]) as never);

    const res = await app.request('/psa/connections/conn-1/tickets?page=1&limit=10', {
      method: 'GET'
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.pagination).toBeDefined();
  });

  it('narrows PSA ticket lists through mapped device sites for site-restricted callers', async () => {
    const rowsChain = makeChain([]);
    const countChain = makeChain([{ count: 0 }]);
    selectMock
      .mockReturnValueOnce(rowsChain as never)
      .mockReturnValueOnce(countChain as never);

    const res = await app.request('/psa/tickets?page=1&limit=10', {
      method: 'GET',
      headers: { 'x-restrict-site': 'site-allowed' },
    });

    expect(res.status).toBe(200);
    expect(rowsChain.leftJoin).toHaveBeenCalled();
    expect(countChain.leftJoin).toHaveBeenCalled();
  });

  it('denies partner access when the organization is not linked', async () => {
    vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
      c.set('auth', {
        scope: 'partner',
        partnerId: 'partner-123',
        orgId: null,
        user: { id: 'user-123', email: 'test@example.com' },
        canAccessOrg: () => false,
        accessibleOrgIds: []
      });
      return next();
    });
    selectMock.mockReturnValueOnce(makeChain([connectionRow({ orgId: 'org-denied' })]) as never);

    const res = await app.request('/psa/connections/conn-1', { method: 'GET' });

    expect(res.status).toBe(403);
  });
});

