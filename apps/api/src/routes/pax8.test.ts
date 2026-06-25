import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const ORG_A = '22222222-2222-2222-2222-222222222222';
const ORG_B = '55555555-5555-5555-5555-555555555555';

const { permissionGate, authState, orgConditionSpy } = vi.hoisted(() => {
  const authState = {
    canAccessOrg: true,
    partnerId: '11111111-1111-1111-1111-111111111111' as string | null,
    scope: 'partner' as 'partner' | 'organization' | 'system',
    // null = system scope (no filter); string[] = partner/org scope accessible orgs
    accessibleOrgIds: ['22222222-2222-2222-2222-222222222222'] as string[] | null,
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
  return { permissionGate: { deny: false }, authState, orgConditionSpy };
});

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock('../db/schema', () => ({
  organizations: {
    id: 'organizations.id',
    name: 'organizations.name',
    partnerId: 'organizations.partner_id',
  },
  contractLines: {
    id: 'contract_lines.id',
    orgId: 'contract_lines.org_id',
    lineType: 'contract_lines.line_type',
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
    unitPrice: 'pax8_subscription_snapshots.unit_price',
    unitCost: 'pax8_subscription_snapshots.unit_cost',
    currencyCode: 'pax8_subscription_snapshots.currency_code',
    lastSeenAt: 'pax8_subscription_snapshots.last_seen_at',
  },
  pax8ContractLineLinks: {
    id: 'pax8_contract_line_links.id',
    integrationId: 'pax8_contract_line_links.integration_id',
    orgId: 'pax8_contract_line_links.org_id',
    subscriptionSnapshotId: 'pax8_contract_line_links.subscription_snapshot_id',
    contractLineId: 'pax8_contract_line_links.contract_line_id',
    syncEnabled: 'pax8_contract_line_links.sync_enabled',
    lastAppliedQuantity: 'pax8_contract_line_links.last_applied_quantity',
    lastAppliedAt: 'pax8_contract_line_links.last_applied_at',
  },
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    const ids = authState.accessibleOrgIds;
    c.set('auth', {
      scope: authState.scope,
      partnerId: authState.partnerId,
      orgId: authState.scope === 'organization' ? ORG_A : null,
      accessibleOrgIds: ids,
      canAccessOrg: vi.fn(() => authState.canAccessOrg),
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
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
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
}));

import { db } from '../db';
import { pax8Routes } from './pax8';

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

  // Second call: the snapshot join query (from/leftJoin/leftJoin/where/orderBy/limit)
  const leftJoinMock = vi.fn().mockReturnThis();
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn(() => ({
      leftJoin: leftJoinMock.mockImplementation(() => ({
        leftJoin: vi.fn(() => ({
          where: whereSpy,
        })),
      })),
    })),
  } as any);

  return { whereSpy, getConditions: () => whereConditions };
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
    authState.canAccessOrg = true;
    authState.partnerId = '11111111-1111-1111-1111-111111111111';
    authState.scope = 'partner';
    authState.accessibleOrgIds = [ORG_A];
    app = new Hono();
    app.route('/pax8', pax8Routes);
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
