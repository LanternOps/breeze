import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const { authState, gates, adapterState, dbState } = vi.hoisted(() => ({
  authState: {
    scope: 'partner' as 'organization' | 'partner' | 'system',
    orgId: null as string | null,
    partnerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as string | null,
    partnerOrgAccess: 'all' as 'all' | 'selected' | 'none' | null,
    accessibleOrgIds: [] as string[],
  },
  gates: { permission: false, mfa: false },
  adapterState: {
    test: { ok: true, rootId: '1000', rootName: 'OliveTech', customerCount: 3 } as Record<string, unknown>,
  },
  dbState: {
    connections: [] as Array<Record<string, unknown>>,
    inserted: [] as Array<Record<string, unknown>>,
    updated: [] as Array<Record<string, unknown>>,
    deleted: 0,
    executed: [] as string[],
    // Defense-in-depth: the hand-rolled mock below ignores the drizzle
    // condition it's given (ANY where clause returns every seeded row), so
    // deleting a tenant-scoping `eq(...partnerId...)` from a route query
    // would keep this whole suite green. RLS is the real backstop; these
    // capture the built condition so a route-level test can assert the
    // partner column is actually referenced.
    capturedSelectWheres: [] as unknown[],
    capturedUpdateWheres: [] as unknown[],
    capturedDeleteWheres: [] as unknown[],
  },
}));

/** True if the drizzle condition's SQL tree references a leaf equal to `marker` (a mocked schema column is a plain string, e.g. 'partner_id'). */
function referencesColumn(node: unknown, marker: string): boolean {
  if (node === marker) return true;
  if (node && typeof node === 'object' && Array.isArray((node as { queryChunks?: unknown[] }).queryChunks)) {
    return (node as { queryChunks: unknown[] }).queryChunks.some((c) => referencesColumn(c, marker));
  }
  return false;
}

// The real `db.select(COLUMNS)` (drizzle) projects to exactly the requested
// columns, computing `hasCredentials` in SQL from `credentialsEncrypted`. This
// mock has no SQL engine, so it reproduces that projection in JS: a plain
// string column marker (e.g. 'partner_id', from the mocked schema) is copied
// straight from the row under its OWN key (which is always the camelCase
// select key, matching the row fixtures below); anything else (the `sql`
// tagged-template `hasCredentials` expression) is drizzle's `SQL` class, not a
// string, and is treated as the "does a ciphertext exist" computed column.
function projectRow(columns: Record<string, unknown> | undefined, row: Record<string, unknown>) {
  if (!columns) return row;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(columns)) {
    out[key] = typeof columns[key] === 'string'
      ? row[key]
      : !!row.credentialsEncrypted && row.credentialsEncrypted !== '';
  }
  return out;
}

