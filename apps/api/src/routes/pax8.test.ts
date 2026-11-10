import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const ORG_A = '22222222-2222-2222-2222-222222222222';
const ORG_B = '55555555-5555-5555-5555-555555555555';

const { permissionGate, authState, orgConditionSpy, txState } = vi.hoisted(() => {
  const authState = {
    canAccessOrg: true,
    partnerId: '11111111-1111-1111-1111-111111111111' as string | null,
    scope: 'partner' as 'partner' | 'organization' | 'system',
    partnerOrgAccess: 'all' as 'all' | 'selected' | 'none' | null,
    // null = system scope (no filter); string[] = partner/org scope accessible orgs
    accessibleOrgIds: ['22222222-2222-2222-2222-222222222222'] as string[] | null,
    // Orgs canAccessOrg refuses even when canAccessOrg is true.
    deniedOrgIds: [] as string[],
  };
  // Single hoisted spy so tests can assert the org-filter branch actually fired
  // (called with the snapshot orgId column) and what it produced (a filter for
  // partner scope, undefined for system) — not just that `.where()` was called.
  const orgConditionSpy = vi.fn((col: any) => {
    const ids = authState.accessibleOrgIds;
    if (ids === null) return undefined;
    if (ids.length === 0) return `${col} = '00000000-0000-0000-0000-000000000000'`;
    return `${col} IN (${ids.join(',')})`;
  });
  // `active` is true only while a withDbTransaction callback runs, so a test can
  // prove a write happened inside the transaction that later threw.
  const txState = { active: false, rolledBack: 0 };
  return { permissionGate: { deny: false, mfaDeny: false }, authState, orgConditionSpy, txState };
});

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
  withDbTransaction: vi.fn(async (fn: () => Promise<unknown>) => {
    txState.active = true;
    try {
      return await fn();
    } catch (err) {
      txState.rolledBack += 1;
      throw err;
    } finally {
      txState.active = false;
    }
  }),
}));

vi.mock('../db/schema', () => ({
  organizations: {
    id: 'organizations.id',
    name: 'organizations.name',
    partnerId: 'organizations.partner_id',
    type: 'organizations.type',
  },
  contractLines: {
    id: 'contract_lines.id',
    orgId: 'contract_lines.org_id',
    lineType: 'contract_lines.line_type',
    manualQuantity: 'contract_lines.manual_quantity',
  },
  pax8Integrations: {
    id: 'pax8_integrations.id',
    partnerId: 'pax8_integrations.partner_id',
    name: 'pax8_integrations.name',
    clientIdEncrypted: 'pax8_integrations.client_id_encrypted',
    clientSecretEncrypted: 'pax8_integrations.client_secret_encrypted',
    webhookSecretEncrypted: 'pax8_integrations.webhook_secret_encrypted',
    apiBaseUrl: 'pax8_integrations.api_base_url',
    tokenUrl: 'pax8_integrations.token_url',
    isActive: 'pax8_integrations.is_active',
    lastSyncAt: 'pax8_integrations.last_sync_at',
    lastSyncStatus: 'pax8_integrations.last_sync_status',
    lastSyncError: 'pax8_integrations.last_sync_error',
    createdAt: 'pax8_integrations.created_at',
    updatedAt: 'pax8_integrations.updated_at',
    createdBy: 'pax8_integrations.created_by',
  },
  pax8CompanyMappings: {
    pax8CompanyId: 'pax8_company_mappings.pax8_company_id',
    pax8CompanyName: 'pax8_company_mappings.pax8_company_name',
    status: 'pax8_company_mappings.status',
    orgId: 'pax8_company_mappings.org_id',
    ignored: 'pax8_company_mappings.ignored',
    lastSeenAt: 'pax8_company_mappings.last_seen_at',
    updatedAt: 'pax8_company_mappings.updated_at',
    createdAt: 'pax8_company_mappings.created_at',
    metadata: 'pax8_company_mappings.metadata',
    integrationId: 'pax8_company_mappings.integration_id',
    partnerId: 'pax8_company_mappings.partner_id',
  },
  pax8SubscriptionSnapshots: {
    id: 'pax8_subscription_snapshots.id',
    integrationId: 'pax8_subscription_snapshots.integration_id',
    pax8SubscriptionId: 'pax8_subscription_snapshots.pax8_subscription_id',
    pax8CompanyId: 'pax8_subscription_snapshots.pax8_company_id',
    orgId: 'pax8_subscription_snapshots.org_id',
    productId: 'pax8_subscription_snapshots.product_id',
    productName: 'pax8_subscription_snapshots.product_name',
    vendorName: 'pax8_subscription_snapshots.vendor_name',
    vendorSkuId: 'pax8_subscription_snapshots.vendor_sku_id',
    status: 'pax8_subscription_snapshots.status',
    billingTerm: 'pax8_subscription_snapshots.billing_term',
    quantity: 'pax8_subscription_snapshots.quantity',
    quantityKnown: 'pax8_subscription_snapshots.quantity_known',
    unitPrice: 'pax8_subscription_snapshots.unit_price',
    unitCost: 'pax8_subscription_snapshots.unit_cost',
    currencyCode: 'pax8_subscription_snapshots.currency_code',
    lastSeenAt: 'pax8_subscription_snapshots.last_seen_at',
    raw: 'pax8_subscription_snapshots.raw',
  },
  pax8ContractLineLinks: {
    id: 'pax8_contract_line_links.id',
    integrationId: 'pax8_contract_line_links.integration_id',
    orgId: 'pax8_contract_line_links.org_id',
    subscriptionSnapshotId: 'pax8_contract_line_links.subscription_snapshot_id',
    contractLineId: 'pax8_contract_line_links.contract_line_id',
    syncEnabled: 'pax8_contract_line_links.sync_enabled',
    lastObservedQuantity: 'pax8_contract_line_links.last_applied_quantity',
    lastObservedAt: 'pax8_contract_line_links.last_applied_at',
  },
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    const ids = authState.accessibleOrgIds;
    c.set('auth', {
      scope: authState.scope,
      partnerId: authState.partnerId,
      partnerOrgAccess: authState.partnerOrgAccess,
      orgId: authState.scope === 'organization' ? ORG_A : null,
      accessibleOrgIds: ids,
      canAccessOrg: vi.fn((orgId: string) => authState.canAccessOrg && !authState.deniedOrgIds.includes(orgId)),
      // Hoisted spy (impl mirrors middleware/auth.ts orgCondition) so tests can
      // assert the org-filter branch fired and what it produced.
      orgCondition: orgConditionSpy,
      user: { id: '33333333-3333-3333-3333-333333333333', email: 'admin@example.com' },
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (c: any, next: any) => {
    if (permissionGate.deny) return c.json({ error: 'Forbidden' }, 403);
    return next();
  }),
  requireMfa: vi.fn(() => async (c: any, next: any) => {
    if (permissionGate.mfaDeny) return c.json({ error: 'MFA required' }, 403);
    return next();
  }),
}));

vi.mock('../services/permissions', () => ({
  PERMISSIONS: {
    BILLING_MANAGE: { resource: 'billing', action: 'manage' },
  },
}));

vi.mock('../services/secretCrypto', () => ({
  encryptSecret: vi.fn((value: string | undefined) => `enc:${value}`),
}));

vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: vi.fn(),
}));

