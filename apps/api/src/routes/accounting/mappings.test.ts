import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const {
  listMappingProposalsMock,
  listRemoteIncomeAccountsForPartnerMock,
  saveMappingDecisionMock,
  syncMappedEntityMock,
  writeRouteAuditMock,
  AccountingMappingError,
  authState,
} = vi.hoisted(() => {
  const listMappingProposalsMock = vi.fn();
  const listRemoteIncomeAccountsForPartnerMock = vi.fn();
  const saveMappingDecisionMock = vi.fn();
  const syncMappedEntityMock = vi.fn();
  const writeRouteAuditMock = vi.fn();
  class AccountingMappingError extends Error {
    code: string;
    status: number;
    constructor(code: string, status: number, message: string) {
      super(message);
      this.code = code;
      this.status = status;
      this.name = 'AccountingMappingError';
    }
  }
  const authState = {
    scope: 'partner' as 'partner' | 'system',
    permissions: new Set<string>(['organizations:write', 'catalog:write']),
    mfa: true,
  };
  return {
    listMappingProposalsMock,
    listRemoteIncomeAccountsForPartnerMock,
    saveMappingDecisionMock,
    syncMappedEntityMock,
    writeRouteAuditMock,
    AccountingMappingError,
    authState,
  };
});

vi.mock('../../services/accounting/accountingMappingService', () => ({
  listMappingProposals: listMappingProposalsMock,
  listRemoteIncomeAccountsForPartner: listRemoteIncomeAccountsForPartnerMock,
  saveMappingDecision: saveMappingDecisionMock,
  syncMappedEntity: syncMappedEntityMock,
  AccountingMappingError,
}));

// Not exercised by these tests (import/customers routes), but the module is
// imported transitively by routes/accounting/index.ts.
vi.mock('../../services/accounting/quickbooksCustomerImport', () => ({
  listQuickbooksCustomersAnnotated: vi.fn(),
  importQuickbooksCustomers: vi.fn(),
  QbImportError: class QbImportError extends Error {
    code: string;
    status: number;
    constructor(m: string, c: string, s: number) {
      super(m);
      this.code = c;
      this.status = s;
    }
  },
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('auth', {
      scope: authState.scope,
      partnerId: authState.scope === 'system' ? null : 'p1',
      user: { id: 'u1' },
    });
    await next();
  },
  requireScope: () => async (_c: any, next: any) => next(),
  requireMfa: () => async (c: any, next: any) => {
    if (!authState.mfa) return c.json({ error: 'MFA required' }, 403);
    return next();
  },
  requirePermission: (resource: string, action: string) => async (c: any, next: any) => {
    if (!authState.permissions.has(`${resource}:${action}`)) return c.json({ error: 'Permission denied' }, 403);
    return next();
  },
}));

vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: writeRouteAuditMock }));

vi.mock('../../config/env', () => ({
  QBO_CLIENT_ID: 'client-id',
  QBO_CLIENT_SECRET: 'client-secret',
  QBO_REDIRECT_URI: 'https://api.example.test/accounting/quickbooks/callback',
  QBO_ENVIRONMENT: 'production',
}));

import { accountingRoutes } from './index';

function app() {
  const a = new Hono();
  a.route('/accounting', accountingRoutes);
  return a;
}

const VALID_ORG_ID = '11111111-1111-4111-8111-111111111111';
const VALID_ITEM_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_PARTNER_ID = '99999999-9999-4999-8999-999999999999';

// The REAL shape saveMappingDecision/syncMappedEntity return — the full
// accounting_entity_mappings row, including internal tenancy/connection ids
// and QuickBooks' own optimistic-concurrency token. Route tests assert these
// never reach the response body (index.ts's toMappingResponse curates them
// out), so the fixture must not be a hand-picked subset that hides that.
function fullMappingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'm1',
    integrationId: 'conn-1',
    partnerId: 'p1',
    breezeEntityType: 'org',
    breezeEntityId: VALID_ORG_ID,
    remoteEntityType: 'Customer',
    remoteEntityId: 'qb-1',
    remoteSyncToken: 'qb-sync-token-42',
    linkStatus: 'confirmed',
    syncStatus: 'pending',
    lastSyncedAt: null,
    lastError: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-02T00:00:00Z'),
    ...overrides,
  };
}

