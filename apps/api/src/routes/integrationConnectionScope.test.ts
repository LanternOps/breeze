import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { eq, inArray, sql } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';

const mocks = vi.hoisted(() => ({
  auth: {} as Record<string, unknown>,
  permissionDenied: false,
  mfaDenied: false,
  select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn(),
  context: vi.fn(), encrypt: vi.fn(), decrypt: vi.fn(), audit: vi.fn(),
  provider: vi.fn(), testConnection: vi.fn(), scheduleSync: vi.fn(), schedulePolicy: vi.fn(),
}));

vi.mock('../services', () => ({}));
vi.mock('../db', () => ({
  db: mocks,
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withDbAccessContext: (_ctx: unknown, fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));
vi.mock('../middleware/auth', () => ({
  authMiddleware: (c: any, next: any) => { c.set('auth', mocks.auth); return next(); },
  withAuthDbAccessContext: (...args: unknown[]) => mocks.context(...args),
  requireScope: (...scopes: string[]) => (c: any, next: any) =>
    scopes.includes(c.get('auth')?.scope) ? next() : c.json({ error: 'Forbidden' }, 403),
  requirePermission: () => (c: any, next: any) => {
    c.set('permissions', { allowedSiteIds: mocks.auth.allowedSiteIds });
    return mocks.permissionDenied ? c.json({ error: 'Permission denied' }, 403) : next();
  },
  requireMfa: () => (c: any, next: any) =>
    mocks.mfaDenied ? c.json({ error: 'MFA required' }, 403) : next(),
}));
vi.mock('../middleware/userRateLimit', () => ({ userRateLimit: () => (_c: any, next: any) => next() }));
vi.mock('../services/psa', () => ({ createPSAProvider: mocks.provider }));
vi.mock('../services/secretCrypto', () => ({
  encryptSecret: mocks.encrypt,
  decryptSecret: mocks.decrypt,
  decryptForColumn: (_table: string, _column: string, value: string) => mocks.decrypt(value),
}));
vi.mock('../services/auditEvents', () => ({ writeRouteAudit: mocks.audit }));
vi.mock('../jobs/dnsSyncJob', () => ({
  scheduleDnsEventSync: mocks.scheduleSync, schedulePolicySync: mocks.schedulePolicy,
}));

import { psaRoutes } from './psa';
import { dnsSecurityRoutes } from './dnsSecurity';

const ORG = '11111111-1111-4111-8111-111111111111';
const PARTNER = '22222222-2222-4222-8222-222222222222';
const CONNECTION = '33333333-3333-4333-8333-333333333333';
const SITE = '44444444-4444-4444-8444-444444444444';
const credentials = { baseUrl: 'https://example.atlassian.net', email: 'admin@example.com', apiToken: 'synthetic-token' };
const operations = [
  { name: 'PSA create', method: 'POST', path: '/psa/connections', body: { orgId: ORG, provider: 'jira', name: 'PSA', credentials }, status: 201 },
  { name: 'PSA update', method: 'PATCH', path: `/psa/connections/${CONNECTION}`, body: { name: 'Updated PSA' }, status: 200 },
  { name: 'PSA delete', method: 'DELETE', path: `/psa/connections/${CONNECTION}`, status: 200 },
  { name: 'PSA test', method: 'POST', path: `/psa/connections/${CONNECTION}/test`, status: 200 },
  { name: 'PSA status', method: 'POST', path: `/psa/connections/${CONNECTION}/status`, body: { status: 'paused' }, status: 200 },
  { name: 'DNS create', method: 'POST', path: '/dns-security/integrations', body: { orgId: ORG, provider: 'cloudflare', name: 'DNS', apiKey: 'synthetic-key', config: { accountId: 'synthetic-account' } }, status: 201 },
  { name: 'DNS delete', method: 'DELETE', path: `/dns-security/integrations/${CONNECTION}`, status: 200 },
];
type Operation = typeof operations[number];

function chain(rows: unknown[]) {
  const result = Object.assign(Promise.resolve(rows), {} as Record<string, unknown>);
  for (const method of ['from', 'where', 'limit', 'returning', 'values', 'set', 'innerJoin', 'leftJoin', 'orderBy', 'offset']) {
    result[method] = vi.fn(() => result);
  }
  return result;
}

function setAuth(scope = 'organization', partnerOrgAccess: 'all' | 'selected' | 'none' = 'all') {
  mocks.auth = {
    scope, orgId: scope === 'organization' ? ORG : null, partnerId: PARTNER,
    partnerOrgAccess: scope === 'partner' ? partnerOrgAccess : null,
    accessibleOrgIds: scope === 'system' ? null : [ORG],
    user: { id: '55555555-5555-4555-8555-555555555555', email: 'operator@example.com' },
    canAccessOrg: (orgId: string) => scope === 'system' || orgId === ORG,
    orgCondition: (column: PgColumn) => scope === 'system' ? undefined
      : scope === 'organization' ? eq(column, ORG) : inArray(column, [ORG]),
  };
}

function setRow(partnerOwned = false) {
  const row = {
    id: CONNECTION, orgId: partnerOwned ? null : ORG, partnerId: partnerOwned ? PARTNER : null,
    provider: 'jira', name: 'PSA', credentials: `enc:${JSON.stringify(credentials)}`,
    settings: {}, syncSettings: {}, createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01'), lastSyncAt: null,
  };
  mocks.select.mockImplementation(() => chain([row]));
  mocks.insert.mockImplementation(() => chain([row]));
  mocks.update.mockImplementation(() => chain([row]));
  mocks.delete.mockImplementation(() => chain([]));
}

describe('organization-wide integration connection authority', () => {
  let app: Hono;

  beforeEach(() => {
    vi.resetAllMocks();
    mocks.permissionDenied = false;
    mocks.mfaDenied = false;
    setAuth();
    setRow();
    mocks.transaction.mockImplementation((fn: (tx: typeof mocks) => unknown) => fn(mocks));
    mocks.context.mockImplementation((_auth: unknown, fn: () => unknown) => fn());
    mocks.encrypt.mockImplementation((value: string) => value == null ? null : `enc:${value}`);
    mocks.decrypt.mockImplementation((value: string) => value.replace(/^enc:/, ''));
    mocks.provider.mockReturnValue({ testConnection: mocks.testConnection });
    mocks.testConnection.mockResolvedValue({ success: true });
    app = new Hono();
    app.route('/psa', psaRoutes);
    app.route('/dns-security', dnsSecurityRoutes);
  });

  function request(operation: Operation, body = operation.body === undefined ? undefined : JSON.stringify(operation.body)) {
    return app.request(operation.path, {
      method: operation.method, headers: { 'Content-Type': 'application/json' }, body,
    });
  }

  function expectNoEffects() {
    for (const mock of [mocks.select, mocks.insert, mocks.update, mocks.delete, mocks.transaction,
      mocks.context, mocks.encrypt, mocks.decrypt, mocks.provider, mocks.testConnection,
      mocks.scheduleSync, mocks.schedulePolicy, mocks.audit]) {
      expect(mock).not.toHaveBeenCalled();
    }
  }

  describe.each([{ name: 'selected', sites: [SITE] }, { name: 'empty', sites: [] }])('$name site ceiling', ({ sites }) => {
    it.each(operations)('denies $name before resource access or side effects', async (operation) => {
      mocks.auth.allowedSiteIds = sites;
      expect((await request(operation)).status).toBe(403);
      expectNoEffects();
    });

    it.each(operations)('denies malformed $name before JSON parsing', async (operation) => {
      mocks.auth.allowedSiteIds = sites;
      const parse = vi.spyOn(Request.prototype, 'json');
      try {
        expect((await request(operation, '{')).status).toBe(403);
        expect(parse).not.toHaveBeenCalled();
        expectNoEffects();
      } finally { parse.mockRestore(); }
    });

    it('retains the inert PSA sync response without effects', async () => {
      mocks.auth.allowedSiteIds = sites;
      const response = await app.request(`/psa/connections/${CONNECTION}/sync`, { method: 'POST' });
      expect(response.status).toBe(501);
      expectNoEffects();
    });
  });

  describe.each([
    { name: 'unrestricted organization', scope: 'organization', access: 'all' as const },
    { name: 'selected partner for an accessible org', scope: 'partner', access: 'selected' as const },
    { name: 'full partner', scope: 'partner', access: 'all' as const },
    { name: 'system', scope: 'system', access: 'all' as const },
  ])('$name', ({ scope, access }) => {
    it.each(operations)('retains $name for an org-owned connection', async (operation) => {
      setAuth(scope, access);
      const response = await request(operation);
      expect(response.status, await response.clone().text()).toBe(operation.status);
      expect(mocks.audit).toHaveBeenCalledOnce();
      if (operation.name === 'PSA test') expect(mocks.testConnection).toHaveBeenCalledOnce();
      if (operation.name === 'DNS create') expect(mocks.scheduleSync).toHaveBeenCalledOnce();
    });
  });

  describe.each(['partner', 'system'])('%s partner-owned PSA compatibility', (scope) => {
    it.each(operations.slice(0, 5))('retains $name with full authority', async (operation) => {
      setAuth(scope);
      setRow(true);
      const body = operation.name === 'PSA create'
        ? JSON.stringify({ ...operation.body, ownerScope: 'partner' }) : undefined;
      const response = await request(operation, body);
      expect(response.status, await response.clone().text()).toBe(operation.status);
    });
  });

  describe.each(['selected', 'none'] as const)('%s partner access', (access) => {
    it.each(operations.slice(0, 5))('still denies partner-owned $name', async (operation) => {
      setAuth('partner', access);
      setRow(true);
      const body = operation.name === 'PSA create'
        ? JSON.stringify({ ...operation.body, ownerScope: 'partner' }) : undefined;
      expect((await request(operation, body)).status).toBe(403);
      for (const mock of [mocks.insert, mocks.update, mocks.delete, mocks.encrypt, mocks.decrypt, mocks.provider, mocks.audit]) {
        expect(mock).not.toHaveBeenCalled();
      }
    });
  });

  describe.each(['permission', 'MFA'])('%s prerequisite', (gate) => {
    it.each(operations)('remains required for unrestricted $name', async (operation) => {
      mocks.permissionDenied = gate === 'permission';
      mocks.mfaDenied = gate === 'MFA';
      expect((await request(operation)).status).toBe(403);
      expectNoEffects();
    });
  });

  it('retains the existing cross-org resource predicate on DNS deletion', async () => {
    mocks.auth.orgCondition = () => sql`false`;
    mocks.select.mockImplementation(() => chain([]));
    expect((await request(operations[6]!)).status).toBe(404);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