vi.mock('../jobs/pax8SyncWorker', () => ({
  enqueuePax8Sync: vi.fn(async () => 'job-1'),
}));

vi.mock('../services/pax8SyncService', () => ({
  createPax8ClientForIntegration: vi.fn(),
  linkPax8SubscriptionToContractLine: vi.fn(),
  mapPax8Company: vi.fn(async () => ({ pax8CompanyId: 'company-1', orgId: null, ignored: false })),
  Pax8MapRefusedError: class Pax8MapRefusedError extends Error {},
  unlinkPax8Subscription: vi.fn(),
}));

vi.mock('../services/mappableOrgs', () => ({
  loadMappableOrgs: vi.fn(async () => []),
}));

import { db } from '../db';
import { loadMappableOrgs } from '../services/mappableOrgs';
import { pax8Routes } from './pax8';
import { encryptSecret } from '../services/secretCrypto';
import { writeRouteAudit } from '../services/auditEvents';
import { enqueuePax8Sync } from '../jobs/pax8SyncWorker';
import {
  createPax8ClientForIntegration,
  linkPax8SubscriptionToContractLine,
  mapPax8Company,
  Pax8MapRefusedError,
  unlinkPax8Subscription,
} from '../services/pax8SyncService';
import { PgDialect } from 'drizzle-orm/pg-core';

const INTEGRATION_ID = '44444444-4444-4444-4444-444444444444';
const SNAPSHOT_ID = '66666666-6666-6666-6666-666666666666';
const CONTRACT_LINE_ID = '77777777-7777-7777-7777-777777777777';

function partnerGlobalRequests() {
  return [
    { name: 'GET /integration', path: '/pax8/integration', method: 'GET', body: undefined, fullPartnerStatus: 200 },
    {
      name: 'POST /integration', path: '/pax8/integration', method: 'POST',
      body: { name: 'Pax8' }, fullPartnerStatus: 400,
    },
    { name: 'POST /integration/test', path: '/pax8/integration/test', method: 'POST', body: {}, fullPartnerStatus: 404 },
    { name: 'POST /sync', path: '/pax8/sync', method: 'POST', body: {}, fullPartnerStatus: 404 },
    { name: 'GET /companies', path: '/pax8/companies', method: 'GET', body: undefined, fullPartnerStatus: 200 },
    {
      name: 'POST /companies/map', path: '/pax8/companies/map', method: 'POST',
      body: { integrationId: INTEGRATION_ID, pax8CompanyId: 'company-1', orgId: null }, fullPartnerStatus: 404,
    },
    {
      name: 'POST /companies/map-bulk', path: '/pax8/companies/map-bulk', method: 'POST',
      body: { integrationId: INTEGRATION_ID, items: [{ pax8CompanyId: 'company-1', orgId: ORG_A, expectedOrgId: null }] },
      fullPartnerStatus: 404,
    },
    { name: 'GET /subscriptions', path: '/pax8/subscriptions', method: 'GET', body: undefined, fullPartnerStatus: 200 },
    {
      name: 'POST /subscriptions/link', path: '/pax8/subscriptions/link', method: 'POST',
      body: { integrationId: INTEGRATION_ID, subscriptionSnapshotId: SNAPSHOT_ID, contractLineId: CONTRACT_LINE_ID }, fullPartnerStatus: 404,
    },
    {
      name: 'DELETE /subscriptions/link', path: '/pax8/subscriptions/link', method: 'DELETE',
      body: { integrationId: INTEGRATION_ID, subscriptionSnapshotId: SNAPSHOT_ID }, fullPartnerStatus: 404,
    },
  ] as const;
}

function mockSelectOnce(rows: unknown[]) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn(async () => rows),
      })),
    })),
  } as any);
}

/**
 * Mock for the subscription snapshots query chain which uses
 * .from().leftJoin().leftJoin().where().orderBy().limit()
 * Returns a spy on `where` so tests can assert on the conditions passed in.
 */
function mockSubscriptionSelectOnce(integrationRows: unknown[], snapshotRows: unknown[]) {
  let whereConditions: unknown;
  const whereSpy = vi.fn((cond: unknown) => {
    whereConditions = cond;
    return {
      orderBy: vi.fn(() => ({
        limit: vi.fn(async () => snapshotRows),
      })),
    };
  });

  // First call: findActiveIntegration (simple from/where/limit chain)
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn(async () => integrationRows),
      })),
    })),
  } as any);

  // Second call: the snapshot join query (three left joins, then filtering).
  const leftJoinMock = vi.fn().mockReturnThis();
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn(() => ({
      leftJoin: leftJoinMock.mockImplementation(() => ({
        leftJoin: vi.fn(() => ({
          leftJoin: vi.fn(() => ({
            where: whereSpy,
          })),
        })),
      })),
    })),
  } as any);

  return { whereSpy, getConditions: () => whereConditions };
}

function mockCompanySelectOnce(integrationRows: unknown[], companyRows: unknown[]) {
  mockSelectOnce(integrationRows);
  const chain: Record<string, any> = {};
  chain.from = vi.fn(() => chain);
  chain.leftJoin = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.orderBy = vi.fn(async () => companyRows);
  vi.mocked(db.select).mockReturnValueOnce(chain as any);
}