const INTERNAL_MAPPING_FIELDS = ['integrationId', 'partnerId', 'remoteSyncToken', 'createdAt', 'updatedAt'] as const;

beforeEach(() => {
  vi.clearAllMocks();
  authState.scope = 'partner';
  authState.permissions = new Set(['organizations:write', 'catalog:write']);
  authState.mfa = true;
});

describe('GET /accounting/:provider/mappings', () => {
  it('returns proposals for the authenticated partner', async () => {
    listMappingProposalsMock.mockResolvedValue([
      {
        breezeEntityType: 'org',
        breezeEntityId: VALID_ORG_ID,
        breezeDisplayName: 'Acme',
        remoteEntityType: 'Customer',
        proposedRemoteId: null,
        proposedRemoteName: null,
        confidence: 'none',
        linkStatus: 'suggested',
        syncStatus: 'pending',
        lastError: null,
      },
    ]);
    const res = await app().request('/accounting/quickbooks/mappings?entityType=org');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(listMappingProposalsMock).toHaveBeenCalledWith({ partnerId: 'p1', provider: 'quickbooks', entityType: 'org' });
  });

  it('rejects a missing/invalid entityType with 400 before calling the service', async () => {
    const res = await app().request('/accounting/quickbooks/mappings');
    expect(res.status).toBe(400);
    expect(listMappingProposalsMock).not.toHaveBeenCalled();
  });

  it('system scope requires an explicit partnerId (400)', async () => {
    authState.scope = 'system';
    const res = await app().request('/accounting/quickbooks/mappings?entityType=org');
    expect(res.status).toBe(400);
    expect(listMappingProposalsMock).not.toHaveBeenCalled();
  });

  it('partner scope cannot request another partner (403)', async () => {
    const res = await app().request(`/accounting/quickbooks/mappings?entityType=org&partnerId=${OTHER_PARTNER_ID}`);
    expect(res.status).toBe(403);
    expect(listMappingProposalsMock).not.toHaveBeenCalled();
  });

  it('system scope with explicit partnerId is forwarded to the service', async () => {
    authState.scope = 'system';
    listMappingProposalsMock.mockResolvedValue([]);
    const res = await app().request(`/accounting/quickbooks/mappings?entityType=catalog_item&partnerId=${OTHER_PARTNER_ID}`);
    expect(res.status).toBe(200);
    expect(listMappingProposalsMock).toHaveBeenCalledWith({ partnerId: OTHER_PARTNER_ID, provider: 'quickbooks', entityType: 'catalog_item' });
  });

  it('maps AccountingMappingError(not_connected) to 404', async () => {
    listMappingProposalsMock.mockRejectedValue(new AccountingMappingError('not_connected', 404, 'nope'));
    const res = await app().request('/accounting/quickbooks/mappings?entityType=org');
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'not_connected' });
  });

  it('maps AccountingMappingError(reauth_required) to 409', async () => {
    listMappingProposalsMock.mockRejectedValue(new AccountingMappingError('reauth_required', 409, 'reconnect'));
    const res = await app().request('/accounting/quickbooks/mappings?entityType=org');
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'reauth_required' });
  });

  it('maps AccountingMappingError(quickbooks_error) to 502 without leaking upstream body', async () => {
    listMappingProposalsMock.mockRejectedValue(new AccountingMappingError('quickbooks_error', 502, 'QuickBooks returned an error while listing customers'));
    const res = await app().request('/accounting/quickbooks/mappings?entityType=org');
    expect(res.status).toBe(502);
    const text = JSON.stringify(await res.json());
    expect(text).not.toMatch(/access_?token|refresh_?token|realm/i);
  });

  it('a proposal listing does not leak provider tokens or realm id', async () => {
    listMappingProposalsMock.mockResolvedValue([]);
    const res = await app().request('/accounting/quickbooks/mappings?entityType=org');
    const text = JSON.stringify(await res.json());
    expect(text).not.toMatch(/access_?token|refresh_?token|realm/i);
  });
});

