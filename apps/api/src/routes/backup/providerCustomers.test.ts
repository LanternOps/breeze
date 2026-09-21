import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const { authState, gates, dbState, remapState } = vi.hoisted(() => ({
  authState: {
    scope: 'partner' as 'organization' | 'partner' | 'system',
    partnerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as string | null,
    partnerOrgAccess: 'all' as 'all' | 'selected' | 'none' | null,
    orgId: null as string | null,
    accessibleOrgIds: [] as string[],
  },
  gates: { permission: false, mfa: false },
  dbState: {
    connections: [] as unknown[],
    customers: [] as unknown[],
    // Defense-in-depth: this mock's `.where()` ignores the condition and
    // returns the fixture regardless, so deleting a tenant-scoping
    // `eq(...partnerId...)` from the route would keep the whole mocked suite
    // green. RLS is the real backstop; this captures the built condition so a
    // test can assert the partner column is actually referenced.
    capturedSelectWheres: [] as unknown[],
  },
  remapState: { result: null as unknown, error: null as null | { code: string; message: string } },
}));

/** True if the drizzle condition's SQL tree references a leaf equal to `marker` (a mocked schema column is a plain string, e.g. 'partner_id'). */
function referencesColumn(node: unknown, marker: string): boolean {
  if (node === marker) return true;
  if (node && typeof node === 'object' && Array.isArray((node as { queryChunks?: unknown[] }).queryChunks)) {
    return (node as { queryChunks: unknown[] }).queryChunks.some((c) => referencesColumn(c, marker));
  }
  return false;
}

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn((cond: unknown) => {
          dbState.capturedSelectWheres.push(cond);
          return {
            limit: vi.fn(async () => dbState.connections),
            orderBy: vi.fn(async () => dbState.customers),
          };
        }),
        leftJoin: vi.fn(() => ({
          where: vi.fn(() => ({ orderBy: vi.fn(async () => dbState.customers) })),
        })),
      })),
    })),
  },
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
}));

vi.mock('../../db/schema', () => ({
  backupProviderConnections: { id: 'id', partnerId: 'partner_id', name: 'name' },
  backupProviderCustomers: {
    id: 'id', connectionId: 'connection_id', partnerId: 'partner_id', orgId: 'org_id',
    vendorCustomerId: 'vendor_customer_id', vendorCustomerName: 'vendor_customer_name',
    vendorLevel: 'vendor_level', vendorExternalCode: 'vendor_external_code',
    mappingSource: 'mapping_source', deviceCount: 'device_count', lastSeenAt: 'last_seen_at',
  },
  organizations: { id: 'id', name: 'name', partnerId: 'partner_id' },
}));

vi.mock('../../middleware/auth', () => ({
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (c: any, next: any) =>
    gates.permission ? c.json({ error: 'Forbidden' }, 403) : next()),
  requireMfa: vi.fn(() => async (c: any, next: any) =>
    gates.mfa ? c.json({ error: 'MFA required' }, 403) : next()),
  withAuthDbAccessContext: vi.fn(async (_a: unknown, fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../../services/permissions', () => ({
  PERMISSIONS: {
    BACKUP_READ: { resource: 'backup', action: 'read' },
    BACKUP_WRITE: { resource: 'backup', action: 'write' },
    ORGS_WRITE: { resource: 'organizations', action: 'write' },
  },
}));

vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));

// Both the class declaration and `remapMock` must be reachable from inside
// the (hoisted) `vi.mock` factory below without a TDZ violation, so they are
// built inside `vi.hoisted` — a plain top-level `class`/`const` here would
// throw "Cannot access '...' before initialization" the moment the hoisted
// factory runs, since `vi.mock` calls are hoisted above ALL other statements
// in the file, not just other `vi.mock` calls.
const { FakeRemapError, remapMock } = vi.hoisted(() => {
  class FakeRemapError extends Error {
    code: string;
    constructor(code: string, message: string) { super(message); this.code = code; this.name = 'RemapCustomerError'; }
  }
  const remapMock = vi.fn(async (): Promise<unknown> => { throw new Error('remapState not wired yet'); });
  return { FakeRemapError, remapMock };
});
remapMock.mockImplementation(async () => {
  if (remapState.error) throw new FakeRemapError(remapState.error.code, remapState.error.message);
  return remapState.result;
});
vi.mock('../../services/backupProviders/mapping', () => ({
  remapCustomer: remapMock,
  RemapCustomerError: FakeRemapError,
}));

import { backupProviderCustomerRoutes } from './providerCustomers';

const CONNECTION_ID = '33333333-3333-4333-8333-333333333333';
const CUSTOMER_ID = '44444444-4444-4444-8444-444444444444';
const ORG_ID = '11111111-1111-4111-8111-111111111111';

