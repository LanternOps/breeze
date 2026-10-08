import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const { authState, gates, adapterState, dbState, ctxState } = vi.hoisted(() => ({
  authState: {
    scope: 'partner' as 'organization' | 'partner' | 'system',
    orgId: null as string | null,
    partnerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as string | null,
    partnerOrgAccess: 'all' as 'all' | 'selected' | 'none' | null,
  },
  gates: { permission: false, mfa: false },
  adapterState: {
    test: {
      ok: true, rootId: '1000', rootName: 'OliveTech', rootType: 'partner', tenantCount: 3,
      capabilityNotes: ['quarantine: API not enabled on key'],
    } as Record<string, unknown>,
  },
  dbState: {
    connections: [] as Array<Record<string, unknown>>,
    inserted: [] as Array<Record<string, unknown>>,
    updated: [] as Array<Record<string, unknown>>,
    deleted: 0,
    counts: [0, 0, 0] as number[],
    selectCalls: 0,
  },
  ctxState: {
    inDbContext: 0,
    testCalledInContext: null as boolean | null,
    enqueueInContext: [] as boolean[],
    testCalls: [] as unknown[],
  },
}));

const CONNECTION_ID = '33333333-3333-4333-8333-333333333333';
const PARTNER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CREDS = { apiKey: 'sup3r-s3cret-key' };
const ACCESS_URL = 'https://cloud.gravityzone.bitdefender.com/api';

function projectRow(columns: Record<string, unknown>, row: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(columns)) {
    const col = columns[key] as { name?: string };
    if (key === 'hasCredentials') out[key] = !!row.credentialsEncrypted;
    else if (key === 'hasWebhookSecret') out[key] = !!row.webhookSecretEncrypted;
    else if (key === 'n') out[key] = dbState.counts[dbState.selectCalls++ % 3];
    else out[key] = row[key];
    void col;
  }
  return out;
}

vi.mock('../../db', () => {
  const selectRows = (columns?: Record<string, unknown>) => {
    if (columns && 'n' in columns) return [projectRow(columns, {})];
    return dbState.connections.map((row) => (columns ? projectRow(columns, row) : row));
  };
  const tx = {
    update: vi.fn(() => ({
      set: vi.fn((v: Record<string, unknown>) => {
        dbState.updated.push(v);
        return {
          where: vi.fn(() => Object.assign(Promise.resolve([]), {
            returning: vi.fn(async () => [{ id: CONNECTION_ID }]),
          })),
        };
      }),
    })),
  };
  return {
    db: {
      select: vi.fn((columns?: Record<string, unknown>) => ({
        from: vi.fn(() => ({
          where: vi.fn(() => {
            const rows = selectRows(columns);
            return Object.assign(Promise.resolve(rows), {
              limit: vi.fn(async () => rows),
              orderBy: vi.fn(async () => rows),
            });
          }),
        })),
      })),
      insert: vi.fn(() => ({
        values: vi.fn((v: Record<string, unknown>) => {
          const dupe = dbState.connections.some((r) =>
            r.partnerId === v.partnerId && r.provider === v.provider && r.name === v.name);
          if (dupe) {
            const err = new Error('duplicate key');
            (err as unknown as { cause: unknown }).cause = { code: '23505' };
            return { returning: vi.fn(async () => { throw err; }) };
          }
          dbState.inserted.push(v);
          dbState.connections.push({ ...v });
          return { returning: vi.fn(async () => [{ id: v.id }]) };
        }),
      })),
      update: vi.fn(() => ({
        set: vi.fn((v: Record<string, unknown>) => {
          dbState.updated.push(v);
          return { where: vi.fn(async () => []) };
        }),
      })),
      delete: vi.fn(() => ({ where: vi.fn(async () => { dbState.deleted += 1; return []; }) })),
      transaction: vi.fn(async (cb: (t: unknown) => Promise<unknown>) => cb(tx)),
    },
    runOutsideDbContext: vi.fn(async (fn: () => unknown) => {
      const saved = ctxState.inDbContext;
      ctxState.inDbContext = 0;
      try { return await fn(); } finally { ctxState.inDbContext = saved; }
    }),
  };
});