describe('GET /accounting/:provider/income-accounts', () => {
  it('returns sanitized income accounts for the authenticated partner', async () => {
    listRemoteIncomeAccountsForPartnerMock.mockResolvedValue([
      { id: '1', displayName: 'Sales', accountType: 'Income' },
    ]);
    const res = await app().request('/accounting/quickbooks/income-accounts');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [{ id: '1', displayName: 'Sales', accountType: 'Income' }] });
    expect(listRemoteIncomeAccountsForPartnerMock).toHaveBeenCalledWith({ partnerId: 'p1', provider: 'quickbooks' });
  });

  it('is read-only: no MFA/permission gate blocks a plain partner-scoped caller', async () => {
    authState.permissions = new Set();
    listRemoteIncomeAccountsForPartnerMock.mockResolvedValue([]);
    const res = await app().request('/accounting/quickbooks/income-accounts');
    expect(res.status).toBe(200);
  });

  it('partner scope cannot request another partner (403)', async () => {
    const res = await app().request(`/accounting/quickbooks/income-accounts?partnerId=${OTHER_PARTNER_ID}`);
    expect(res.status).toBe(403);
    expect(listRemoteIncomeAccountsForPartnerMock).not.toHaveBeenCalled();
  });

  it('system scope requires an explicit partnerId (400)', async () => {
    authState.scope = 'system';
    const res = await app().request('/accounting/quickbooks/income-accounts');
    expect(res.status).toBe(400);
    expect(listRemoteIncomeAccountsForPartnerMock).not.toHaveBeenCalled();
  });

  it('maps AccountingMappingError(not_connected) to 404', async () => {
    listRemoteIncomeAccountsForPartnerMock.mockRejectedValue(new AccountingMappingError('not_connected', 404, 'nope'));
    const res = await app().request('/accounting/quickbooks/income-accounts');
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'not_connected' });
  });
});

