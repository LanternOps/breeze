import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { inArray } from 'drizzle-orm';

// The REAL service and the REAL schema are used here — only the database, the
// auth middleware and the audit writer are stubbed. That keeps the secret
// redaction and the tenancy conditions under test at the route level, where a
// leak would actually reach a client.
vi.mock('../db', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn())
}));

const currentAuth: {
  scope: 'organization' | 'partner' | 'system';
  partnerOrgAccess?: 'all' | 'selected' | 'none' | null;
} = { scope: 'partner', partnerOrgAccess: 'all' };

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      principal: 'user',
      user: { id: USER_ID, email: 'tech@example.com', name: 'Tech', isPlatformAdmin: false },
      token: {},
      scope: currentAuth.scope,
      partnerId: PARTNER_ID,
      orgId: currentAuth.scope === 'organization' ? ORG_ID : null,
      accessibleOrgIds: [ORG_ID],
      partnerOrgAccess: currentAuth.partnerOrgAccess,
      orgCondition: (column: any) => inArray(column, [ORG_ID]),
      canAccessOrg: (orgId: string) => orgId === ORG_ID
    });
    return next();
  }),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireScope: vi.fn(() => async (_c: any, next: any) => next())
}));

const writeRouteAuditMock = vi.fn();
vi.mock('../services/auditEvents', () => ({ writeRouteAudit: (...args: unknown[]) => writeRouteAuditMock(...args) }));

import { db } from '../db';
import { tenantVariableRoutes } from './tenantVariables';
import { encryptTenantVariableValue } from '../services/tenantVariables';
import type { TenantVariableRow } from '../db/schema';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_ORG_ID = '99999999-9999-4999-8999-999999999999';
const PARTNER_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const VAR_ID = '44444444-4444-4444-8444-444444444444';

const dbMock = db as unknown as {
  select: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
};

function makeRow(overrides: Partial<TenantVariableRow> = {}): TenantVariableRow {
  const id = overrides.id ?? VAR_ID;
  return {
    id,
    partnerId: null,
    orgId: ORG_ID,
    key: 's1_site_token',
    value: encryptTenantVariableValue(id, 'super-secret-token'),
    isSecret: false,
    description: null,
    version: 1,
    createdBy: USER_ID,
    updatedBy: USER_ID,
    createdAt: new Date('2026-08-11T00:00:00Z'),
    updatedAt: new Date('2026-08-11T00:00:00Z'),
    ...overrides
  } as TenantVariableRow;
}

/** db.select() stub that is awaitable and also answers .limit()/.orderBy(). */
function stubSelect(rows: unknown[]) {
  const terminal = {
    limit: () => Promise.resolve(rows),
    orderBy: () => Promise.resolve(rows),
    then: (resolve: (v: unknown[]) => unknown) => Promise.resolve(rows).then(resolve)
  };
  dbMock.select.mockReturnValue({ from: () => ({ where: () => terminal }) });
}

/** Capacity count first, then the row lookup. */
function stubSelectSequence(...results: unknown[][]) {
  let call = 0;
  dbMock.select.mockImplementation(() => {
    const rows = results[Math.min(call++, results.length - 1)] ?? [];
    const terminal = {
      limit: () => Promise.resolve(rows),
      orderBy: () => Promise.resolve(rows),
      then: (resolve: (v: unknown[]) => unknown) => Promise.resolve(rows).then(resolve)
    };
    return { from: () => ({ where: () => terminal }) };
  });
}