vi.mock('../../middleware/auth', () => ({
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (c: any, next: any) =>
    gates.permission ? c.json({ error: 'Forbidden' }, 403) : next()),
  requireMfa: vi.fn(() => async (c: any, next: any) =>
    gates.mfa ? c.json({ error: 'MFA required' }, 403) : next()),
  withAuthDbAccessContext: vi.fn(async (_auth: unknown, fn: () => Promise<unknown>) => {
    ctxState.inDbContext += 1;
    try { return await fn(); } finally { ctxState.inDbContext -= 1; }
  }),
}));

vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
vi.mock('../../services/sentry', () => ({ captureException: vi.fn() }));

const testConnection = vi.fn(async (ctx: unknown) => {
  ctxState.testCalledInContext = ctxState.inDbContext > 0;
  ctxState.testCalls.push(ctx);
  return adapterState.test;
});
const adapter = {
  key: 'bitdefender',
  label: 'Bitdefender GravityZone',
  credentialsSchema: {
    safeParse: (v: unknown) =>
      v && typeof (v as any).apiKey === 'string'
        ? { success: true, data: v }
        : { success: false, error: { message: 'bad creds' } },
  },
  baseUrlPolicy: { required: true, pathPrefix: '/api' },
  hostAllowlist: ['.gravityzone.bitdefender.com'],
  capabilities: { tenantModel: 'partner', detectionDelivery: 'poll', installer: 'none', actions: [] },
  testConnection,
};
vi.mock('../../services/edrProviders/registry', () => ({
  getEdrProvider: vi.fn((key: string) => {
    if (key !== 'bitdefender') throw new Error(`Unknown EDR provider "${key}"`);
    return adapter;
  }),
}));

const encryptMock = vi.fn((_spec: string, id: string, _creds: unknown) => `enc:${id}`);
vi.mock('../../services/edrProviders/credentials', () => ({
  encryptEdrSecret: (spec: string, id: string, creds: unknown) => encryptMock(spec, id, creds),
  decryptEdrSecret: vi.fn(() => CREDS),
}));

vi.mock('../../services/edrProviders/context', () => ({
  buildEdrAdapterContext: vi.fn((_a: unknown, o: unknown) => ({ ctx: true, ...(o as object) })),
}));

const enqueueMock = vi.fn(async (_id: string, _stream: string) => {
  ctxState.enqueueInContext.push(ctxState.inDbContext > 0);
  return 'job-1';
});
vi.mock('../../jobs/edrProviderSync', () => ({
  enqueueEdrSync: (id: string, stream: string) => enqueueMock(id, stream),
}));

import { writeRouteAudit } from '../../services/auditEvents';
import { runOutsideDbContext } from '../../db';
import { edrConnectionRoutes } from './connections';

function connectionRow(over: Record<string, unknown> = {}) {
  return {
    id: CONNECTION_ID, partnerId: PARTNER_ID, provider: 'bitdefender', name: 'OliveTech GZ',
    baseUrl: ACCESS_URL, region: null, credentialsEncrypted: 'enc:x', webhookSecretEncrypted: null,
    vendorRootId: '1000', vendorRootName: 'OliveTech', isActive: true, status: 'connected',
    createdAt: new Date(), updatedAt: new Date(),
    ...over,
  };
}

const JSON_HEADERS = { 'content-type': 'application/json' };
const post = (app: Hono, path: string, body: unknown) =>
  app.request(path, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });

describe('EDR connection routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    gates.permission = false;
    gates.mfa = false;
    authState.scope = 'partner';
    authState.orgId = null;
    authState.partnerId = PARTNER_ID;
    authState.partnerOrgAccess = 'all';
    adapterState.test = {
      ok: true, rootId: '1000', rootName: 'OliveTech', rootType: 'partner', tenantCount: 3,
      capabilityNotes: ['quarantine: API not enabled on key'],
    };
    dbState.connections = [];
    dbState.inserted = [];
    dbState.updated = [];
    dbState.deleted = 0;
    dbState.counts = [0, 0, 0];
    dbState.selectCalls = 0;
    ctxState.inDbContext = 0;
    ctxState.testCalledInContext = null;
    ctxState.enqueueInContext = [];
    ctxState.testCalls = [];
    app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth' as never, {
        scope: authState.scope,
        orgId: authState.orgId,
        partnerId: authState.partnerId,
        partnerOrgAccess: authState.partnerOrgAccess,
        user: { id: '99999999-9999-4999-8999-999999999999', email: 'tech@example.com' },
      } as never);
      return next();
    });
    app.route('/edr', edrConnectionRoutes);
  });

  const createBody = { provider: 'bitdefender', name: 'OliveTech GZ', baseUrl: ACCESS_URL, credentials: CREDS };

  describe('GET /edr/connections', () => {
    it('lists connections with booleans and NEVER the ciphertext', async () => {
      dbState.connections = [connectionRow()];
      const res = await app.request('/edr/connections');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data[0]).toMatchObject({ id: CONNECTION_ID, hasCredentials: true, hasWebhookSecret: false });
      const raw = JSON.stringify(body);
      expect(raw).not.toMatch(/credentialsEncrypted|webhookSecretEncrypted|credentials_encrypted|enc:x/);
    });

    it('a selected-org partner user can read', async () => {
      authState.partnerOrgAccess = 'selected';
      expect((await app.request('/edr/connections')).status).toBe(200);
    });
  });

  it('org-scoped token -> 403 on every route, including GET', async () => {
    authState.scope = 'organization';
    authState.orgId = '11111111-1111-4111-8111-111111111111';
    authState.partnerOrgAccess = null;
    const id = CONNECTION_ID;
    const results = await Promise.all([
      app.request('/edr/connections'),
      post(app, '/edr/connections', createBody),
      app.request(`/edr/connections/${id}`, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ name: 'x' }) }),
      post(app, `/edr/connections/${id}/test`, {}),
      post(app, `/edr/connections/${id}/sync`, {}),
      app.request(`/edr/connections/${id}`, { method: 'DELETE' }),
    ]);
    expect(results.map((r) => r.status)).toEqual([403, 403, 403, 403, 403, 403]);
    expect(testConnection).not.toHaveBeenCalled();
  });

  it.each([
    ['POST /connections', (a: Hono) => post(a, '/edr/connections', createBody)],
    ['PATCH /connections/:id', (a: Hono) =>
      a.request(`/edr/connections/${CONNECTION_ID}`, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ name: 'x' }) })],
    ['POST /connections/:id/test', (a: Hono) => post(a, `/edr/connections/${CONNECTION_ID}/test`, {})],
    ['POST /connections/:id/sync', (a: Hono) => post(a, `/edr/connections/${CONNECTION_ID}/sync`, {})],
    ['DELETE /connections/:id', (a: Hono) => a.request(`/edr/connections/${CONNECTION_ID}`, { method: 'DELETE' })],
  ])('selected-org partner user -> 403 on %s (Review Focus 5)', async (_name, call) => {
    authState.partnerOrgAccess = 'selected';
    dbState.connections = [connectionRow()];
    const res = await call(app);
    expect(res.status).toBe(403);
    expect(testConnection).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
    expect(dbState.inserted).toHaveLength(0);
    expect(dbState.updated).toHaveLength(0);
    expect(dbState.deleted).toBe(0);
  });

  describe('POST /edr/connections', () => {
    it('seals credentials under the generated row id and never echoes them in the response or audit', async () => {
      const res = await post(app, '/edr/connections', createBody);
      expect(res.status).toBe(201);
      const created = dbState.inserted[0]!;
      expect(typeof created.id).toBe('string');
      expect(encryptMock).toHaveBeenCalledWith('connection_credentials', created.id, CREDS);
      expect(created.credentialsEncrypted).toBe(`enc:${created.id}`);
      expect(created).toMatchObject({
        partnerId: PARTNER_ID, vendorRootId: '1000', vendorRootType: 'partner', status: 'connected',
        capabilitiesSnapshot: ['tenants:partner', 'detections:poll', 'installer:none', 'note:quarantine: API not enabled on key'],
      });
      const payload = JSON.stringify(await res.json());
      expect(payload).not.toContain(CREDS.apiKey);
      expect(JSON.stringify(vi.mocked(writeRouteAudit).mock.calls)).not.toContain(CREDS.apiKey);
      expect(vi.mocked(writeRouteAudit).mock.calls[0]![1]).toMatchObject({ action: 'edr.connection.create' });
    });

    it('tests OUTSIDE any db context and enqueues outside it too (runOutsideDbContext)', async () => {
      const res = await post(app, '/edr/connections', createBody);
      expect(res.status).toBe(201);
      expect(ctxState.testCalledInContext).toBe(false);
      expect(ctxState.enqueueInContext).toEqual([false]);
      expect(vi.mocked(runOutsideDbContext)).toHaveBeenCalled();
      expect(enqueueMock).toHaveBeenCalledWith(dbState.inserted[0]!.id, 'inventory');
    });

    it('Access URL outside .gravityzone.bitdefender.com -> 400 and the adapter is never called', async () => {
      for (const baseUrl of [
        'https://evil.example/api',
        'https://evil.example/?x=.gravityzone.bitdefender.com',
        'https://cloud.gravityzone.bitdefender.com.evil.example/api',
        'http://cloud.gravityzone.bitdefender.com/api',
      ]) {
        const res = await post(app, '/edr/connections', { ...createBody, baseUrl });
        expect(res.status).toBe(400);
      }
      expect(testConnection).not.toHaveBeenCalled();
      expect(dbState.inserted).toHaveLength(0);
    });

    it('requires an Access URL for GravityZone', async () => {
      const { baseUrl: _omit, ...noUrl } = createBody;
      expect((await post(app, '/edr/connections', noUrl)).status).toBe(400);
      expect(testConnection).not.toHaveBeenCalled();
    });

    it('failing vendor test -> 422 and nothing inserted', async () => {
      adapterState.test = { ok: false, error: 'The API key was rejected', reauth: true };
      const res = await post(app, '/edr/connections', createBody);
      expect(res.status).toBe(422);
      expect(await res.json()).toMatchObject({ success: false, reauth: true });
      expect(dbState.inserted).toHaveLength(0);
      expect(enqueueMock).not.toHaveBeenCalled();
    });

    it('unknown provider and bad credentials -> 400 before any vendor call', async () => {
      expect((await post(app, '/edr/connections', { ...createBody, provider: 'veeam' })).status).toBe(400);
      expect((await post(app, '/edr/connections', { ...createBody, credentials: { nope: 1 } })).status).toBe(400);
      expect(testConnection).not.toHaveBeenCalled();
    });

    it('duplicate name -> 409 DUPLICATE_CONNECTION_NAME', async () => {
      dbState.connections = [connectionRow()];
      const res = await post(app, '/edr/connections', createBody);
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('DUPLICATE_CONNECTION_NAME');
    });

    it('is gated on write permission and MFA', async () => {
      gates.permission = true;
      expect((await post(app, '/edr/connections', createBody)).status).toBe(403);
      gates.permission = false;
      gates.mfa = true;
      expect((await post(app, '/edr/connections', createBody)).status).toBe(403);
      expect(testConnection).not.toHaveBeenCalled();
    });
  });

  describe('PATCH /edr/connections/:id', () => {
    const patch = (body: unknown) =>
      app.request(`/edr/connections/${CONNECTION_ID}`, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(body) });

    it('credentials: re-tested outside db, re-sealed under the SAME row id, status reset to connected, updated_at moves', async () => {
      dbState.connections = [connectionRow({ status: 'reauth_required' })];
      const before = Date.now();
      const res = await patch({ credentials: { apiKey: 'rotated-key' } });
      expect(res.status).toBe(200);
      expect(ctxState.testCalledInContext).toBe(false);
      expect(encryptMock).toHaveBeenCalledWith('connection_credentials', CONNECTION_ID, { apiKey: 'rotated-key' });
      const set = dbState.updated[0]!;
      expect(set.credentialsEncrypted).toBe(`enc:${CONNECTION_ID}`);
      expect(set.status).toBe('connected');
      expect(set.lastInventorySyncError).toBeNull();
      expect((set.updatedAt as Date).getTime()).toBeGreaterThanOrEqual(before);
      expect(JSON.stringify(vi.mocked(writeRouteAudit).mock.calls)).not.toContain('rotated-key');
    });

    it('failed rotation -> 422 and the stored credential is untouched', async () => {
      dbState.connections = [connectionRow()];
      adapterState.test = { ok: false, error: 'rejected', reauth: true };
      const res = await patch({ credentials: { apiKey: 'bad' } });
      expect(res.status).toBe(422);
      expect(dbState.updated).toHaveLength(0);
    });

    it('baseUrl outside the allowlist -> 400 without a vendor call', async () => {
      dbState.connections = [connectionRow()];
      const res = await patch({ baseUrl: 'https://evil.example/api' });
      expect(res.status).toBe(400);
      expect(testConnection).not.toHaveBeenCalled();
    });

    it('a plain rename does not call the vendor', async () => {
      dbState.connections = [connectionRow()];
      const res = await patch({ name: 'Renamed' });
      expect(res.status).toBe(200);
      expect(testConnection).not.toHaveBeenCalled();
      expect(dbState.updated[0]).toMatchObject({ name: 'Renamed' });
    });

    it('404 for an unknown connection', async () => {
      expect((await patch({ name: 'x' })).status).toBe(404);
    });
  });

  describe('POST /edr/connections/:id/test', () => {
    it('decrypts in a short context, tests outside it, persists the outcome', async () => {
      dbState.connections = [connectionRow()];
      const res = await post(app, `/edr/connections/${CONNECTION_ID}/test`, {});
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ success: true, tenantCount: 3 });
      expect(ctxState.testCalledInContext).toBe(false);
      expect(dbState.updated[0]).toMatchObject({ status: 'connected', vendorRootId: '1000' });
    });

    it('a reauth failure flips status to reauth_required; a transient one persists nothing', async () => {
      dbState.connections = [connectionRow()];
      adapterState.test = { ok: false, error: 'rejected', reauth: true };
      await post(app, `/edr/connections/${CONNECTION_ID}/test`, {});
      expect(dbState.updated[0]).toMatchObject({ status: 'reauth_required' });

      dbState.updated = [];
      adapterState.test = { ok: false, error: 'timeout', reauth: false };
      const res = await post(app, `/edr/connections/${CONNECTION_ID}/test`, {});
      expect(await res.json()).toMatchObject({ success: false });
      expect(dbState.updated).toHaveLength(0);
    });
  });

  describe('POST /edr/connections/:id/sync', () => {
    it('enqueues both streams outside the db context', async () => {
      dbState.connections = [connectionRow()];
      const res = await post(app, `/edr/connections/${CONNECTION_ID}/sync`, {});
      expect(res.status).toBe(202);
      expect(enqueueMock.mock.calls.map((c) => c[1])).toEqual(['inventory', 'detections']);
      expect(ctxState.enqueueInContext.every((v) => v === false)).toBe(true);
    });

    it('409 for a disabled connection', async () => {
      dbState.connections = [connectionRow({ isActive: false })];
      expect((await post(app, `/edr/connections/${CONNECTION_ID}/sync`, {})).status).toBe(409);
      expect(enqueueMock).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /edr/connections/:id', () => {
    const del = (qs = '') => app.request(`/edr/connections/${CONNECTION_ID}${qs}`, { method: 'DELETE' });

    it('without matching confirm counts -> 409 with the counts and nothing deleted', async () => {
      dbState.connections = [connectionRow()];
      dbState.counts = [4, 120, 3];
      let res = await del();
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'CONFIRM_COUNTS', detections: 4, endpoints: 120, tenants: 3 });
      dbState.selectCalls = 0;
      res = await del('?confirm=1:1');
      expect(res.status).toBe(409);
      expect(dbState.deleted).toBe(0);
    });

    it('with matching confirm counts -> 200, deletes and audits the counts', async () => {
      dbState.connections = [connectionRow()];
      dbState.counts = [4, 120, 3];
      const res = await del('?confirm=4:120');
      expect(res.status).toBe(200);
      expect(dbState.deleted).toBe(1);
      expect(vi.mocked(writeRouteAudit).mock.calls[0]![1]).toMatchObject({
        action: 'edr.connection.delete',
        details: { openDetections: 4, endpoints: 120, tenants: 3 },
      });
    });
  });
});