describe('PUT /accounting/:provider/mappings', () => {
  function putMapping(body: unknown) {
    return app().request('/accounting/quickbooks/mappings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('confirms an org mapping, requires ORGS_WRITE, and audits the decision', async () => {
    saveMappingDecisionMock.mockResolvedValue(fullMappingRow());
    const res = await putMapping({
      breezeEntityType: 'org',
      breezeEntityId: VALID_ORG_ID,
      decision: 'confirmed',
      remoteEntityId: 'qb-1',
    });
    expect(res.status).toBe(200);
    expect(saveMappingDecisionMock).toHaveBeenCalledWith({
      partnerId: 'p1',
      provider: 'quickbooks',
      breezeEntityType: 'org',
      breezeEntityId: VALID_ORG_ID,
      decision: 'confirmed',
      remoteEntityId: 'qb-1',
    });
    expect(writeRouteAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'accounting.mapping.update',
        resourceType: 'accounting_mapping',
        details: expect.objectContaining({
          breezeEntityType: 'org',
          breezeEntityId: VALID_ORG_ID,
          decision: 'confirmed',
          remoteEntityType: 'Customer',
        }),
      }),
    );

    // Curated projection (index.ts's toMappingResponse): the full internal
    // row (id, integrationId, partnerId, remoteSyncToken, createdAt,
    // updatedAt) must never reach the wire.
    const body = await res.json();
    expect(body.data).toEqual({
      breezeEntityType: 'org',
      breezeEntityId: VALID_ORG_ID,
      remoteEntityType: 'Customer',
      remoteEntityId: 'qb-1',
      linkStatus: 'confirmed',
      syncStatus: 'pending',
      lastSyncedAt: null,
      lastError: null,
    });
    for (const field of INTERNAL_MAPPING_FIELDS) {
      expect(body.data).not.toHaveProperty(field);
    }
  });

  it('requires MFA (403) before calling the service, even with sufficient permissions', async () => {
    authState.mfa = false;
    const res = await putMapping({
      breezeEntityType: 'org',
      breezeEntityId: VALID_ORG_ID,
      decision: 'create_new',
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'MFA required' });
    expect(saveMappingDecisionMock).not.toHaveBeenCalled();
  });

  it('system scope requires an explicit partnerId (400) before calling the service', async () => {
    authState.scope = 'system';
    const res = await putMapping({ breezeEntityType: 'org', breezeEntityId: VALID_ORG_ID, decision: 'create_new' });
    expect(res.status).toBe(400);
    expect(saveMappingDecisionMock).not.toHaveBeenCalled();
  });

  it('partner scope cannot request another partner (403) before calling the service', async () => {
    const res = await app().request(`/accounting/quickbooks/mappings?partnerId=${OTHER_PARTNER_ID}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ breezeEntityType: 'org', breezeEntityId: VALID_ORG_ID, decision: 'create_new' }),
    });
    expect(res.status).toBe(403);
    expect(saveMappingDecisionMock).not.toHaveBeenCalled();
  });

  it('denies an org decision without ORGS_WRITE (403) before calling the service', async () => {
    authState.permissions = new Set(['catalog:write']);
    const res = await putMapping({
      breezeEntityType: 'org',
      breezeEntityId: VALID_ORG_ID,
      decision: 'create_new',
    });
    expect(res.status).toBe(403);
    expect(saveMappingDecisionMock).not.toHaveBeenCalled();
  });

  it('denies a catalog_item decision without CATALOG_WRITE (403) before calling the service', async () => {
    authState.permissions = new Set(['organizations:write']);
    const res = await putMapping({
      breezeEntityType: 'catalog_item',
      breezeEntityId: VALID_ITEM_ID,
      decision: 'create_new',
    });
    expect(res.status).toBe(403);
    expect(saveMappingDecisionMock).not.toHaveBeenCalled();
  });

  it('allows a SYSTEM-scope caller that holds no per-partner role', async () => {
    authState.scope = 'system';
    authState.permissions = new Set();
    saveMappingDecisionMock.mockResolvedValue(fullMappingRow({
      partnerId: OTHER_PARTNER_ID, remoteEntityId: null, linkStatus: 'create_new',
    }));
    const res = await app().request(`/accounting/quickbooks/mappings?partnerId=${OTHER_PARTNER_ID}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ breezeEntityType: 'org', breezeEntityId: VALID_ORG_ID, decision: 'create_new' }),
    });
    expect(res.status).toBe(200);
    expect(saveMappingDecisionMock).toHaveBeenCalledWith(expect.objectContaining({ partnerId: OTHER_PARTNER_ID }));
  });

  it('rejects confirmed decision missing remoteEntityId with 400 before service invocation', async () => {
    const res = await putMapping({ breezeEntityType: 'org', breezeEntityId: VALID_ORG_ID, decision: 'confirmed' });
    expect(res.status).toBe(400);
    expect(saveMappingDecisionMock).not.toHaveBeenCalled();
  });

  it('rejects a non-confirmed decision that supplies remoteEntityId with 400', async () => {
    const res = await putMapping({ breezeEntityType: 'org', breezeEntityId: VALID_ORG_ID, decision: 'unlinked', remoteEntityId: 'qb-1' });
    expect(res.status).toBe(400);
    expect(saveMappingDecisionMock).not.toHaveBeenCalled();
  });

  it('rejects an invalid GUID breezeEntityId with 400 before service invocation', async () => {
    const res = await putMapping({ breezeEntityType: 'org', breezeEntityId: 'not-a-guid', decision: 'create_new' });
    expect(res.status).toBe(400);
    expect(saveMappingDecisionMock).not.toHaveBeenCalled();
  });

  it('the partner-supplied body partnerId (if any) never reaches the service — only auth.partnerId does', async () => {
    saveMappingDecisionMock.mockResolvedValue(fullMappingRow({ remoteEntityId: null, linkStatus: 'create_new' }));
    const res = await app().request('/accounting/quickbooks/mappings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        breezeEntityType: 'org',
        breezeEntityId: VALID_ORG_ID,
        decision: 'create_new',
        partnerId: OTHER_PARTNER_ID,
      }),
    });
    expect(res.status).toBe(200);
    expect(saveMappingDecisionMock).toHaveBeenCalledWith(expect.objectContaining({ partnerId: 'p1' }));
  });

  it('maps AccountingMappingError(mapping_conflict) to 409', async () => {
    saveMappingDecisionMock.mockRejectedValue(new AccountingMappingError('mapping_conflict', 409, 'already mapped'));
    const res = await putMapping({ breezeEntityType: 'org', breezeEntityId: VALID_ORG_ID, decision: 'confirmed', remoteEntityId: 'qb-1' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'mapping_conflict' });
  });

  it('maps AccountingMappingError(entity_not_found) to 404', async () => {
    saveMappingDecisionMock.mockRejectedValue(new AccountingMappingError('entity_not_found', 404, 'not found'));
    const res = await putMapping({ breezeEntityType: 'org', breezeEntityId: VALID_ORG_ID, decision: 'confirmed', remoteEntityId: 'qb-1' });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'entity_not_found' });
  });

  it('maps AccountingMappingError(quickbooks_error) to 502 without leaking upstream body', async () => {
    saveMappingDecisionMock.mockRejectedValue(new AccountingMappingError('quickbooks_error', 502, 'QuickBooks returned an error while listing customers'));
    const res = await putMapping({ breezeEntityType: 'org', breezeEntityId: VALID_ORG_ID, decision: 'confirmed', remoteEntityId: 'qb-1' });
    expect(res.status).toBe(502);
    const text = JSON.stringify(await res.json());
    expect(text).not.toMatch(/access_?token|refresh_?token|realm/i);
  });

  it('does not audit or leak tokens on a failed decision', async () => {
    saveMappingDecisionMock.mockRejectedValue(new AccountingMappingError('mapping_conflict', 409, 'already mapped'));
    const res = await putMapping({ breezeEntityType: 'org', breezeEntityId: VALID_ORG_ID, decision: 'confirmed', remoteEntityId: 'qb-1' });
    expect(res.status).toBe(409);
    const text = JSON.stringify(await res.json());
    expect(text).not.toMatch(/access_?token|refresh_?token|realm/i);
  });
});