describe('pax8 routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks does NOT drain mockReturnValueOnce queues — reset db.select so a
    // leftover snapshot-select mock from an early-returning test (e.g. the 403
    // canAccessOrg path) cannot bleed into the next test's findActiveIntegration call.
    vi.mocked(db.select).mockReset();
    permissionGate.deny = false;
    permissionGate.mfaDeny = false;
    txState.active = false;
    txState.rolledBack = 0;
    authState.canAccessOrg = true;
    authState.deniedOrgIds = [];
    authState.partnerId = '11111111-1111-1111-1111-111111111111';
    authState.scope = 'partner';
    authState.partnerOrgAccess = 'all';
    authState.accessibleOrgIds = [ORG_A];
    app = new Hono();
    app.route('/pax8', pax8Routes);
  });

  describe.each(['selected', 'none'] as const)('with partner org access %s', (orgAccess) => {
    it.each(partnerGlobalRequests())('rejects $name before database and external side effects', async ({ path, method, body }) => {
      authState.partnerOrgAccess = orgAccess;

      const res = await app.request(path, {
        method,
        ...(body ? {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        } : {}),
      });

      expect(res.status).toBe(403);
      expect(db.select).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
      expect(db.update).not.toHaveBeenCalled();
      expect(encryptSecret).not.toHaveBeenCalled();
      expect(enqueuePax8Sync).not.toHaveBeenCalled();
      expect(createPax8ClientForIntegration).not.toHaveBeenCalled();
      expect(mapPax8Company).not.toHaveBeenCalled();
      expect(linkPax8SubscriptionToContractLine).not.toHaveBeenCalled();
      expect(unlinkPax8Subscription).not.toHaveBeenCalled();
      expect(writeRouteAudit).not.toHaveBeenCalled();
    });
  });

  it.each(partnerGlobalRequests())('allows full-partner access through the capability gate for $name', async ({ path, method, body, fullPartnerStatus }) => {
    authState.partnerOrgAccess = 'all';
    mockSelectOnce([]);

    const res = await app.request(path, {
      method,
      ...(body ? {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      } : {}),
    });

    expect(res.status).toBe(fullPartnerStatus);
    expect(db.select).toHaveBeenCalledOnce();
  });

  it.each([
    { partnerOrgAccess: 'all' as const, expectedStatus: 200 },
    { partnerOrgAccess: 'selected' as const, expectedStatus: 403 },
    { partnerOrgAccess: 'none' as const, expectedStatus: 403 },
  ])('applies the full-partner access matrix for shared integration reads: $partnerOrgAccess', async ({ partnerOrgAccess, expectedStatus }) => {
    authState.partnerOrgAccess = partnerOrgAccess;
    mockSelectOnce([]);

    const res = await app.request('/pax8/integration');

    expect(res.status).toBe(expectedStatus);
    expect(db.select).toHaveBeenCalledTimes(partnerOrgAccess === 'all' ? 1 : 0);
  });

  it('rejects integration upsert when billing permission is denied', async () => {
    permissionGate.deny = true;

    const res = await app.request('/pax8/integration', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Pax8' }),
    });

    expect(res.status).toBe(403);
  });

  it('GET /companies returns bounded ordering readiness without contact PII or metadata', async () => {
    const integration = { id: '44444444-4444-4444-4444-444444444444', partnerId: authState.partnerId };
    mockCompanySelectOnce([integration], [{
      pax8CompanyId: 'company-1', pax8CompanyName: 'Acme', status: 'Active', mappedOrgId: ORG_A,
      mappedOrgName: 'Acme', ignored: false, lastSeenAt: null, updatedAt: null,
      metadata: {
        contacts: [{ email: 'private@example.com', types: [
          { type: 'Admin', primary: true }, { type: 'Billing', primary: true }, { type: 'Technical', primary: true },
        ] }],
      },
    }]);

    const res = await app.request('/pax8/companies');

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data[0]).toMatchObject({
      statusActive: true, primaryAdminReady: true, primaryBillingReady: true,
      primaryTechnicalReady: true, orderReady: true,
    });
    expect(body.data[0]).not.toHaveProperty('metadata');
    expect(JSON.stringify(body)).not.toContain('private@example.com');
  });

  it('requires credentials when creating a Pax8 integration', async () => {
    mockSelectOnce([]);

    const res = await app.request('/pax8/integration', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Pax8' }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining('clientId and clientSecret'),
    });
  });

  it('does not carry stored client credentials to a changed Pax8 origin', async () => {
    const existing = {
      id: INTEGRATION_ID,
      partnerId: authState.partnerId,
      name: 'Pax8',
      clientIdEncrypted: 'enc:stored-client',
      clientSecretEncrypted: 'enc:stored-secret',
      accessTokenEncrypted: 'enc:old-origin-access-token',
      accessTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      webhookSecretEncrypted: null,
      apiBaseUrl: 'https://api.pax8.com',
      tokenUrl: 'https://login.pax8.com/oauth/token',
      isActive: true,
    };
    mockSelectOnce([existing]);

    const res = await app.request('/pax8/integration', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Pax8',
        apiBaseUrl: existing.apiBaseUrl,
        tokenUrl: 'https://attacker.example/oauth/token',
      }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringMatching(/clientId.*clientSecret|credentials.*re-entered/i),
    });
    expect(db.update).not.toHaveBeenCalled();
    expect(enqueuePax8Sync).not.toHaveBeenCalled();
  });

  it('allows a changed Pax8 origin only with replacement client credentials', async () => {
    const existing = {
      id: INTEGRATION_ID,
      partnerId: authState.partnerId,
      name: 'Pax8',
      clientIdEncrypted: 'enc:stored-client',
      clientSecretEncrypted: 'enc:stored-secret',
      accessTokenEncrypted: 'enc:old-origin-access-token',
      accessTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      webhookSecretEncrypted: null,
      apiBaseUrl: 'https://api.pax8.com',
      tokenUrl: 'https://login.pax8.com/oauth/token',
      isActive: true,
    };
    mockSelectOnce([existing]);
    const setSpy = vi.fn((values: Record<string, unknown>) => ({
      where: vi.fn(() => ({ returning: vi.fn(async () => [{ ...existing, ...values }]) })),
    }));
    vi.mocked(db.update).mockReturnValueOnce({ set: setSpy } as any);

    const res = await app.request('/pax8/integration', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Pax8',
        tokenUrl: 'https://replacement.example/oauth/token',
        clientId: 'replacement-client',
        clientSecret: 'replacement-secret',
      }),
    });

    expect(res.status).toBe(200);
    expect(setSpy).toHaveBeenCalledWith(expect.objectContaining({
      apiBaseUrl: existing.apiBaseUrl,
      tokenUrl: 'https://replacement.example/oauth/token',
      clientIdEncrypted: 'enc:replacement-client',
      clientSecretEncrypted: 'enc:replacement-secret',
      accessTokenEncrypted: null,
      accessTokenExpiresAt: null,
    }));
  });

  it('clears the cached access token when client credentials rotate on the same origins', async () => {
    const existing = {
      id: INTEGRATION_ID,
      partnerId: authState.partnerId,
      name: 'Pax8',
      clientIdEncrypted: 'enc:stored-client',
      clientSecretEncrypted: 'enc:stored-secret',
      accessTokenEncrypted: 'enc:cached-token',
      accessTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      webhookSecretEncrypted: null,
      apiBaseUrl: 'https://api.pax8.com',
      tokenUrl: 'https://login.pax8.com/oauth/token',
      isActive: true,
    };
    mockSelectOnce([existing]);
    const setSpy = vi.fn((values: Record<string, unknown>) => ({
      where: vi.fn(() => ({ returning: vi.fn(async () => [{ ...existing, ...values }]) })),
    }));
    vi.mocked(db.update).mockReturnValueOnce({ set: setSpy } as any);

    const res = await app.request('/pax8/integration', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Pax8',
        clientId: 'replacement-client',
        clientSecret: 'replacement-secret',
      }),
    });

    expect(res.status).toBe(200);
    expect(setSpy).toHaveBeenCalledWith(expect.objectContaining({
      accessTokenEncrypted: null,
      accessTokenExpiresAt: null,
    }));
  });

  it('rejects company mapping to an inaccessible organization', async () => {
    authState.canAccessOrg = false;
    mockSelectOnce([{
      id: '44444444-4444-4444-4444-444444444444',
      partnerId: authState.partnerId,
      name: 'Pax8',
    }]);

    const res = await app.request('/pax8/companies/map', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        integrationId: '44444444-4444-4444-4444-444444444444',
        pax8CompanyId: 'company-1',
        orgId: '55555555-5555-5555-5555-555555555555',
      }),
    });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      error: 'Access to target organization denied',
    });
  });

  it('maps an unmap (orgId null) request without an org access check', async () => {
    mockSelectOnce([{
      id: '44444444-4444-4444-4444-444444444444',
      partnerId: authState.partnerId,
      name: 'Pax8',
    }]);
    mockSelectOnce([{ orgId: ORG_A }]);

    const res = await app.request('/pax8/companies/map', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        integrationId: '44444444-4444-4444-4444-444444444444',
        pax8CompanyId: 'company-1',
        orgId: null,
      }),
    });

    expect(res.status).toBe(200);
  });

  describe('company suggestions', () => {
    const integration = { id: INTEGRATION_ID, partnerId: '11111111-1111-1111-1111-111111111111' };
    const recent = new Date();
    const companyRow = (over: Record<string, unknown>) => ({
      pax8CompanyId: 'company-1', pax8CompanyName: 'Acme Inc', status: 'Active', mappedOrgId: null,
      mappedOrgName: null, ignored: false, lastSeenAt: null, updatedAt: null, createdAt: recent, metadata: {}, ...over,
    });
    function mockCompaniesSelect(rows: unknown[]) {
      mockCompanySelectOnce([integration], rows);
    }
    function mockMapLookups(previousOrgId: string | null, companyRows?: unknown[]) {
      mockSelectOnce([integration]);
      mockSelectOnce([{ orgId: previousOrgId }]);
      if (companyRows) {
        vi.mocked(db.select).mockReturnValueOnce({
          from: vi.fn(() => ({ where: vi.fn(async () => companyRows) })),
        } as any);
      }
    }
    const postMap = (extra: Record<string, unknown>) => app.request('/pax8/companies/map', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ integrationId: INTEGRATION_ID, pax8CompanyId: 'company-1', ...extra }),
    });

    it('GET /companies returns suggestion and summary', async () => {
      vi.mocked(loadMappableOrgs).mockResolvedValueOnce([{ id: ORG_B, name: 'Acme, Inc.' }]);
      mockCompaniesSelect([companyRow({})]);

      const res = await app.request('/pax8/companies');

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(loadMappableOrgs).toHaveBeenCalledWith(db, authState.partnerId);
      expect(body.data[0].suggestion).toMatchObject({ status: 'match', orgId: ORG_B, orgName: 'Acme, Inc.' });
      expect(body.data[0].firstSeenAt).toBe(recent.toISOString());
      expect(body.summary).toEqual({ unmapped: 1, suggested: 1, newUnmapped: 1 });
    });

    it('hidden, archived, merging, quick_support and holding orgs are never candidates', async () => {
      // loadMappableOrgs owns that predicate; an org it does not return can never be suggested.
      vi.mocked(loadMappableOrgs).mockResolvedValueOnce([{ id: ORG_B, name: 'Other Co' }]);
      mockCompaniesSelect([companyRow({ pax8CompanyName: 'Quick Support' })]);

      const res = await app.request('/pax8/companies');

      const body = await res.json() as any;
      expect(loadMappableOrgs).toHaveBeenCalledTimes(1);
      expect(loadMappableOrgs).toHaveBeenCalledWith(db, authState.partnerId);
      expect(body.data[0].suggestion).toBeNull();
      expect(body.summary.suggested).toBe(0);
    });

    it('map with source=suggestion that no longer matches is audited as manual', async () => {
      vi.mocked(loadMappableOrgs).mockResolvedValueOnce([{ id: ORG_B, name: 'Renamed Co' }]);
      mockMapLookups(null, [{ pax8CompanyId: 'company-1', pax8CompanyName: 'Acme Inc', mappedOrgId: null, ignored: false, createdAt: recent }]);

      const res = await postMap({ orgId: ORG_B, source: 'suggestion' });

      expect(res.status).toBe(200);
      expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        details: expect.objectContaining({ source: 'manual', matchTier: null, matchKey: null }),
      }));
    });

    it('map with a still-matching suggestion records source, tier and key', async () => {
      vi.mocked(loadMappableOrgs).mockResolvedValueOnce([{ id: ORG_B, name: 'Acme Inc' }]);
      mockMapLookups(null, [{ pax8CompanyId: 'company-1', pax8CompanyName: 'Acme Inc', mappedOrgId: null, ignored: false, createdAt: recent }]);

      const res = await postMap({ orgId: ORG_B, source: 'suggestion' });

      expect(res.status).toBe(200);
      expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        details: expect.objectContaining({ source: 'suggestion', matchTier: 'exact', matchKey: expect.any(String) }),
      }));
    });

    it('map audit carries previousOrgId', async () => {
      mockMapLookups(ORG_A);

      const res = await postMap({ orgId: null });

      expect(res.status).toBe(200);
      expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        orgId: ORG_A,
        action: 'pax8.company.unmap',
        details: expect.objectContaining({ previousOrgId: ORG_A, source: 'manual', matchTier: null, matchKey: null }),
      }));
    });

    it('rename-capture: renaming an org to match an unmapped company writes nothing until a map request', async () => {
      const rows = [companyRow({ pax8CompanyName: 'Globex' })];
      vi.mocked(loadMappableOrgs).mockResolvedValueOnce([{ id: ORG_B, name: 'Initech' }]);
      mockCompaniesSelect(rows);
      const before = await (await app.request('/pax8/companies')).json() as any;
      expect(before.data[0].suggestion).toBeNull();

      vi.mocked(loadMappableOrgs).mockResolvedValueOnce([{ id: ORG_B, name: 'Globex' }]);
      mockCompaniesSelect(rows);
      const after = await (await app.request('/pax8/companies')).json() as any;

      expect(after.data[0].suggestion).toMatchObject({ status: 'match', orgId: ORG_B });
      expect(db.update).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
      expect(mapPax8Company).not.toHaveBeenCalled();
    });
  });

  describe('single map transaction', () => {
    const integration = { id: INTEGRATION_ID, partnerId: '11111111-1111-1111-1111-111111111111', name: 'Pax8' };
    const postMap = () => app.request('/pax8/companies/map', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ integrationId: INTEGRATION_ID, pax8CompanyId: 'company-1', orgId: ORG_A }),
    });

    it('runs its lookup and write inside one withDbTransaction', async () => {
      const inTx: boolean[] = [];
      vi.mocked(mapPax8Company).mockImplementationOnce(async () => {
        inTx.push(txState.active);
        return { pax8CompanyId: 'company-1', orgId: ORG_A, ignored: false };
      });
      mockSelectOnce([integration]);
      mockSelectOnce([{ orgId: null }]);

      const res = await postMap();

      expect(res.status).toBe(200);
      expect(inTx).toEqual([true]);
      expect(writeRouteAudit).toHaveBeenCalledTimes(1);
    });

    it('a refused map returns 400 from a catch outside the transaction and is not audited', async () => {
      vi.mocked(mapPax8Company).mockRejectedValueOnce(new Pax8MapRefusedError('Target organization does not belong to this partner'));
      mockSelectOnce([integration]);
      mockSelectOnce([{ orgId: null }]);

      const res = await postMap();

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({ error: 'Target organization does not belong to this partner' });
      expect(txState.rolledBack).toBe(1);
      expect(writeRouteAudit).not.toHaveBeenCalled();
    });

    it('an unexpected failure is a 500, not a 400 carrying the driver message', async () => {
      vi.mocked(mapPax8Company).mockRejectedValueOnce(new Error('relation "pax8_company_mappings" does not exist'));
      mockSelectOnce([integration]);
      mockSelectOnce([{ orgId: null }]);

      const res = await postMap();

      expect(res.status).toBe(500);
      expect(await res.text()).not.toContain('pax8_company_mappings');
      expect(txState.rolledBack).toBe(1);
      expect(writeRouteAudit).not.toHaveBeenCalled();
    });
  });

  describe('POST /companies/map-bulk', () => {
    const PARTNER = '11111111-1111-1111-1111-111111111111';
    const ORG_C = '88888888-8888-4888-8888-888888888888';
    const integration = { id: INTEGRATION_ID, partnerId: PARTNER, name: 'Pax8' };
    const created = new Date('2026-11-01T00:00:00.000Z');
    const companies = [
      { pax8CompanyId: 'co-acme', pax8CompanyName: 'Acme Inc', mappedOrgId: null, ignored: false, createdAt: created },
      { pax8CompanyId: 'co-beta', pax8CompanyName: 'Beta LLC', mappedOrgId: null, ignored: false, createdAt: created },
    ];
    const mappable = [{ id: ORG_A, name: 'Acme Inc' }, { id: ORG_B, name: 'Beta' }];
    const items = [
      { pax8CompanyId: 'co-acme', orgId: ORG_A, expectedOrgId: null },
      { pax8CompanyId: 'co-beta', orgId: ORG_B, expectedOrgId: null },
    ];
    let callsInTx: boolean[];

    /** Any select chain shape; awaiting it (at any link) resolves `rows`. */
    function mockQueryOnce(rows: unknown[]) {
      const chain: Record<string, any> = {};
      for (const method of ['from', 'leftJoin', 'where', 'orderBy', 'limit', 'for']) chain[method] = vi.fn(() => chain);
      chain.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve(rows).then(resolve, reject);
      vi.mocked(db.select).mockReturnValueOnce(chain as any);
      return chain;
    }

    function mockBulkLookups(opts: {
      locked?: Array<{ pax8CompanyId: string; orgId: string | null; ignored: boolean }>;
      targets?: Array<{ id: string; partnerId: string; type: string }>;
      rows?: unknown[];
      orgs?: Array<{ id: string; name: string }>;
    } = {}) {
      mockQueryOnce([integration]);
      const locked = mockQueryOnce(opts.locked ?? companies.map((c) => ({
        pax8CompanyId: c.pax8CompanyId, orgId: c.mappedOrgId, ignored: c.ignored,
      })));
      mockQueryOnce(opts.targets ?? [
        { id: ORG_A, partnerId: PARTNER, type: 'customer' },
        { id: ORG_B, partnerId: PARTNER, type: 'customer' },
      ]);
      mockQueryOnce(opts.rows ?? companies);
      vi.mocked(loadMappableOrgs).mockResolvedValueOnce(opts.orgs ?? mappable);
      return { locked };
    }

    const postBulk = (body: unknown) => app.request('/pax8/companies/map-bulk', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    beforeEach(() => {
      vi.mocked(loadMappableOrgs).mockReset();
      vi.mocked(loadMappableOrgs).mockResolvedValue([]);
      callsInTx = [];
      vi.mocked(mapPax8Company).mockReset();
      vi.mocked(mapPax8Company).mockImplementation(async (input) => {
        callsInTx.push(txState.active);
        return { pax8CompanyId: input.pax8CompanyId, orgId: input.orgId, ignored: false };
      });
    });

    it('maps every item inside one transaction, locks the rows, and audits each with its verified source', async () => {
      const { locked } = mockBulkLookups();

      const res = await postBulk({ integrationId: INTEGRATION_ID, items });

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ data: { mapped: 2 } });
      // The lock is scoped to this integration, this partner and exactly the
      // reviewed companies, and taken in id order.
      const lockWhere = new PgDialect().sqlToQuery(locked.where.mock.calls[0]![0]);
      expect(lockWhere.params).toEqual([
        'pax8_company_mappings.integration_id', INTEGRATION_ID,
        'pax8_company_mappings.partner_id', PARTNER,
        'pax8_company_mappings.pax8_company_id', 'co-acme', 'co-beta',
      ]);
      expect(locked.orderBy).toHaveBeenCalledWith('pax8_company_mappings.pax8_company_id');
      expect(locked.for).toHaveBeenCalledWith('update');
      expect(locked.orderBy.mock.invocationCallOrder[0]!).toBeLessThan(locked.for.mock.invocationCallOrder[0]!);
      expect(mapPax8Company).toHaveBeenCalledTimes(2);
      expect(mapPax8Company).toHaveBeenCalledWith({
        integrationId: INTEGRATION_ID, partnerId: PARTNER, pax8CompanyId: 'co-acme', orgId: ORG_A, ignored: false,
      });
      expect(callsInTx).toEqual([true, true]);
      expect(loadMappableOrgs).toHaveBeenCalledWith(db, PARTNER);
      expect(writeRouteAudit).toHaveBeenCalledTimes(2);
      expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), {
        orgId: ORG_A,
        action: 'pax8.company.map',
        resourceType: 'pax8_company_mapping',
        resourceName: 'co-acme',
        details: {
          integrationId: INTEGRATION_ID, partnerId: PARTNER, ignored: false, previousOrgId: null,
          source: 'bulk_suggestion', matchTier: 'exact', matchKey: 'acme inc',
        },
      });
      expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        orgId: ORG_B,
        resourceName: 'co-beta',
        details: expect.objectContaining({ source: 'bulk_suggestion', matchTier: 'normalized', matchKey: 'beta' }),
      }));
    });

    it('remaps a row that is still on the org the reviewer saw, and audits that previous org', async () => {
      mockBulkLookups({
        locked: [{ pax8CompanyId: 'co-acme', orgId: ORG_C, ignored: false }],
        rows: [{ ...companies[0], mappedOrgId: ORG_C }],
      });

      const res = await postBulk({
        integrationId: INTEGRATION_ID,
        items: [{ pax8CompanyId: 'co-acme', orgId: ORG_A, expectedOrgId: ORG_C }],
      });

      expect(res.status).toBe(200);
      expect(mapPax8Company).toHaveBeenCalledTimes(1);
      expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        orgId: ORG_A,
        details: expect.objectContaining({ previousOrgId: ORG_C, source: 'manual', matchTier: null, matchKey: null }),
      }));
    });

    it('a row mapped to a different org than the reviewer saw → 409 STALE_REVIEW', async () => {
      mockBulkLookups({ locked: [{ pax8CompanyId: 'co-acme', orgId: ORG_B, ignored: false }] });

      const res = await postBulk({
        integrationId: INTEGRATION_ID,
        items: [{ pax8CompanyId: 'co-acme', orgId: ORG_A, expectedOrgId: ORG_C }],
      });

      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toMatchObject({ code: 'STALE_REVIEW', pax8CompanyIds: ['co-acme'] });
      expect(mapPax8Company).not.toHaveBeenCalled();
    });

    it('a batch that is both stale and invalid is refused as stale first', async () => {
      mockBulkLookups({
        locked: [
          { pax8CompanyId: 'co-acme', orgId: ORG_C, ignored: false },
          { pax8CompanyId: 'co-beta', orgId: null, ignored: false },
        ],
        targets: [{ id: ORG_A, partnerId: PARTNER, type: 'unassigned_pool' }],
      });

      const res = await postBulk({ integrationId: INTEGRATION_ID, items });

      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toMatchObject({ code: 'STALE_REVIEW', pax8CompanyIds: ['co-acme'] });
    });

    it('a target refused mid-batch → 400 INVALID_TARGET and the earlier write rolls back', async () => {
      mockBulkLookups();
      vi.mocked(mapPax8Company)
        .mockImplementationOnce(async (input) => {
          callsInTx.push(txState.active);
          return { pax8CompanyId: input.pax8CompanyId, orgId: input.orgId, ignored: false };
        })
        .mockImplementationOnce(async () => {
          callsInTx.push(txState.active);
          throw new Pax8MapRefusedError('The unassigned-device holding area cannot be a mapping target');
        });

      const res = await postBulk({ integrationId: INTEGRATION_ID, items });

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({ code: 'INVALID_TARGET', pax8CompanyIds: ['co-beta'] });
      expect(callsInTx).toEqual([true, true]);
      expect(txState.rolledBack).toBe(1);
      expect(writeRouteAudit).not.toHaveBeenCalled();
    });

    it('one foreign org → 403 and zero mapPax8Company calls', async () => {
      authState.deniedOrgIds = [ORG_B];
      mockQueryOnce([integration]);

      const res = await postBulk({ integrationId: INTEGRATION_ID, items });

      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toEqual({
        error: 'Access to target organization denied', pax8CompanyIds: ['co-beta'],
      });
      expect(db.select).toHaveBeenCalledTimes(1);
      expect(mapPax8Company).not.toHaveBeenCalled();
      expect(writeRouteAudit).not.toHaveBeenCalled();
    });

    it('holding org → 400 INVALID_TARGET, the transaction rolls back and nothing is written', async () => {
      mockBulkLookups({
        targets: [
          { id: ORG_A, partnerId: PARTNER, type: 'customer' },
          { id: ORG_B, partnerId: PARTNER, type: 'unassigned_pool' },
        ],
      });

      const res = await postBulk({ integrationId: INTEGRATION_ID, items });

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({ code: 'INVALID_TARGET', pax8CompanyIds: ['co-beta'] });
      expect(mapPax8Company).not.toHaveBeenCalled();
      expect(txState.rolledBack).toBe(1);
      expect(writeRouteAudit).not.toHaveBeenCalled();
    });

    it('a target outside the partner, or one that does not exist, → 400 INVALID_TARGET listing both', async () => {
      mockBulkLookups({ targets: [{ id: ORG_A, partnerId: '99999999-9999-4999-8999-999999999999', type: 'customer' }] });

      const res = await postBulk({ integrationId: INTEGRATION_ID, items });

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({ code: 'INVALID_TARGET', pax8CompanyIds: ['co-acme', 'co-beta'] });
      expect(mapPax8Company).not.toHaveBeenCalled();
    });

    it('a write that fails mid-batch rolls the whole batch back and is not audited', async () => {
      mockBulkLookups();
      vi.mocked(mapPax8Company)
        .mockImplementationOnce(async (input) => {
          callsInTx.push(txState.active);
          return { pax8CompanyId: input.pax8CompanyId, orgId: input.orgId, ignored: false };
        })
        .mockImplementationOnce(async () => {
          callsInTx.push(txState.active);
          throw new Error('connection reset');
        });

      const res = await postBulk({ integrationId: INTEGRATION_ID, items });

      expect(res.status).toBe(500);
      // The first item's write ran inside the same transaction callback that threw.
      expect(callsInTx).toEqual([true, true]);
      expect(txState.rolledBack).toBe(1);
      expect(writeRouteAudit).not.toHaveBeenCalled();
    });

    it('an item whose row changed since review → 409 STALE_REVIEW listing it, zero writes', async () => {
      mockBulkLookups({
        locked: [
          { pax8CompanyId: 'co-acme', orgId: null, ignored: false },
          { pax8CompanyId: 'co-beta', orgId: ORG_C, ignored: false },
        ],
      });

      const res = await postBulk({ integrationId: INTEGRATION_ID, items });

      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toMatchObject({ code: 'STALE_REVIEW', pax8CompanyIds: ['co-beta'] });
      expect(mapPax8Company).not.toHaveBeenCalled();
      expect(writeRouteAudit).not.toHaveBeenCalled();
    });

    it('an item ignored since review → 409 STALE_REVIEW', async () => {
      mockBulkLookups({
        locked: [
          { pax8CompanyId: 'co-acme', orgId: null, ignored: true },
          { pax8CompanyId: 'co-beta', orgId: null, ignored: false },
        ],
      });

      const res = await postBulk({ integrationId: INTEGRATION_ID, items });

      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toMatchObject({ code: 'STALE_REVIEW', pax8CompanyIds: ['co-acme'] });
      expect(mapPax8Company).not.toHaveBeenCalled();
    });

    it('replaying a batch that already succeeded → 409, zero writes', async () => {
      mockBulkLookups({
        locked: [
          { pax8CompanyId: 'co-acme', orgId: ORG_A, ignored: false },
          { pax8CompanyId: 'co-beta', orgId: ORG_B, ignored: false },
        ],
      });

      const res = await postBulk({ integrationId: INTEGRATION_ID, items });

      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toMatchObject({ code: 'STALE_REVIEW', pax8CompanyIds: ['co-acme', 'co-beta'] });
      expect(mapPax8Company).not.toHaveBeenCalled();
      expect(writeRouteAudit).not.toHaveBeenCalled();
    });

    it('a company row that no longer exists → 404 NOT_FOUND, zero writes', async () => {
      mockBulkLookups({ locked: [{ pax8CompanyId: 'co-acme', orgId: null, ignored: false }] });

      const res = await postBulk({ integrationId: INTEGRATION_ID, items });

      expect(res.status).toBe(404);
      await expect(res.json()).resolves.toMatchObject({ code: 'NOT_FOUND', pax8CompanyIds: ['co-beta'] });
      expect(mapPax8Company).not.toHaveBeenCalled();
    });

    it('org renamed between review and confirm → mapped, audited source manual', async () => {
      mockBulkLookups({ orgs: [{ id: ORG_A, name: 'Acme Holdings' }, { id: ORG_B, name: 'Beta' }] });

      const res = await postBulk({ integrationId: INTEGRATION_ID, items });

      expect(res.status).toBe(200);
      expect(mapPax8Company).toHaveBeenCalledTimes(2);
      expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        resourceName: 'co-acme',
        details: expect.objectContaining({ source: 'manual', matchTier: null, matchKey: null }),
      }));
      expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        resourceName: 'co-beta',
        details: expect.objectContaining({ source: 'bulk_suggestion' }),
      }));
    });

    it('an item pointing at a different org than the suggestion is audited manual', async () => {
      mockBulkLookups({
        targets: [
          { id: ORG_A, partnerId: PARTNER, type: 'customer' },
          { id: ORG_C, partnerId: PARTNER, type: 'customer' },
        ],
      });

      const res = await postBulk({
        integrationId: INTEGRATION_ID,
        items: [items[0], { pax8CompanyId: 'co-beta', orgId: ORG_C, expectedOrgId: null }],
      });

      expect(res.status).toBe(200);
      expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        orgId: ORG_C,
        resourceName: 'co-beta',
        details: expect.objectContaining({ source: 'manual', matchTier: null, matchKey: null }),
      }));
    });

    it('returns 404 when the integration is not visible to the caller', async () => {
      mockQueryOnce([]);

      const res = await postBulk({ integrationId: INTEGRATION_ID, items });

      expect(res.status).toBe(404);
      expect(mapPax8Company).not.toHaveBeenCalled();
    });

    it('201 items → 400 before any query', async () => {
      const tooMany = Array.from({ length: 201 }, (_, i) => ({ pax8CompanyId: `co-${i}`, orgId: ORG_A, expectedOrgId: null }));

      const res = await postBulk({ integrationId: INTEGRATION_ID, items: tooMany });

      expect(res.status).toBe(400);
      expect(db.select).not.toHaveBeenCalled();
    });

    it('200 items pass validation', async () => {
      mockQueryOnce([]);
      const max = Array.from({ length: 200 }, (_, i) => ({ pax8CompanyId: `co-${i}`, orgId: ORG_A, expectedOrgId: null }));

      const res = await postBulk({ integrationId: INTEGRATION_ID, items: max });

      expect(res.status).toBe(404);
    });

    it('an empty batch → 400', async () => {
      const res = await postBulk({ integrationId: INTEGRATION_ID, items: [] });

      expect(res.status).toBe(400);
      expect(db.select).not.toHaveBeenCalled();
    });

    it('duplicate pax8CompanyId → 400 before any query', async () => {
      const res = await postBulk({ integrationId: INTEGRATION_ID, items: [items[0], { ...items[0], orgId: ORG_B }] });

      expect(res.status).toBe(400);
      expect(db.select).not.toHaveBeenCalled();
    });

    it('MFA required', async () => {
      permissionGate.mfaDeny = true;

      const res = await postBulk({ integrationId: INTEGRATION_ID, items });

      expect(res.status).toBe(403);
      expect(db.select).not.toHaveBeenCalled();
      expect(mapPax8Company).not.toHaveBeenCalled();
    });
  });

  it('rejects an organization-scope caller (Pax8 is partner-scoped)', async () => {
    authState.scope = 'organization';

    const res = await app.request('/pax8/integration', { method: 'GET' });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining('partner scope'),
    });
  });

  it('rejects a partner caller requesting another partner via ?partnerId', async () => {
    const res = await app.request('/pax8/integration?partnerId=99999999-9999-9999-9999-999999999999', {
      method: 'GET',
    });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining('denied'),
    });
  });

  it('requires partnerId for a system-scope caller', async () => {
    authState.scope = 'system';
    authState.partnerId = null;

    const res = await app.request('/pax8/integration', { method: 'GET' });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining('partnerId is required'),
    });
  });

  it('rejects linking a subscription to a contract line the caller cannot access (IDOR)', async () => {
    authState.canAccessOrg = false;
    // 1) integration lookup → belongs to caller's partner
    mockSelectOnce([{
      id: '44444444-4444-4444-4444-444444444444',
      partnerId: authState.partnerId,
      name: 'Pax8',
    }]);
    // 2) contract line lookup → an org the caller cannot access
    mockSelectOnce([{ orgId: '55555555-5555-5555-5555-555555555555' }]);

    const res = await app.request('/pax8/subscriptions/link', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        integrationId: '44444444-4444-4444-4444-444444444444',
        subscriptionSnapshotId: '66666666-6666-6666-6666-666666666666',
        contractLineId: '77777777-7777-7777-7777-777777777777',
        syncEnabled: true,
      }),
    });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      error: 'Access to contract line denied',
    });
  });

  it('returns 404 when the integration is not visible to the caller (partner-scoped lookup)', async () => {
    mockSelectOnce([]); // RLS / partner predicate filtered it out

    const res = await app.request('/pax8/subscriptions/link', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        integrationId: '44444444-4444-4444-4444-444444444444',
        subscriptionSnapshotId: '66666666-6666-6666-6666-666666666666',
        contractLineId: '77777777-7777-7777-7777-777777777777',
        syncEnabled: false,
      }),
    });

    expect(res.status).toBe(404);
  });

  it('unlinks a subscription the caller can access', async () => {
    // 1) integration lookup → belongs to caller's partner
    mockSelectOnce([{ id: '44444444-4444-4444-4444-444444444444', partnerId: authState.partnerId }]);
    // 2) snapshot lookup → org the caller can access, same integration
    mockSelectOnce([{ orgId: ORG_A, integrationId: '44444444-4444-4444-4444-444444444444' }]);
    const { unlinkPax8Subscription } = await import('../services/pax8SyncService');
    (unlinkPax8Subscription as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ unlinked: true });

    const res = await app.request('/pax8/subscriptions/link', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        integrationId: '44444444-4444-4444-4444-444444444444',
        subscriptionSnapshotId: '66666666-6666-6666-6666-666666666666',
      }),
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ data: { unlinked: true } });
  });

  it('rejects unlinking a subscription in an org the caller cannot access (IDOR)', async () => {
    authState.canAccessOrg = false;
    mockSelectOnce([{ id: '44444444-4444-4444-4444-444444444444', partnerId: authState.partnerId }]);
    mockSelectOnce([{ orgId: '55555555-5555-5555-5555-555555555555', integrationId: '44444444-4444-4444-4444-444444444444' }]);

    const res = await app.request('/pax8/subscriptions/link', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        integrationId: '44444444-4444-4444-4444-444444444444',
        subscriptionSnapshotId: '66666666-6666-6666-6666-666666666666',
      }),
    });
    expect(res.status).toBe(403);
  });

  it('returns 404 when the integration is not visible to the caller', async () => {
    mockSelectOnce([]); // partner predicate filtered it out
    const res = await app.request('/pax8/subscriptions/link', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        integrationId: '44444444-4444-4444-4444-444444444444',
        subscriptionSnapshotId: '66666666-6666-6666-6666-666666666666',
      }),
    });
    expect(res.status).toBe(404);
  });

  it('returns 404 when the snapshot is missing', async () => {
    mockSelectOnce([{ id: '44444444-4444-4444-4444-444444444444', partnerId: authState.partnerId }]);
    mockSelectOnce([]); // snapshot lookup → none
    const res = await app.request('/pax8/subscriptions/link', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        integrationId: '44444444-4444-4444-4444-444444444444',
        subscriptionSnapshotId: '66666666-6666-6666-6666-666666666666',
      }),
    });
    expect(res.status).toBe(404);
  });

  it('returns 404 when the snapshot belongs to a different integration (resource-boundary)', async () => {
    mockSelectOnce([{ id: '44444444-4444-4444-4444-444444444444', partnerId: authState.partnerId }]);
    // snapshot exists but under a different integration id → must not be unlinkable here
    mockSelectOnce([{ orgId: ORG_A, integrationId: '99999999-9999-9999-9999-999999999999' }]);
    const res = await app.request('/pax8/subscriptions/link', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        integrationId: '44444444-4444-4444-4444-444444444444',
        subscriptionSnapshotId: '66666666-6666-6666-6666-666666666666',
      }),
    });
    expect(res.status).toBe(404);
  });

  // -------------------------------------------------------------------------
  // GET /pax8/subscriptions — org-filter tests (cross-org billing leak fix)
  // -------------------------------------------------------------------------

  it('GET /subscriptions without orgId applies orgCondition filter for partner callers', async () => {
    // accessibleOrgIds = [ORG_A] (set in beforeEach)
    const integration = { id: '44444444-4444-4444-4444-444444444444', partnerId: authState.partnerId, name: 'Pax8', apiBaseUrl: 'https://api.pax8.com', tokenUrl: 'https://login.pax8.com', isActive: true, lastSyncAt: null, lastSyncStatus: null, lastSyncError: null, createdAt: new Date(), updatedAt: new Date() };
    const { whereSpy } = mockSubscriptionSelectOnce([integration], []);

    const res = await app.request('/pax8/subscriptions', { method: 'GET' });

    expect(res.status).toBe(200);
    expect(whereSpy).toHaveBeenCalled();
    // Non-vacuous: the org-filter branch must FIRE for a partner caller with no
    // orgId — orgCondition is invoked on the snapshot orgId column and returns a
    // truthy filter the route pushes into the WHERE. If that branch were removed
    // (the cross-org leak), orgCondition would not be called with this column.
    expect(orgConditionSpy).toHaveBeenCalledWith('pax8_subscription_snapshots.org_id');
    expect(orgConditionSpy).toHaveReturnedWith(`pax8_subscription_snapshots.org_id IN (${ORG_A})`);
    const body = await res.json();
    expect(body).toHaveProperty('integrationId', integration.id);
    expect(vi.mocked(db.select).mock.calls[1]?.[0]).toMatchObject({
      breezeQuantity: 'contract_lines.manual_quantity',
      quantity: 'pax8_subscription_snapshots.quantity',
      quantityKnown: 'pax8_subscription_snapshots.quantity_known',
    });
  });

  it('GET /subscriptions projects active commitment evidence without exposing the raw snapshot', async () => {
    const integration = { id: '44444444-4444-4444-4444-444444444444', partnerId: authState.partnerId };
    mockSubscriptionSelectOnce([integration], [{
      id: 'snap-1', orgId: ORG_A,
      raw: { commitment: { id: 'active-commitment', secret: 'do-not-return' } },
    }]);

    const res = await app.request(`/pax8/subscriptions?orgId=${ORG_A}`);

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data[0]).toMatchObject({
      activeCommitmentId: 'active-commitment', activeCommitmentAmbiguous: false,
    });
    expect(body.data[0]).not.toHaveProperty('raw');
    expect(JSON.stringify(body)).not.toContain('do-not-return');
  });

  it('GET /subscriptions with inaccessible orgId returns 403', async () => {
    authState.canAccessOrg = false;
    mockSubscriptionSelectOnce([{ id: '44444444-4444-4444-4444-444444444444', partnerId: authState.partnerId, name: 'Pax8', apiBaseUrl: 'https://api.pax8.com', tokenUrl: 'https://login.pax8.com', isActive: true, lastSyncAt: null, lastSyncStatus: null, lastSyncError: null, createdAt: new Date(), updatedAt: new Date() }], []);

    const res = await app.request(`/pax8/subscriptions?orgId=${ORG_B}`, { method: 'GET' });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ error: 'Access to organization denied' });
  });

  it('GET /subscriptions without orgId applies no extra filter for system-scope callers', async () => {
    authState.scope = 'system';
    authState.partnerId = null;
    authState.accessibleOrgIds = null; // system scope: null = see all

    const integration = { id: '44444444-4444-4444-4444-444444444444', partnerId: '11111111-1111-1111-1111-111111111111', name: 'Pax8', apiBaseUrl: 'https://api.pax8.com', tokenUrl: 'https://login.pax8.com', isActive: true, lastSyncAt: null, lastSyncStatus: null, lastSyncError: null, createdAt: new Date(), updatedAt: new Date() };
    // System scope caller must supply partnerId; supply it in query to pass resolvePartnerId
    const { whereSpy } = mockSubscriptionSelectOnce([integration], [{ id: 'snap-1', orgId: ORG_A }, { id: 'snap-2', orgId: ORG_B }]);

    const res = await app.request('/pax8/subscriptions?partnerId=11111111-1111-1111-1111-111111111111', { method: 'GET' });

    expect(res.status).toBe(200);
    expect(whereSpy).toHaveBeenCalled();
    // System scope: the branch still runs but orgCondition returns undefined, so
    // NO org filter is pushed and all rows are visible (operators see everything).
    expect(orgConditionSpy).toHaveBeenCalledWith('pax8_subscription_snapshots.org_id');
    expect(orgConditionSpy).toHaveReturnedWith(undefined);
    const body = await res.json();
    expect(body.data).toHaveLength(2);
  });
});
