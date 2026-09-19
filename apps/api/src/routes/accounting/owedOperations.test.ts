import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/pg-proxy';

const PARTNER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_PARTNER_ID = '22222222-2222-4222-8222-222222222222';
const ENTITY_ID = '33333333-3333-4333-8333-333333333333';

const { authState, effects, AccountingError } = vi.hoisted(() => {
  class AccountingError extends Error {
    constructor(
      public readonly code: string,
      public readonly status: number,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    authState: {
      scope: 'partner' as 'partner' | 'system' | 'organization',
      partnerId: '11111111-1111-4111-8111-111111111111' as string | null,
      authenticated: true,
      readAllowed: true,
      partnerOrgAccess: 'selected' as 'all' | 'selected' | 'none' | null,
    },
    effects: {
      buildAuthUrl: vi.fn(() => 'https://provider.example.test/oauth'),
      getConnection: vi.fn(),
      deleteConnection: vi.fn(),
      refreshRealmSettings: vi.fn(),
      listCustomers: vi.fn(),
      importCustomers: vi.fn(),
      listMappings: vi.fn(),
      listIncomeAccounts: vi.fn(),
      saveMapping: vi.fn(),
      syncMapping: vi.fn(),
      resolveConnection: vi.fn(),
      listRemoteCustomers: vi.fn(),
      pushInvoice: vi.fn(),
      enqueueInvoice: vi.fn(),
      enqueueReconcile: vi.fn(),
      dbSelect: vi.fn(),
      dbUpdateReturning: vi.fn(),
      audit: vi.fn(),
    },
    AccountingError,
  };
});

vi.mock('../../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    if (!authState.authenticated) return c.json({ error: 'Unauthorized' }, 401);
    c.set('auth', {
      scope: authState.scope,
      partnerId: authState.partnerId,
      partnerOrgAccess: authState.partnerOrgAccess,
      orgId: authState.scope === 'organization' ? ENTITY_ID : null,
      user: { id: ENTITY_ID },
      token: { mfa: true },
    });
    return next();
  },
  requireScope: (...scopes: string[]) => async (c: any, next: any) => (
    scopes.includes(c.get('auth').scope)
      ? next()
      : c.json({ error: 'Insufficient permissions' }, 403)
  ),
  requireMfa: () => async (_c: any, next: any) => next(),
  requirePermission: (resource: string, action: string) => async (c: any, next: any) =>
    resource === 'accounting' && action === 'read' && !authState.readAllowed
      ? c.json({ error: 'Forbidden' }, 403) : next(),
  withAuthDbAccessContext: async (_auth: unknown, fn: () => unknown) => fn(),
}));

vi.mock('../../db', () => ({
  db: { select: (fields: Parameters<typeof queryDb.select>[0]) => queryDb.select(fields) },
  runOutsideDbContext: <T>(fn: () => T) => fn(),
  withSystemDbAccessContext: <T>(fn: () => T) => fn(),
}));

vi.mock('../../services/accounting/accountingConnectionService', () => ({
  getConnection: effects.getConnection,
  deleteConnection: effects.deleteConnection,
  refreshRealmSettings: effects.refreshRealmSettings,
  upsertConnection: vi.fn(),
  resetConnectionForRealmChange: vi.fn(),
  updateHomeCurrency: vi.fn(),
  updateMultiCurrencyEnabled: vi.fn(),
  isHomeCurrencyCasAbort: () => false,
  AccountingConnectionError: AccountingError,
}));

vi.mock('../../services/accounting/quickbooksCustomerImport', () => ({
  listQuickbooksCustomersAnnotated: effects.listCustomers,
  importQuickbooksCustomers: effects.importCustomers,
  QbImportError: AccountingError,
}));

vi.mock('../../services/accounting/accountingMappingService', () => ({
  listMappingProposals: effects.listMappings,
  listRemoteIncomeAccountsForPartner: effects.listIncomeAccounts,
  saveMappingDecision: effects.saveMapping,
  syncMappedEntity: effects.syncMapping,
  resolveConnectionAndToken: effects.resolveConnection,
  AccountingMappingError: AccountingError,
}));

vi.mock('../../services/accounting/accountingInvoicePush', () => ({
  pushInvoiceToAccounting: effects.pushInvoice,
  AccountingInvoicePushError: AccountingError,
}));

vi.mock('../../services/accounting/providerRegistry', () => ({
  getAccountingProvider: () => ({
    buildAuthUrl: effects.buildAuthUrl,
    listRemoteCustomers: effects.listRemoteCustomers,
    listRemoteItems: vi.fn(),
  }),
}));