describe('POST /accounting/:provider/mappings/sync', () => {
  function postSync(body: unknown) {
    return app().request('/accounting/quickbooks/mappings/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('syncs a confirmed org mapping, requires ORGS_WRITE, and audits the result', async () => {
    syncMappedEntityMock.mockResolvedValue(fullMappingRow({ syncStatus: 'synced' }));
    const res = await postSync({ breezeEntityType: 'org', breezeEntityId: VALID_ORG_ID });
    expect(res.status).toBe(200);
    expect(syncMappedEntityMock).toHaveBeenCalledWith({
      partnerId: 'p1', provider: 'quickbooks', breezeEntityType: 'org', breezeEntityId: VALID_ORG_ID,
    });
    expect(writeRouteAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'accounting.entity.sync',
        resourceType: 'accounting_mapping',
        details: expect.objectContaining({ breezeEntityType: 'org', breezeEntityId: VALID_ORG_ID }),
      }),
    );

    // Curated projection: the full internal row (id, integrationId,
    // partnerId, remoteSyncToken, createdAt, updatedAt) must never reach the
    // wire.
    const body = await res.json();
    expect(body.data).toEqual({
      breezeEntityType: 'org',
      breezeEntityId: VALID_ORG_ID,
      remoteEntityType: 'Customer',
      remoteEntityId: 'qb-1',
      linkStatus: 'confirmed',
      syncStatus: 'synced',
      lastSyncedAt: null,
      lastError: null,
    });
    for (const field of INTERNAL_MAPPING_FIELDS) {
      expect(body.data).not.toHaveProperty(field);
    }
  });

  it('requires MFA (403) before calling the service, even with sufficient permissions', async () => {
    authState.mfa = false;
    const res = await postSync({ breezeEntityType: 'org', breezeEntityId: VALID_ORG_ID });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'MFA required' });
    expect(syncMappedEntityMock).not.toHaveBeenCalled();
  });

  it('denies an org sync without ORGS_WRITE (403) before calling the service', async () => {
    authState.permissions = new Set(['catalog:write']);
    const res = await postSync({ breezeEntityType: 'org', breezeEntityId: VALID_ORG_ID });
    expect(res.status).toBe(403);
    expect(syncMappedEntityMock).not.toHaveBeenCalled();
  });

  it('denies a catalog_item sync without CATALOG_WRITE (403) before calling the service', async () => {
    authState.permissions = new Set(['organizations:write']);
    const res = await postSync({ breezeEntityType: 'catalog_item', breezeEntityId: VALID_ITEM_ID });
    expect(res.status).toBe(403);
    expect(syncMappedEntityMock).not.toHaveBeenCalled();
  });

  it('rejects an invalid GUID breezeEntityId with 400 before service invocation', async () => {
    const res = await postSync({ breezeEntityType: 'org', breezeEntityId: 'not-a-guid' });
    expect(res.status).toBe(400);
    expect(syncMappedEntityMock).not.toHaveBeenCalled();
  });

  it('maps AccountingMappingError(mapping_not_ready) to 409', async () => {
    syncMappedEntityMock.mockRejectedValue(new AccountingMappingError('mapping_not_ready', 409, 'confirm first'));
    const res = await postSync({ breezeEntityType: 'org', breezeEntityId: VALID_ORG_ID });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'mapping_not_ready' });
  });

  it('maps AccountingMappingError(income_account_required) to 409', async () => {
    syncMappedEntityMock.mockRejectedValue(new AccountingMappingError('income_account_required', 409, 'select an account'));
    const res = await postSync({ breezeEntityType: 'catalog_item', breezeEntityId: VALID_ITEM_ID });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'income_account_required' });
  });

  it('maps AccountingMappingError(item_price_required) to 409', async () => {
    syncMappedEntityMock.mockRejectedValue(new AccountingMappingError('item_price_required', 409, 'add a price'));
    const res = await postSync({ breezeEntityType: 'catalog_item', breezeEntityId: VALID_ITEM_ID });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'item_price_required' });
  });

  it('maps AccountingMappingError(quickbooks_error) to 502 without leaking upstream body', async () => {
    syncMappedEntityMock.mockRejectedValue(new AccountingMappingError('quickbooks_error', 502, 'QuickBooks rejected the customer sync'));
    const res = await postSync({ breezeEntityType: 'org', breezeEntityId: VALID_ORG_ID });
    expect(res.status).toBe(502);
    const text = JSON.stringify(await res.json());
    expect(text).not.toMatch(/access_?token|refresh_?token|realm/i);
  });

  it('the partner-supplied body partnerId (if any) never reaches the service — only auth.partnerId does', async () => {
    syncMappedEntityMock.mockResolvedValue(fullMappingRow({ syncStatus: 'synced' }));
    const res = await app().request('/accounting/quickbooks/mappings/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ breezeEntityType: 'org', breezeEntityId: VALID_ORG_ID, partnerId: OTHER_PARTNER_ID }),
    });
    expect(res.status).toBe(200);
    expect(syncMappedEntityMock).toHaveBeenCalledWith(expect.objectContaining({ partnerId: 'p1' }));
  });
});