vi.mock('../../db', () => ({
  db: {
    select: vi.fn((columns?: Record<string, unknown>) => ({
      from: vi.fn(() => ({
        where: vi.fn((..._a: unknown[]) => {
          dbState.capturedSelectWheres.push(_a[0]);
          const rows = dbState.connections.map((row) => projectRow(columns, row));
          const chain = { limit: vi.fn(async () => rows), orderBy: vi.fn(async () => rows) };
          return Object.assign(Promise.resolve(rows), chain);
        }),
        orderBy: vi.fn(async () => dbState.connections.map((row) => projectRow(columns, row))),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((v: Record<string, unknown>) => {
        // Mirror the real `backup_provider_connections_partner_provider_name_uniq`
        // unique index: a live Postgres would raise 23505 here.
        const dupe = dbState.connections.some((row) =>
          row.partnerId === v.partnerId && row.provider === v.provider && row.name === v.name);
        if (dupe) {
          const err = new Error('duplicate key value violates unique constraint');
          (err as unknown as { cause: unknown }).cause = { code: '23505' };
          return { returning: vi.fn(async () => { throw err; }) };
        }
        dbState.inserted.push(v);
        // Simulate the row now existing in the table, so a subsequent
        // `loadConnection()` re-select (POST/PATCH) can find it — the real
        // Postgres round-trip this mock stands in for would too.
        dbState.connections.push({ ...v });
        return { returning: vi.fn(async () => [{ ...v }]) };
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn((v: Record<string, unknown>) => {
        dbState.updated.push(v);
        return {
          where: vi.fn((cond: unknown) => {
            dbState.capturedUpdateWheres.push(cond);
            return { returning: vi.fn(async () => [{ id: CONNECTION_ID, ...v }]) };
          }),
        };
      }),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(async (cond: unknown) => { dbState.capturedDeleteWheres.push(cond); dbState.deleted += 1; return []; }),
    })),
    transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb({
      update: vi.fn(() => ({
        set: vi.fn((v: Record<string, unknown>) => {
          // Same duplicate-name simulation for the PATCH rename path, which
          // updates through the nested (savepointed) transaction.
          const renamedTo = typeof v.name === 'string' ? v.name : undefined;
          const dupe = renamedTo !== undefined && dbState.connections.some((row) =>
            row.id !== CONNECTION_ID && row.partnerId === PARTNER_ID
            && row.provider === 'cove' && row.name === renamedTo);
          if (dupe) {
            const err = new Error('duplicate key value violates unique constraint');
            (err as unknown as { cause: unknown }).cause = { code: '23505' };
            return {
              where: vi.fn((cond: unknown) => {
                dbState.capturedUpdateWheres.push(cond);
                return { returning: vi.fn(async () => { throw err; }) };
              }),
            };
          }
          dbState.updated.push(v);
          return {
            where: vi.fn((cond: unknown) => {
              dbState.capturedUpdateWheres.push(cond);
              return { returning: vi.fn(async () => [{ id: CONNECTION_ID, ...v }]) };
            }),
          };
        }),
      })),
      // drizzle's `sql` tagged template produces an `SQL` instance whose
      // `queryChunks` alternate `StringChunk { value: [...] }` and bound
      // params; plain `String(q)` renders `[object Object]` (toString is not
      // overridden), so pull the literal text out to make the assertion on
      // the query's shape meaningful.
      execute: vi.fn(async (q: unknown) => {
        const chunks = (q as { queryChunks?: unknown[] })?.queryChunks ?? [];
        const text = chunks.map((chunk) => {
          const value = (chunk as { value?: unknown[] })?.value;
          return Array.isArray(value) ? value.join('') : String(chunk);
        }).join(' ');
        dbState.executed.push(text);
        return [];
      }),
      delete: vi.fn(() => ({ where: vi.fn(async () => { dbState.deleted += 1; return []; }) })),
    })),
  },
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
}));

vi.mock('../../db/schema', () => ({
  backupProviderConnections: {
    id: 'id', partnerId: 'partner_id', provider: 'provider', name: 'name', baseUrl: 'base_url',
    credentialsEncrypted: 'credentials_encrypted', vendorRootId: 'vendor_root_id',
    vendorRootName: 'vendor_root_name', isActive: 'is_active', status: 'status',
    syncIntervalMinutes: 'sync_interval_minutes', showProviderNameInPortal: 'show_provider_name_in_portal',
    lastSyncAt: 'last_sync_at', lastSyncStatus: 'last_sync_status', lastSyncError: 'last_sync_error',
    lastSyncCustomers: 'last_sync_customers', lastSyncUnmappedCustomers: 'last_sync_unmapped_customers',
    lastSyncDevices: 'last_sync_devices', lastSyncUnmappedDevices: 'last_sync_unmapped_devices',
    lastSyncLinkedDevices: 'last_sync_linked_devices', lastSyncAmbiguousDevices: 'last_sync_ambiguous_devices',
    createdBy: 'created_by', createdAt: 'created_at', updatedAt: 'updated_at',
  },
  backupProviderCustomers: { id: 'id', connectionId: 'connection_id', partnerId: 'partner_id', orgId: 'org_id' },
  backupProviderDevices: { id: 'id', connectionId: 'connection_id', orgId: 'org_id', portalShowProviderName: 'portal_show_provider_name' },
  organizations: { id: 'id', name: 'name', partnerId: 'partner_id' },
  devices: { id: 'id', orgId: 'org_id', hostname: 'hostname', displayName: 'display_name', siteId: 'site_id', status: 'status' },
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      scope: authState.scope,
      orgId: authState.orgId,
      partnerId: authState.partnerId,
      partnerOrgAccess: authState.partnerOrgAccess,
      accessibleOrgIds: authState.accessibleOrgIds,
      canAccessOrg: (orgId: string) => authState.accessibleOrgIds.includes(orgId),
      orgCondition: vi.fn(() => undefined),
      user: { id: '99999999-9999-4999-8999-999999999999', email: 'tech@example.com' },
      token: { mfa: true },
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (c: any, next: any) => {
    if (gates.permission) return c.json({ error: 'Forbidden' }, 403);
    c.set('permissions', undefined);
    return next();
  }),
  requireMfa: vi.fn(() => async (c: any, next: any) =>
    gates.mfa ? c.json({ error: 'MFA required' }, 403) : next()),
  withAuthDbAccessContext: vi.fn(async (_auth: unknown, fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../../services/permissions', () => ({
  PERMISSIONS: {
    BACKUP_READ: { resource: 'backup', action: 'read' },
    BACKUP_WRITE: { resource: 'backup', action: 'write' },
    ORGS_WRITE: { resource: 'organizations', action: 'write' },
  },
  canAccessSite: () => true,
}));

vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));

vi.mock('../../services/backupProviders/registry', () => ({
  BACKUP_PROVIDER_KEYS: ['cove'],
  getBackupProvider: vi.fn((key: string) => {
    if (key !== 'cove') throw new Error(`Unknown backup provider "${key}" (registered: cove)`);
    return {
      key: 'cove',
      label: 'Cove Data Protection',
      credentialsSchema: {
        safeParse: (v: unknown) => {
          const ok = !!v && typeof v === 'object'
            && typeof (v as any).partnerName === 'string'
            && typeof (v as any).username === 'string'
            && typeof (v as any).password === 'string';
          return ok ? { success: true, data: v } : { success: false, error: { message: 'bad creds' } };
        },
      },
      testConnection: vi.fn(async () => adapterState.test),
      listCustomers: vi.fn(async () => []),
      listDevices: vi.fn(async () => []),
    };
  }),
}));

const encryptMock = vi.fn((id: string, _creds?: unknown) => `enc:${id}`);
vi.mock('../../services/backupProviders/credentials', () => ({
  encryptProviderCredentials: (id: string, creds: unknown) => encryptMock(id, creds as never),
  decryptProviderCredentials: vi.fn(() => ({ partnerName: 'p', username: 'u', password: 'x' })),
}));

const resolveAlertsMock = vi.fn(async () => 3);
vi.mock('../../services/backupProviders/alertsResolve', () => ({
  // Deferred reference (not a direct binding): vi.mock factories are hoisted
  // above this file's top-level `const` declarations, so a direct
  // `resolveProviderAlertsForConnection: resolveAlertsMock` would throw
  // "Cannot access 'resolveAlertsMock' before initialization" the moment the
  // hoisted factory runs. The lambda defers the read to call time.
  resolveProviderAlertsForConnection: (...args: Parameters<typeof resolveAlertsMock>) => resolveAlertsMock(...args),
  BACKUP_PROVIDER_ALERT_SOURCE: 'backup_provider',
}));

const enqueueMock = vi.fn(async () => 'job-1');
vi.mock('../../jobs/backupProviderSync', () => ({
  enqueueBackupProviderSync: (...args: Parameters<typeof enqueueMock>) => enqueueMock(...args),
}));

vi.mock('../../services/backupProviders/mapping', () => ({
  remapCustomer: vi.fn(async () => ({
    customerId: 'c1', connectionId: 'conn-1', orgId: null, mappingSource: 'manual_unmapped',
    deletedDevices: 0, deletedHistory: 0, resolvedAlerts: 0, syncJobId: 'job-1',
  })),
  RemapCustomerError: class RemapCustomerError extends Error { code = 'NOT_FOUND'; },
}));

import { authMiddleware } from '../../middleware/auth';
import { backupProviderRoutes } from './providers';

const CONNECTION_ID = '33333333-3333-4333-8333-333333333333';
const PARTNER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CREDS = { partnerName: 'OliveTech', username: 'api@olivetech.example', password: 'sup3r-s3cret' };

function connectionRow(over: Record<string, unknown> = {}) {
  return {
    id: CONNECTION_ID, partnerId: PARTNER_ID, provider: 'cove', name: 'OliveTech Cove',
    baseUrl: 'https://api.backup.management/jsonapi', credentialsEncrypted: 'enc:x',
    vendorRootId: '1000', vendorRootName: 'OliveTech', isActive: true, status: 'connected',
    syncIntervalMinutes: 30, showProviderNameInPortal: false, lastSyncAt: null,
    lastSyncStatus: null, lastSyncError: null, createdAt: new Date(), updatedAt: new Date(),
    ...over,
  };
}

describe('backup provider connection routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    gates.permission = false;
    gates.mfa = false;
    authState.scope = 'partner';
    authState.orgId = null;
    authState.partnerId = PARTNER_ID;
    authState.partnerOrgAccess = 'all';
    authState.accessibleOrgIds = [];
    adapterState.test = { ok: true, rootId: '1000', rootName: 'OliveTech', customerCount: 3 };
    dbState.connections = [];
    dbState.inserted = [];
    dbState.updated = [];
    dbState.deleted = 0;
    dbState.executed = [];
    dbState.capturedSelectWheres = [];
    dbState.capturedUpdateWheres = [];
    dbState.capturedDeleteWheres = [];
    enqueueMock.mockResolvedValue('job-1');
    resolveAlertsMock.mockResolvedValue(3);
    app = new Hono();
    // providers.ts relies on `authMiddleware` already being applied by the
    // outer `backup/index.ts` (it is not self-contained the way huntress.ts
    // is), so this standalone unit test has to wire it in itself.
    app.use('*', authMiddleware);
    app.route('/backup', backupProviderRoutes);
  });

  describe('GET /backup/providers/connections', () => {
    it('lists the partner connections and NEVER returns the ciphertext', async () => {
      dbState.connections = [connectionRow()];
      const res = await app.request('/backup/providers/connections');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0]).toMatchObject({ id: CONNECTION_ID, provider: 'cove', hasCredentials: true });
      expect(JSON.stringify(body)).not.toContain('credentialsEncrypted');
      expect(JSON.stringify(body)).not.toContain('enc:');
    });

    it('refuses an org-scoped caller', async () => {
      authState.scope = 'organization';
      authState.orgId = '11111111-1111-4111-8111-111111111111';
      const res = await app.request('/backup/providers/connections');
      expect(res.status).toBe(403);
    });

    it('still allows a partner caller with restricted org access to READ the list', async () => {
      // Deviation from the plan's literal test (which asserted 403 here): the
      // plan's own `resolveProviderPartnerId` doc comment and
      // `requireProviderPartnerAdmin` doc comment both say a `selected`-access
      // partner user MAY see the connection card and must only be blocked from
      // WRITES (rotate credential / re-map). `resolveProviderPartnerId` (the
      // read gate, transcribed verbatim from the plan) never inspects
      // `partnerOrgAccess`, so a 403 here would contradict the plan's own
      // design decision, not this route's actual gate.
      authState.partnerOrgAccess = 'selected';
      const res = await app.request('/backup/providers/connections');
      expect(res.status).toBe(200);
    });
  });

  describe('POST /backup/providers/connections', () => {
    const body = { provider: 'cove', name: 'OliveTech Cove', credentials: CREDS };

    it('tests the connection, stores the ciphertext under the PRE-GENERATED row id, and enqueues a sync', async () => {
      const res = await app.request('/backup/providers/connections', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      expect(res.status).toBe(201);
      const created = dbState.inserted[0]!;
      // Row-bound AAD: the id must exist BEFORE the encryption, not be defaulted
      // by the database afterwards.
      expect(typeof created.id).toBe('string');
      expect(encryptMock).toHaveBeenCalledWith(created.id, CREDS);
      expect(created.credentialsEncrypted).toBe(`enc:${created.id}`);
      expect(created.vendorRootId).toBe('1000');
      expect(created.status).toBe('connected');
      expect(enqueueMock).toHaveBeenCalledWith(created.id);
      const payload = await res.json();
      expect(payload.data.hasCredentials).toBe(true);
      expect(JSON.stringify(payload)).not.toContain(CREDS.password);
    });

    it('refuses with 422 and does NOT store anything when the vendor test fails', async () => {
      adapterState.test = { ok: false, error: 'Cove login was rejected', reauth: true };
      const res = await app.request('/backup/providers/connections', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      expect(res.status).toBe(422);
      expect(await res.json()).toMatchObject({ success: false, reauth: true });
      expect(dbState.inserted).toHaveLength(0);
      expect(enqueueMock).not.toHaveBeenCalled();
    });

    it('rejects an unknown provider with 400 before any vendor call', async () => {
      const res = await app.request('/backup/providers/connections', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, provider: 'veeam' }),
      });
      expect(res.status).toBe(400);
      expect(dbState.inserted).toHaveLength(0);
    });

    it('rejects a credential blob the adapter schema refuses', async () => {
      const res = await app.request('/backup/providers/connections', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, credentials: { username: 'u' } }),
      });
      expect(res.status).toBe(400);
    });

    it('rejects a non-HTTPS baseUrl override', async () => {
      const res = await app.request('/backup/providers/connections', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, baseUrl: 'http://api.backup.management/jsonapi' }),
      });
      expect(res.status).toBe(400);
    });

    it('is gated on the write permission and on MFA', async () => {
      gates.permission = true;
      let res = await app.request('/backup/providers/connections', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      expect(res.status).toBe(403);

      gates.permission = false;
      gates.mfa = true;
      res = await app.request('/backup/providers/connections', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      expect(res.status).toBe(403);
    });

    it('refuses a partner caller with restricted org access', async () => {
      authState.partnerOrgAccess = 'selected';
      const res = await app.request('/backup/providers/connections', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      expect(res.status).toBe(403);
      expect(dbState.inserted).toHaveLength(0);
    });

    it('maps a racing 23505 on the (partner, provider, name) unique index to 409', async () => {
      // Already has a live Cove login round-trip behind it by the time the
      // insert runs — the point of this test is that the duplicate name is
      // reported cleanly, not as an unhandled 500.
      dbState.connections = [connectionRow({ name: 'OliveTech Cove' })];
      const res = await app.request('/backup/providers/connections', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({
        error: 'A connection named "OliveTech Cove" already exists for this provider.',
      });
      // Only the pre-existing seeded row — nothing new was stored.
      expect(dbState.inserted).toHaveLength(0);
      expect(enqueueMock).not.toHaveBeenCalled();
    });

    it('still creates the connection when the initial sync cannot be queued', async () => {
      enqueueMock.mockRejectedValue(new Error('redis down'));
      const res = await app.request('/backup/providers/connections', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      expect(res.status).toBe(201);
      expect((await res.json()).syncWarning).toBeTruthy();
    });
  });

  describe('PATCH /backup/providers/connections/:id', () => {
    beforeEach(() => { dbState.connections = [connectionRow()]; });

    it('renames without touching the credential or calling the vendor', async () => {
      const res = await app.request(`/backup/providers/connections/${CONNECTION_ID}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Renamed' }),
      });
      expect(res.status).toBe(200);
      expect(dbState.updated[0]).toMatchObject({ name: 'Renamed' });
      expect(dbState.updated[0]!.credentialsEncrypted).toBeUndefined();
      expect(encryptMock).not.toHaveBeenCalled();
    });

    it('re-tests and re-seals new credentials under the EXISTING row id, resetting status', async () => {
      dbState.connections = [connectionRow({ status: 'reauth_required', lastSyncError: 'dead' })];
      const res = await app.request(`/backup/providers/connections/${CONNECTION_ID}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ credentials: CREDS }),
      });
      expect(res.status).toBe(200);
      expect(encryptMock).toHaveBeenCalledWith(CONNECTION_ID, CREDS);
      expect(dbState.updated[0]).toMatchObject({
        credentialsEncrypted: `enc:${CONNECTION_ID}`,
        status: 'connected',
        lastSyncError: null,
      });
    });

    it('refuses with 422 when the new credentials fail the vendor test, leaving the old ones in place', async () => {
      adapterState.test = { ok: false, error: 'rejected', reauth: true };
      const res = await app.request(`/backup/providers/connections/${CONNECTION_ID}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ credentials: CREDS }),
      });
      expect(res.status).toBe(422);
      expect(dbState.updated).toHaveLength(0);
    });

    it('rewrites the denormalized portal flag on the device rows IN THE SAME transaction', async () => {
      const res = await app.request(`/backup/providers/connections/${CONNECTION_ID}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ showProviderNameInPortal: true }),
      });
      expect(res.status).toBe(200);
      // The portal reads the label off backup_provider_devices (it cannot read
      // the partner-axis connection table at all), so a flag left un-mirrored
      // silently keeps showing the generic label — or the vendor name after the
      // MSP turned it off.
      const mirrored = dbState.executed.join(' ');
      expect(mirrored).toContain('backup_provider_devices');
      expect(mirrored).toContain('portal_show_provider_name');
    });

    it('does not rewrite the device rows when the flag is not part of the patch', async () => {
      await app.request(`/backup/providers/connections/${CONNECTION_ID}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Renamed' }),
      });
      expect(dbState.executed).toHaveLength(0);
    });

    it('404s for a connection outside the caller partner', async () => {
      dbState.connections = [];
      const res = await app.request(`/backup/providers/connections/${CONNECTION_ID}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Renamed' }),
      });
      expect(res.status).toBe(404);
    });

    it('maps a racing 23505 on rename onto an existing name to 409', async () => {
      dbState.connections = [
        connectionRow(),
        connectionRow({ id: '44444444-4444-4444-8444-444444444444', name: 'Taken Name' }),
      ];
      const res = await app.request(`/backup/providers/connections/${CONNECTION_ID}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Taken Name' }),
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({
        error: 'A connection named "Taken Name" already exists for this provider.',
      });
    });

    it('rejects an empty patch rather than writing an empty UPDATE', async () => {
      const res = await app.request(`/backup/providers/connections/${CONNECTION_ID}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });
  });

  describe('POST /backup/providers/connections/:id/test', () => {
    beforeEach(() => { dbState.connections = [connectionRow()]; });

    it('returns the PSA testResult shape on success', async () => {
      const res = await app.request(`/backup/providers/connections/${CONNECTION_ID}/test`, { method: 'POST' });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        success: true, rootName: 'OliveTech', customerCount: 3,
      });
    });

    it('answers HTTP 200 with success:false on a vendor failure, and persists reauth_required', async () => {
      adapterState.test = { ok: false, error: 'Cove login was rejected', reauth: true };
      const res = await app.request(`/backup/providers/connections/${CONNECTION_ID}/test`, { method: 'POST' });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ success: false, error: expect.stringContaining('rejected') });
      expect(dbState.updated[0]).toMatchObject({ status: 'reauth_required' });
    });

    it('does NOT flip the connection to reauth_required on a transient failure', async () => {
      adapterState.test = { ok: false, error: 'HTTP 503', reauth: false };
      const res = await app.request(`/backup/providers/connections/${CONNECTION_ID}/test`, { method: 'POST' });
      expect(res.status).toBe(200);
      expect(dbState.updated[0]?.status).not.toBe('reauth_required');
    });
  });

  describe('POST /backup/providers/connections/:id/sync', () => {
    beforeEach(() => { dbState.connections = [connectionRow()]; });

    it('enqueues outside the ambient DB context and echoes the job id', async () => {
      const res = await app.request(`/backup/providers/connections/${CONNECTION_ID}/sync`, { method: 'POST' });
      expect(res.status).toBe(202);
      expect(await res.json()).toMatchObject({ syncJobId: 'job-1' });
      expect(enqueueMock).toHaveBeenCalledWith(CONNECTION_ID);
      const { runOutsideDbContext } = await import('../../db');
      expect(runOutsideDbContext).toHaveBeenCalled();
    });

    it('refuses to sync an inactive connection', async () => {
      dbState.connections = [connectionRow({ isActive: false })];
      const res = await app.request(`/backup/providers/connections/${CONNECTION_ID}/sync`, { method: 'POST' });
      expect(res.status).toBe(409);
      expect(enqueueMock).not.toHaveBeenCalled();
    });

    it('DOES allow a reauth_required connection to be retried after a credential PATCH', async () => {
      // "Sync now" is the only way a reauth_required connection is retried, and
      // the credential PATCH is what resets its status — so the route must not
      // refuse on status alone.
      dbState.connections = [connectionRow({ status: 'reauth_required' })];
      const res = await app.request(`/backup/providers/connections/${CONNECTION_ID}/sync`, { method: 'POST' });
      expect(res.status).toBe(202);
    });
  });

  describe('DELETE /backup/providers/connections/:id', () => {
    beforeEach(() => { dbState.connections = [connectionRow()]; });

    it('resolves the open provider alerts BEFORE deleting', async () => {
      const res = await app.request(`/backup/providers/connections/${CONNECTION_ID}`, { method: 'DELETE' });
      expect(res.status).toBe(200);
      expect(resolveAlertsMock).toHaveBeenCalledWith(CONNECTION_ID);
      expect(resolveAlertsMock.mock.invocationCallOrder[0]!).toBeLessThan(
        vi.mocked((await import('../../db')).db.delete).mock.invocationCallOrder[0]!,
      );
      expect(dbState.deleted).toBe(1);
    });

    it('404s for a connection outside the caller partner and deletes nothing', async () => {
      dbState.connections = [];
      const res = await app.request(`/backup/providers/connections/${CONNECTION_ID}`, { method: 'DELETE' });
      expect(res.status).toBe(404);
      expect(dbState.deleted).toBe(0);
      expect(resolveAlertsMock).not.toHaveBeenCalled();
    });
  });

  // Defense-in-depth, not the live backstop (RLS is): this mock's `.where()`
  // ignores the condition it's given and returns every seeded row regardless,
  // so a query that dropped its `eq(...partnerId...)` clause would still pass
  // every other test in this file. These assert the built condition actually
  // references the partner column.
  describe('tenant scoping (defense-in-depth on the mocked condition)', () => {
    beforeEach(() => { dbState.connections = [connectionRow()]; });

    it('GET /connections scopes the list select to the caller partner', async () => {
      await app.request('/backup/providers/connections');
      expect(dbState.capturedSelectWheres).toHaveLength(1);
      expect(referencesColumn(dbState.capturedSelectWheres[0], 'partner_id')).toBe(true);
    });

    it('POST /connections scopes the post-insert loadConnection select to the caller partner', async () => {
      dbState.connections = [];
      await app.request('/backup/providers/connections', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'cove', name: 'OliveTech Cove', credentials: CREDS }),
      });
      expect(dbState.capturedSelectWheres.length).toBeGreaterThan(0);
      expect(dbState.capturedSelectWheres.some((c) => referencesColumn(c, 'partner_id'))).toBe(true);
    });

    it('PATCH /connections/:id scopes both the pre-check select and the update to the caller partner', async () => {
      await app.request(`/backup/providers/connections/${CONNECTION_ID}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Renamed' }),
      });
      expect(dbState.capturedSelectWheres.some((c) => referencesColumn(c, 'partner_id'))).toBe(true);
      expect(dbState.capturedUpdateWheres.some((c) => referencesColumn(c, 'partner_id'))).toBe(true);
    });

    it('DELETE /connections/:id scopes both the pre-check select and the delete to the caller partner', async () => {
      await app.request(`/backup/providers/connections/${CONNECTION_ID}`, { method: 'DELETE' });
      expect(dbState.capturedSelectWheres.some((c) => referencesColumn(c, 'partner_id'))).toBe(true);
      expect(dbState.capturedDeleteWheres.some((c) => referencesColumn(c, 'partner_id'))).toBe(true);
    });
  });
});