describe('backup provider customer routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    gates.permission = false;
    gates.mfa = false;
    authState.scope = 'partner';
    authState.partnerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    authState.partnerOrgAccess = 'all';
    dbState.connections = [{ id: CONNECTION_ID, partnerId: authState.partnerId, name: 'OliveTech Cove' }];
    dbState.customers = [];
    dbState.capturedSelectWheres = [];
    remapState.error = null;
    remapState.result = {
      customerId: CUSTOMER_ID, connectionId: CONNECTION_ID, orgId: ORG_ID,
      mappingSource: 'manual', deletedDevices: 4, deletedHistory: 9, resolvedAlerts: 1, syncJobId: 'job-1',
    };
    app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth', {
        principal: { kind: 'user_session' },
        scope: authState.scope,
        partnerId: authState.partnerId,
        partnerOrgAccess: authState.partnerOrgAccess,
        orgId: authState.orgId,
        accessibleOrgIds: authState.accessibleOrgIds,
        canAccessOrg: (id: string) => authState.accessibleOrgIds.includes(id),
        orgCondition: () => undefined,
        user: { id: '99999999-9999-4999-8999-999999999999', email: 't@example.com', name: 'Test Tech', isPlatformAdmin: false },
        token: null,
      });
      await next();
    });
    app.route('/backup/providers', backupProviderCustomerRoutes);
  });

  describe('GET /connections/:id/customers', () => {
    it('returns rows plus an unmapped summary', async () => {
      dbState.customers = [
        { id: CUSTOMER_ID, vendorCustomerId: '2001', vendorCustomerName: 'Acme Corp', vendorLevel: 'EndCustomer', vendorExternalCode: null, orgId: ORG_ID, orgName: 'Acme', mappingSource: 'auto_name', deviceCount: 12, lastSeenAt: null },
        { id: '55555555-5555-4555-8555-555555555555', vendorCustomerId: '2002', vendorCustomerName: 'Beta', vendorLevel: 'EndCustomer', vendorExternalCode: null, orgId: null, orgName: null, mappingSource: null, deviceCount: 7, lastSeenAt: null },
      ];
      const res = await app.request(`/backup/providers/connections/${CONNECTION_ID}/customers`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(2);
      // The unmapped summary is what stops a partner-wide view implying complete
      // vendor coverage (spec, Non-goals).
      expect(body.summary).toEqual({ customers: 2, unmappedCustomers: 1, unmappedDeviceCount: 7 });
    });

    it('404s for a connection outside the caller partner', async () => {
      dbState.connections = [];
      const res = await app.request(`/backup/providers/connections/${CONNECTION_ID}/customers`);
      expect(res.status).toBe(404);
    });

    it('refuses an org-scoped caller', async () => {
      authState.scope = 'organization';
      authState.orgId = ORG_ID;
      const res = await app.request(`/backup/providers/connections/${CONNECTION_ID}/customers`);
      expect(res.status).toBe(403);
    });

    it('scopes the connection-ownership pre-check to the caller partner (defense-in-depth)', async () => {
      await app.request(`/backup/providers/connections/${CONNECTION_ID}/customers`);
      expect(dbState.capturedSelectWheres).toHaveLength(1);
      expect(referencesColumn(dbState.capturedSelectWheres[0], 'partner_id')).toBe(true);
    });
  });

  describe('PUT /customers/:id/mapping', () => {
    it('maps a customer through remapCustomer and reports what was removed', async () => {
      const res = await app.request(`/backup/providers/customers/${CUSTOMER_ID}/mapping`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ orgId: ORG_ID }),
      });
      expect(res.status).toBe(200);
      expect(remapMock).toHaveBeenCalledWith(CUSTOMER_ID, ORG_ID, expect.objectContaining({ partnerId: authState.partnerId }));
      expect(await res.json()).toMatchObject({
        data: { mappingSource: 'manual', deletedDevices: 4, syncJobId: 'job-1' },
      });
    });

    it('accepts an explicit null to un-map', async () => {
      remapState.result = { ...(remapState.result as object), orgId: null, mappingSource: 'manual_unmapped' };
      const res = await app.request(`/backup/providers/customers/${CUSTOMER_ID}/mapping`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ orgId: null }),
      });
      expect(res.status).toBe(200);
      expect(remapMock).toHaveBeenCalledWith(CUSTOMER_ID, null, expect.anything());
    });

    it('rejects a missing orgId key rather than silently un-mapping', async () => {
      // `{}` and `{orgId: null}` must not mean the same thing: one is a
      // malformed request, the other a deliberate un-map.
      const res = await app.request(`/backup/providers/customers/${CUSTOMER_ID}/mapping`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      expect(remapMock).not.toHaveBeenCalled();
    });

    it('maps ORG_NOT_IN_PARTNER to 422 and NOT_FOUND to 404', async () => {
      remapState.error = { code: 'ORG_NOT_IN_PARTNER', message: 'nope' };
      let res = await app.request(`/backup/providers/customers/${CUSTOMER_ID}/mapping`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ orgId: ORG_ID }),
      });
      expect(res.status).toBe(422);

      remapState.error = { code: 'NOT_FOUND', message: 'gone' };
      res = await app.request(`/backup/providers/customers/${CUSTOMER_ID}/mapping`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ orgId: ORG_ID }),
      });
      expect(res.status).toBe(404);
    });

    it('is gated on the write permission, MFA and full partner org access', async () => {
      gates.permission = true;
      let res = await app.request(`/backup/providers/customers/${CUSTOMER_ID}/mapping`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ orgId: null }),
      });
      expect(res.status).toBe(403);

      gates.permission = false;
      gates.mfa = true;
      res = await app.request(`/backup/providers/customers/${CUSTOMER_ID}/mapping`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ orgId: null }),
      });
      expect(res.status).toBe(403);

      gates.mfa = false;
      authState.partnerOrgAccess = 'selected';
      res = await app.request(`/backup/providers/customers/${CUSTOMER_ID}/mapping`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ orgId: null }),
      });
      expect(res.status).toBe(403);
      expect(remapMock).not.toHaveBeenCalled();
    });
  });
});