function jsonRequest(app: Hono, path: string, method: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

describe('tenant variable routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.APP_ENCRYPTION_KEY = 'route-test-key-material';
    process.env.APP_ENCRYPTION_KEY_ID = 'route-test';
    currentAuth.scope = 'partner';
    currentAuth.partnerOrgAccess = 'all';
    app = new Hono();
    app.route('/', tenantVariableRoutes);
  });

  describe('GET /tenant-variables', () => {
    it('returns the plaintext for a non-secret variable', async () => {
      stubSelect([makeRow()]);
      const res = await app.request('/tenant-variables', { headers: { Authorization: 'Bearer token' } });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data[0]).toMatchObject({ key: 's1_site_token', value: 'super-secret-token', isSecret: false });
    });

    it('never returns a secret value anywhere in the response body', async () => {
      stubSelect([makeRow({ isSecret: true })]);
      const res = await app.request('/tenant-variables', { headers: { Authorization: 'Bearer token' } });
      const raw = await res.text();
      expect(raw).not.toContain('super-secret-token');
      expect(JSON.parse(raw).data[0]).toMatchObject({ isSecret: true, value: null });
    });

    it('marks an inherited partner-wide row with ownerScope partner', async () => {
      stubSelect([makeRow({ orgId: null, partnerId: PARTNER_ID })]);
      const res = await app.request('/tenant-variables', { headers: { Authorization: 'Bearer token' } });
      const body = await res.json();
      expect(body.data[0].ownerScope).toBe('partner');
    });

    it('403s an orgId filter the caller cannot reach, without querying', async () => {
      stubSelect([]);
      const res = await app.request(`/tenant-variables?orgId=${OTHER_ORG_ID}`, {
        headers: { Authorization: 'Bearer token' }
      });
      expect(res.status).toBe(403);
      expect(dbMock.select).not.toHaveBeenCalled();
    });
  });

  describe('POST /tenant-variables', () => {
    function stubInsert(row: TenantVariableRow) {
      const captured: { values?: Record<string, unknown> } = {};
      dbMock.insert.mockReturnValue({
        values: (values: Record<string, unknown>) => {
          captured.values = values;
          return { returning: () => Promise.resolve([row]) };
        }
      });
      return captured;
    }

    it('creates an org-scoped variable and audits without the value', async () => {
      stubSelectSequence([{ total: 0 }]);
      stubInsert(makeRow());

      const res = await jsonRequest(app, '/tenant-variables', 'POST', {
        ownerScope: 'organization',
        orgId: ORG_ID,
        key: 's1_site_token',
        value: 'super-secret-token'
      });

      expect(res.status).toBe(201);
      expect(writeRouteAuditMock).toHaveBeenCalledTimes(1);
      const audit = writeRouteAuditMock.mock.calls[0]![1] as { action: string; details: Record<string, unknown> };
      expect(audit.action).toBe('tenant_variable.create');
      expect(JSON.stringify(audit.details)).not.toContain('super-secret-token');
      expect(audit.details).toMatchObject({ key: 's1_site_token', ownerScope: 'organization' });
    });

    it('403s a partner-wide create from an org-scoped session', async () => {
      currentAuth.scope = 'organization';
      currentAuth.partnerOrgAccess = undefined;
      stubSelectSequence([{ total: 0 }]);
      stubInsert(makeRow());

      const res = await jsonRequest(app, '/tenant-variables', 'POST', {
        ownerScope: 'partner',
        key: 'k',
        value: 'v'
      });

      expect(res.status).toBe(403);
      expect(dbMock.insert).not.toHaveBeenCalled();
      expect(writeRouteAuditMock).not.toHaveBeenCalled();
    });

    it('403s a partner-wide create from a partner admin without full org access', async () => {
      currentAuth.partnerOrgAccess = 'selected';
      stubSelectSequence([{ total: 0 }]);
      stubInsert(makeRow());

      const res = await jsonRequest(app, '/tenant-variables', 'POST', {
        ownerScope: 'partner',
        key: 'k',
        value: 'v'
      });

      expect(res.status).toBe(403);
      expect(dbMock.insert).not.toHaveBeenCalled();
    });

    it('409s a duplicate key in the same scope', async () => {
      stubSelectSequence([{ total: 0 }]);
      dbMock.insert.mockReturnValue({
        values: () => ({
          returning: () => Promise.reject(Object.assign(new Error('dup'), { cause: { code: '23505' } }))
        })
      });

      const res = await jsonRequest(app, '/tenant-variables', 'POST', {
        ownerScope: 'organization',
        orgId: ORG_ID,
        key: 's1_site_token',
        value: 'v'
      });

      expect(res.status).toBe(409);
    });

    it('400s an invalid key before any DB work', async () => {
      stubSelectSequence([{ total: 0 }]);
      const res = await jsonRequest(app, '/tenant-variables', 'POST', {
        ownerScope: 'organization',
        orgId: ORG_ID,
        key: 'Not A Key',
        value: 'v'
      });
      expect(res.status).toBe(400);
      expect(dbMock.insert).not.toHaveBeenCalled();
    });
  });

  describe('PUT /tenant-variables/:id', () => {
    function stubUpdate(row: TenantVariableRow) {
      const captured: { set?: Record<string, unknown> } = {};
      dbMock.update.mockReturnValue({
        set: (values: Record<string, unknown>) => {
          captured.set = values;
          return { where: () => ({ returning: () => Promise.resolve([row]) }) };
        }
      });
      return captured;
    }

    it('leaves the stored ciphertext untouched when value is omitted', async () => {
      const row = makeRow({ isSecret: true });
      stubSelect([row]);
      const captured = stubUpdate(row);

      const res = await jsonRequest(app, `/tenant-variables/${VAR_ID}`, 'PUT', { description: 'rotated quarterly' });

      expect(res.status).toBe(200);
      expect(captured.set).not.toHaveProperty('value');
      const body = await res.json();
      expect(body.data.value).toBeNull();
    });

    it('400s an attempt to un-secret a variable without a replacement value', async () => {
      const row = makeRow({ isSecret: true });
      stubSelect([row]);
      stubUpdate(row);

      const res = await jsonRequest(app, `/tenant-variables/${VAR_ID}`, 'PUT', { isSecret: false });

      expect(res.status).toBe(400);
      expect(dbMock.update).not.toHaveBeenCalled();
    });

    it('404s a variable the caller cannot reach', async () => {
      stubSelect([]);
      const res = await jsonRequest(app, `/tenant-variables/${VAR_ID}`, 'PUT', { description: 'x' });
      expect(res.status).toBe(404);
    });

    it('records whether the value changed, but never the value', async () => {
      const row = makeRow();
      stubSelect([row]);
      stubUpdate(row);

      await jsonRequest(app, `/tenant-variables/${VAR_ID}`, 'PUT', { value: 'brand-new-token' });

      const audit = writeRouteAuditMock.mock.calls[0]![1] as { details: Record<string, unknown> };
      expect(audit.details).toMatchObject({ valueChanged: true });
      expect(JSON.stringify(audit.details)).not.toContain('brand-new-token');
    });
  });

  describe('DELETE /tenant-variables/:id', () => {
    it('deletes a reachable variable and audits it', async () => {
      stubSelect([makeRow()]);
      dbMock.delete.mockReturnValue({ where: () => ({ returning: () => Promise.resolve([makeRow()]) }) });

      const res = await jsonRequest(app, `/tenant-variables/${VAR_ID}`, 'DELETE');

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true });
      const audit = writeRouteAuditMock.mock.calls[0]![1] as { action: string };
      expect(audit.action).toBe('tenant_variable.delete');
    });

    it('404s — never 403s — when an org session names a partner-wide variable', async () => {
      // The write condition excludes partner-wide rows for org scope, so the
      // lookup finds nothing: existence must not be confirmed by a 403.
      currentAuth.scope = 'organization';
      currentAuth.partnerOrgAccess = undefined;
      stubSelect([]);
      dbMock.delete.mockReturnValue({ where: () => ({ returning: () => Promise.resolve([makeRow()]) }) });

      const res = await jsonRequest(app, `/tenant-variables/${VAR_ID}`, 'DELETE');

      expect(res.status).toBe(404);
      expect(dbMock.delete).not.toHaveBeenCalled();
    });
  });
});
