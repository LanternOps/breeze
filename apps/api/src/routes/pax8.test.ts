import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const { permissionGate, authState } = vi.hoisted(() => ({
  permissionGate: { deny: false },
  authState: {
    canAccessOrg: true,
    partnerId: '11111111-1111-1111-1111-111111111111',
  },
}));

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
    c.set('auth', {
      scope: 'partner',
      partnerId: authState.partnerId,
      orgId: null,
      accessibleOrgIds: ['22222222-2222-2222-2222-222222222222'],
      canAccessOrg: vi.fn(() => authState.canAccessOrg),
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

describe('pax8 routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    permissionGate.deny = false;
    authState.canAccessOrg = true;
    authState.partnerId = '11111111-1111-1111-1111-111111111111';
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
});