vi.mock('../../jobs/accountingSyncWorker', () => ({
  enqueueAccountingInvoicePush: effects.enqueueInvoice,
}));
vi.mock('../../jobs/accountingReconcileWorker', () => ({
  enqueueAccountingReconcile: effects.enqueueReconcile,
}));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: effects.audit }));
vi.mock('../../services/sentry', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('../../config/env', () => ({
  QBO_CLIENT_ID: 'client-id',
  QBO_CLIENT_SECRET: 'client-secret',
  QBO_REDIRECT_URI: 'https://api.example.test/accounting/quickbooks/callback',
  QBO_ENVIRONMENT: 'production',
}));

import { accountingRoutes } from './index';

const queryDb = drizzle(effects.dbSelect);
const PARTNER_QUERY = `?partnerId=${PARTNER_ID}`;
function request(query = '') {
  const app = new Hono();
  app.route('/accounting', accountingRoutes);
  return app.request(`/accounting/quickbooks/owed-operations${query}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  authState.authenticated = true;
  authState.readAllowed = true;
  authState.scope = 'partner';
  authState.partnerId = PARTNER_ID;
  authState.partnerOrgAccess = 'all';
  effects.dbSelect.mockResolvedValue({ rows: [] });
});

describe('GET /accounting/quickbooks/owed-operations', () => {
  it('returns a zero count for an empty outbox', async () => {
    const res = await request();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ count: 0, data: [] });
  });

  it('shows pending deletes after the local payment is gone, pending pushes, and missing invoices', async () => {
    const pendingSince = new Date(Date.now() - 3600_000).toISOString();
    effects.dbSelect.mockResolvedValue({ rows: [
      ['delete-1', 'delete', 'QuickBooks refused the delete', pendingSince, ENTITY_ID, 'INV-10'],
      ['push-1', 'push', null, pendingSince, ENTITY_ID, 'INV-10'],
      ['delete-orphan', 'delete', 'Invoice removed', pendingSince, null, null],
    ] });
    const res = await request();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(3);
    expect(body.data[0]).toEqual({ id: 'delete-1', pendingOp: 'delete', lastError: 'QuickBooks refused the delete', pendingSince, ageSeconds: expect.any(Number), invoiceId: ENTITY_ID, invoiceNumber: 'INV-10' });
    expect(body.data[0].ageSeconds).toBeGreaterThanOrEqual(3600);
    expect(body.data[1]).toMatchObject({ pendingOp: 'push', lastError: null });
    expect(body.data[2]).toMatchObject({ invoiceId: null, invoiceNumber: null, ageSeconds: expect.any(Number) });
    const [sql, params] = effects.dbSelect.mock.calls[0]!;
    expect(sql).toContain('left join "invoice_payments"');
    expect(sql).toContain('left join "accounting_entity_mappings" "owed_invoice_mapping"');
    expect(sql).toContain('split_part(');
    expect(sql).toContain('coalesce("accounting_entity_mappings"."pending_since", "accounting_entity_mappings"."created_at")');
    expect(sql).toContain('"owed_invoice_mapping"."integration_id" = "accounting_entity_mappings"."integration_id"');
    expect(sql).toContain('"owed_invoice_mapping"."partner_id" = "accounting_entity_mappings"."partner_id"');
    expect(sql).toContain('"invoices"."partner_id" =');
    expect(sql).toContain('"accounting_connections"."partner_id" = "accounting_entity_mappings"."partner_id"');
    expect(sql).toContain('"accounting_connections"."provider" =');
    expect(sql).toContain('"accounting_entity_mappings"."pending_op" is not null');
    expect(params).toContain(PARTNER_ID);
    expect(params).toContain('quickbooks');
    expect(params).toContain('payment');
    expect(params).toContain('invoice');
  });

  it.each(['selected', 'none', null] as const)('denies partial partner access %s', async (access) => {
    authState.partnerOrgAccess = access;
    expect((await request()).status).toBe(403);
    expect(effects.dbSelect).not.toHaveBeenCalled();
  });
  it('denies organization scope', async () => {
    authState.scope = 'organization';
    expect((await request()).status).toBe(403);
    expect(effects.dbSelect).not.toHaveBeenCalled();
  });
  it('denies another partner', async () => {
    expect((await request(`?partnerId=${OTHER_PARTNER_ID}`)).status).toBe(403);
    expect(effects.dbSelect).not.toHaveBeenCalled();
  });
  it('requires authentication', async () => {
    authState.authenticated = false;
    expect((await request()).status).toBe(401);
    expect(effects.dbSelect).not.toHaveBeenCalled();
  });
  it('requires accounting read permission', async () => {
    authState.readAllowed = false;
    expect((await request()).status).toBe(403);
    expect(effects.dbSelect).not.toHaveBeenCalled();
  });
  it('binds system reads to the explicitly requested partner', async () => {
    authState.scope = 'system';
    authState.partnerId = null;
    authState.partnerOrgAccess = null;
    expect((await request()).status).toBe(400);
    expect(effects.dbSelect).not.toHaveBeenCalled();
    expect((await request(PARTNER_QUERY)).status).toBe(200);
    expect(effects.dbSelect.mock.calls[0]![1]).toContain(PARTNER_ID);
  });
  it('rejects invalid partner ids before querying', async () => {
    authState.scope = 'system';
    expect((await request('?partnerId=bad')).status).toBe(400);
    expect(effects.dbSelect).not.toHaveBeenCalled();
  });
  it('does not present a database failure as an empty outbox', async () => {
    effects.dbSelect.mockRejectedValue(new Error('query failed'));
    expect((await request()).status).toBe(500);
  });
});
