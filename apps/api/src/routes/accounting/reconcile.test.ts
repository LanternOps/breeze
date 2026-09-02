import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// Phase D, Task 6 (2026-09-02-quickbooks-phase-d-payment-pullback) —
// POST /:provider/reconcile ("Sync now"), on routes/accounting/index.ts.
// Mirrors the mocking pattern established in invoicePush.test.ts: mock the
// service seams the route calls through, plus the auth middleware, and
// exercise only the one NEW route here.
const {
  getConnectionMock,
  enqueueAccountingReconcileMock,
  writeRouteAuditMock,
  authState,
} = vi.hoisted(() => {
  const getConnectionMock = vi.fn();
  const enqueueAccountingReconcileMock = vi.fn();
  const writeRouteAuditMock = vi.fn();
  const authState = {
    scope: 'partner' as 'partner' | 'system' | 'organization',
    permissions: new Set<string>(['invoices:write']),
    mfa: true,
  };
  return { getConnectionMock, enqueueAccountingReconcileMock, writeRouteAuditMock, authState };
});

vi.mock('../../services/accounting/accountingConnectionService', () => ({
  getConnection: getConnectionMock,
  upsertConnection: vi.fn(),
  deleteConnection: vi.fn(),
  updateHomeCurrency: vi.fn(),
  updateMultiCurrencyEnabled: vi.fn(),
  refreshRealmSettings: vi.fn(),
  AccountingConnectionError: class AccountingConnectionError extends Error {
    code: string;
    status: number;
    constructor(code: string, status: number, message: string) {
      super(message);
      this.code = code;
      this.status = status;
      this.name = 'AccountingConnectionError';
    }
  },
  isHomeCurrencyCasAbort: () => false,
}));

vi.mock('../../jobs/accountingReconcileWorker', () => ({
  enqueueAccountingReconcile: enqueueAccountingReconcileMock,
}));

// Not exercised by these tests, but imported transitively by routes/accounting/index.ts.
vi.mock('../../services/accounting/accountingInvoicePush', () => ({
  pushInvoiceToAccounting: vi.fn(),
  AccountingInvoicePushError: class AccountingInvoicePushError extends Error {},
}));

vi.mock('../../jobs/accountingSyncWorker', () => ({
  enqueueAccountingInvoicePush: vi.fn(),
}));

vi.mock('../../services/accounting/accountingMappingService', () => ({
  listMappingProposals: vi.fn(),
  listRemoteIncomeAccountsForPartner: vi.fn(),
  saveMappingDecision: vi.fn(),
  syncMappedEntity: vi.fn(),
  resolveConnectionAndToken: vi.fn(),
  AccountingMappingError: class AccountingMappingError extends Error {},
}));

vi.mock('../../services/accounting/providerRegistry', () => ({
  getAccountingProvider: vi.fn(),
}));

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

vi.mock('../../db', () => ({
  db: {},
  runOutsideDbContext: <T>(fn: () => T) => fn(),
  withSystemDbAccessContext: <T>(fn: () => T) => fn(),
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('auth', {
      scope: authState.scope,
      partnerId: authState.scope === 'organization' ? null : 'p1',
      user: { id: 'u1' },
    });
    await next();
  },
  requireScope: (...scopes: string[]) => async (c: any, next: any) => {
    if (!scopes.includes(authState.scope)) return c.json({ error: 'Insufficient permissions' }, 403);
    return next();
  },
  requireMfa: () => async (c: any, next: any) => {
    if (!authState.mfa) return c.json({ error: 'MFA required' }, 403);
    return next();
  },
  requirePermission: (resource: string, action: string) => async (c: any, next: any) => {
    if (!authState.permissions.has(`${resource}:${action}`)) return c.json({ error: 'Permission denied' }, 403);
    return next();
  },
  withAuthDbAccessContext: vi.fn(async (_auth: unknown, fn: () => unknown) => fn()),
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

function connectionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'c1',
    partnerId: 'p1',
    provider: 'quickbooks',
    pullPayments: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  authState.scope = 'partner';
  authState.permissions = new Set(['invoices:write']);
  authState.mfa = true;
});

describe('POST /accounting/:provider/reconcile', () => {
  function reconcile(query = '') {
    return app().request(`/accounting/quickbooks/reconcile${query}`, { method: 'POST' });
  }

  it('200 { enqueued: true } on the happy path, enqueues with trigger "manual", and audits', async () => {
    getConnectionMock.mockResolvedValue(connectionRow());
    enqueueAccountingReconcileMock.mockResolvedValue(true);

    const res = await reconcile();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enqueued: true });
    expect(enqueueAccountingReconcileMock).toHaveBeenCalledWith('c1', 'p1', 'manual');
    expect(writeRouteAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'accounting.reconcile.requested',
        resourceType: 'accounting_connection',
        details: expect.objectContaining({ provider: 'quickbooks', connectionId: 'c1', enqueued: true }),
      }),
    );
  });

  it('200 { enqueued: false } (not a 500) when the queue rejects the job, and the audit records it', async () => {
    getConnectionMock.mockResolvedValue(connectionRow());
    enqueueAccountingReconcileMock.mockResolvedValue(false);

    const res = await reconcile();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enqueued: false });
    expect(writeRouteAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        details: expect.objectContaining({ enqueued: false }),
      }),
    );
  });

  it('404 when there is no connection for this partner', async () => {
    getConnectionMock.mockResolvedValue(null);

    const res = await reconcile();

    expect(res.status).toBe(404);
    expect(enqueueAccountingReconcileMock).not.toHaveBeenCalled();
    expect(writeRouteAuditMock).not.toHaveBeenCalled();
  });

  it('denies an org-scoped token (403) before touching the connection', async () => {
    authState.scope = 'organization';

    const res = await reconcile();

    expect(res.status).toBe(403);
    expect(getConnectionMock).not.toHaveBeenCalled();
    expect(enqueueAccountingReconcileMock).not.toHaveBeenCalled();
  });

  it('requires MFA (403) before touching the connection', async () => {
    authState.mfa = false;

    const res = await reconcile();

    expect(res.status).toBe(403);
    expect(getConnectionMock).not.toHaveBeenCalled();
  });

  it('denies a partner-scoped caller without INVOICES_WRITE (403)', async () => {
    authState.permissions = new Set();

    const res = await reconcile();

    expect(res.status).toBe(403);
    expect(getConnectionMock).not.toHaveBeenCalled();
    expect(enqueueAccountingReconcileMock).not.toHaveBeenCalled();
  });

  it('allows a SYSTEM-scope caller that holds no per-partner role (bypasses the permission check)', async () => {
    authState.scope = 'system';
    authState.permissions = new Set();
    getConnectionMock.mockResolvedValue(connectionRow({ id: 'c2', partnerId: 'p9' }));
    enqueueAccountingReconcileMock.mockResolvedValue(true);

    const res = await reconcile('?partnerId=99999999-9999-4999-8999-999999999999');

    expect(res.status).toBe(200);
    expect(enqueueAccountingReconcileMock).toHaveBeenCalledWith('c2', '99999999-9999-4999-8999-999999999999', 'manual');
  });
});
