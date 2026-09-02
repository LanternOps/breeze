import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// Phase C, Task 5 (2026-09-01-quickbooks-phase-c-invoice-push) — manual/bulk
// invoice push, remote-candidate search, on routes/accounting/index.ts.
// Mirrors the mocking pattern established in mappings.test.ts: mock the
// service seams the routes call through, plus the auth middleware, and
// exercise only the three NEW routes here.
const {
  pushInvoiceToAccountingMock,
  enqueueAccountingInvoicePushMock,
  resolveConnectionAndTokenMock,
  listRemoteCustomersMock,
  listRemoteItemsMock,
  writeRouteAuditMock,
  selectMock,
  AccountingInvoicePushError,
  AccountingMappingError,
  authState,
} = vi.hoisted(() => {
  const pushInvoiceToAccountingMock = vi.fn();
  const enqueueAccountingInvoicePushMock = vi.fn();
  const resolveConnectionAndTokenMock = vi.fn();
  const listRemoteCustomersMock = vi.fn();
  const listRemoteItemsMock = vi.fn();
  const writeRouteAuditMock = vi.fn();
  const selectMock = vi.fn();
  class AccountingInvoicePushError extends Error {
    code: string;
    status: number;
    constructor(code: string, status: number, message: string) {
      super(message);
      this.code = code;
      this.status = status;
      this.name = 'AccountingInvoicePushError';
    }
  }
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
    scope: 'partner' as 'partner' | 'system' | 'organization',
    permissions: new Set<string>(['invoices:write']),
    mfa: true,
  };
  return {
    pushInvoiceToAccountingMock,
    enqueueAccountingInvoicePushMock,
    resolveConnectionAndTokenMock,
    listRemoteCustomersMock,
    listRemoteItemsMock,
    writeRouteAuditMock,
    selectMock,
    AccountingInvoicePushError,
    AccountingMappingError,
    authState,
  };
});

vi.mock('../../services/accounting/accountingInvoicePush', () => ({
  pushInvoiceToAccounting: pushInvoiceToAccountingMock,
  AccountingInvoicePushError,
}));

vi.mock('../../jobs/accountingSyncWorker', () => ({
  enqueueAccountingInvoicePush: enqueueAccountingInvoicePushMock,
}));

vi.mock('../../services/accounting/accountingMappingService', () => ({
  listMappingProposals: vi.fn(),
  listRemoteIncomeAccountsForPartner: vi.fn(),
  saveMappingDecision: vi.fn(),
  syncMappedEntity: vi.fn(),
  resolveConnectionAndToken: resolveConnectionAndTokenMock,
  AccountingMappingError,
}));

vi.mock('../../services/accounting/providerRegistry', () => ({
  getAccountingProvider: vi.fn(() => ({
    listRemoteCustomers: listRemoteCustomersMock,
    listRemoteItems: listRemoteItemsMock,
  })),
}));

// Not exercised by these tests, but imported transitively by routes/accounting/index.ts.
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
  db: {
    select: selectMock,
  },
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
  // withAuthDbAccessContext is the "real" seam under test for the two
  // QuickBooks-HTTP routes (push, remote-candidates): assert it was CALLED
  // (not just that its `fn` ran) so a route that dropped the wrap wouldn't
  // slip through as a false green.
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
import { withAuthDbAccessContext } from '../../middleware/auth';

/**
 * The routes no longer WRAP the service call in `withAuthDbAccessContext` —
 * that held the request transaction across every QuickBooks HTTP call and
 * rolled back the coordinator's sync-state writes. They hand the service a
 * `runInDbContext` runner it re-enters per phase instead. This asserts the
 * seam is genuinely wired: the runner really delegates to
 * `withAuthDbAccessContext` with this request's auth, rather than being an
 * identity passthrough that would leave every phase contextless.
 */
async function expectAuthContextRunner(runner: unknown): Promise<void> {
  expect(typeof runner).toBe('function');
  vi.mocked(withAuthDbAccessContext).mockClear();
  await (runner as <T>(fn: () => Promise<T>) => Promise<T>)(async () => 'phase');
  expect(withAuthDbAccessContext).toHaveBeenCalledTimes(1);
  expect(withAuthDbAccessContext).toHaveBeenCalledWith(
    expect.objectContaining({ partnerId: 'p1' }),
    expect.any(Function),
  );
}

function app() {
  const a = new Hono();
  a.route('/accounting', accountingRoutes);
  return a;
}

const INVOICE_ID = '11111111-1111-4111-8111-111111111111';
const INVOICE_ID_2 = '22222222-2222-4222-8222-222222222222';
const INVOICE_ID_FOREIGN = '33333333-3333-4333-8333-333333333333';
const OTHER_PARTNER_ID = '99999999-9999-4999-8999-999999999999';

function pushOutcome(overrides: Record<string, unknown> = {}) {
  return {
    mappingId: 'map-1',
    remoteEntityId: 'qb-inv-1',
    docNumber: '1042',
    syncStatus: 'synced',
    taxVarianceCents: 0,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  authState.scope = 'partner';
  authState.permissions = new Set(['invoices:write']);
  authState.mfa = true;
  // The enqueue helper reports whether the queue ACCEPTED the job; the bulk
  // route counts on that, so the default must be a real acceptance.
  enqueueAccountingInvoicePushMock.mockResolvedValue(true);
});

describe('POST /accounting/:provider/invoices/:invoiceId/push', () => {
  function pushInvoice(invoiceId = INVOICE_ID, query = '') {
    return app().request(`/accounting/quickbooks/invoices/${invoiceId}/push${query}`, { method: 'POST' });
  }

  it('200 happy path: calls the coordinator inside withAuthDbAccessContext and audits', async () => {
    pushInvoiceToAccountingMock.mockResolvedValue(pushOutcome());
    const res = await pushInvoice();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ syncStatus: 'synced', docNumber: '1042', taxVarianceCents: 0 });
    expect(pushInvoiceToAccountingMock).toHaveBeenCalledWith(INVOICE_ID, 'p1', expect.any(Function));
    await expectAuthContextRunner(pushInvoiceToAccountingMock.mock.calls[0]![2]);
    expect(writeRouteAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'accounting.invoice.push',
        resourceType: 'accounting_mapping',
        resourceId: 'map-1',
        details: expect.objectContaining({ invoiceId: INVOICE_ID, syncStatus: 'synced', docNumber: '1042' }),
      }),
    );
  });

  it('409 pass-through: AccountingInvoicePushError status + code are preserved', async () => {
    pushInvoiceToAccountingMock.mockRejectedValue(new AccountingInvoicePushError('reauth_required', 409, 'QuickBooks needs to be reconnected'));
    const res = await pushInvoice();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'reauth_required', message: 'QuickBooks needs to be reconnected' });
    expect(writeRouteAuditMock).not.toHaveBeenCalled();
  });

  it('404 pass-through: an unpushable/unknown invoice preserves its code', async () => {
    pushInvoiceToAccountingMock.mockRejectedValue(new AccountingInvoicePushError('invoice_not_pushable', 404, 'Invoice not found for this partner'));
    const res = await pushInvoice();
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'invoice_not_pushable' });
  });

  it('502 pass-through for a genuine QuickBooks failure', async () => {
    pushInvoiceToAccountingMock.mockRejectedValue(new AccountingInvoicePushError('quickbooks_error', 502, 'QuickBooks returned an error'));
    const res = await pushInvoice();
    expect(res.status).toBe(502);
  });

  it('requires MFA (403) before calling the coordinator', async () => {
    authState.mfa = false;
    const res = await pushInvoice();
    expect(res.status).toBe(403);
    expect(pushInvoiceToAccountingMock).not.toHaveBeenCalled();
  });

  it('denies an org-scoped token (403) before calling the coordinator', async () => {
    authState.scope = 'organization';
    const res = await pushInvoice();
    expect(res.status).toBe(403);
    expect(pushInvoiceToAccountingMock).not.toHaveBeenCalled();
  });

  it('denies a partner-scoped caller without INVOICES_WRITE (403) before calling the coordinator', async () => {
    authState.permissions = new Set();
    const res = await pushInvoice();
    expect(res.status).toBe(403);
    expect(pushInvoiceToAccountingMock).not.toHaveBeenCalled();
  });

  it('allows a SYSTEM-scope caller that holds no per-partner role (bypasses the permission check)', async () => {
    authState.scope = 'system';
    authState.permissions = new Set();
    pushInvoiceToAccountingMock.mockResolvedValue(pushOutcome());
    const res = await pushInvoice(INVOICE_ID, `?partnerId=${OTHER_PARTNER_ID}`);
    expect(res.status).toBe(200);
    expect(pushInvoiceToAccountingMock).toHaveBeenCalledWith(INVOICE_ID, OTHER_PARTNER_ID, expect.any(Function));
  });

  it('system scope without an explicit partnerId is rejected (400) before calling the coordinator', async () => {
    authState.scope = 'system';
    const res = await pushInvoice();
    expect(res.status).toBe(400);
    expect(pushInvoiceToAccountingMock).not.toHaveBeenCalled();
  });

  it('partner scope cannot request another partner (403) before calling the coordinator', async () => {
    const res = await pushInvoice(INVOICE_ID, `?partnerId=${OTHER_PARTNER_ID}`);
    expect(res.status).toBe(403);
    expect(pushInvoiceToAccountingMock).not.toHaveBeenCalled();
  });

  it('rejects a non-guid invoiceId (400) before calling the coordinator', async () => {
    const res = await pushInvoice('not-a-guid');
    expect(res.status).toBe(400);
    expect(pushInvoiceToAccountingMock).not.toHaveBeenCalled();
  });
});

describe('POST /accounting/:provider/invoices/push-bulk', () => {
  function pushBulk(invoiceIds: unknown, query = '') {
    return app().request(`/accounting/quickbooks/invoices/push-bulk${query}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ invoiceIds }),
    });
  }

  it('enqueues only invoices owned by this partner; a foreign id lands in skipped', async () => {
    selectMock.mockReturnValue({
      from: () => ({
        where: () => Promise.resolve([{ id: INVOICE_ID }, { id: INVOICE_ID_2 }]),
      }),
    });
    const res = await pushBulk([INVOICE_ID, INVOICE_ID_2, INVOICE_ID_FOREIGN]);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enqueued: 2, skipped: 1, failed: 0 });
    expect(enqueueAccountingInvoicePushMock).toHaveBeenCalledTimes(2);
    expect(enqueueAccountingInvoicePushMock).toHaveBeenCalledWith(INVOICE_ID, 'p1');
    expect(enqueueAccountingInvoicePushMock).toHaveBeenCalledWith(INVOICE_ID_2, 'p1');
    expect(enqueueAccountingInvoicePushMock).not.toHaveBeenCalledWith(INVOICE_ID_FOREIGN, 'p1');
    expect(writeRouteAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'accounting.invoice.push_bulk',
        details: expect.objectContaining({ requested: 3, enqueued: 2, skipped: 1, failed: 0 }),
      }),
    );
  });

  it('counts a swallowed enqueue failure as `failed`, never as `enqueued`', async () => {
    // `enqueueAccountingInvoicePush` never throws (a Redis outage must not fail
    // the request), so the ONLY signal that nothing was queued is its boolean.
    // Counting every owned id as enqueued told the operator the work was
    // queued when the queue had rejected all of it.
    selectMock.mockReturnValue({
      from: () => ({ where: () => Promise.resolve([{ id: INVOICE_ID }, { id: INVOICE_ID_2 }]) }),
    });
    enqueueAccountingInvoicePushMock.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    const res = await pushBulk([INVOICE_ID, INVOICE_ID_2, INVOICE_ID_FOREIGN]);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enqueued: 1, skipped: 1, failed: 1 });
    expect(writeRouteAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        details: expect.objectContaining({ requested: 3, enqueued: 1, skipped: 1, failed: 1 }),
      }),
    );
  });

  it('rejects more than 100 invoiceIds (400) before touching the DB or enqueueing', async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `${String(i).padStart(8, '0')}-1111-4111-8111-111111111111`);
    const res = await pushBulk(ids);
    expect(res.status).toBe(400);
    expect(selectMock).not.toHaveBeenCalled();
    expect(enqueueAccountingInvoicePushMock).not.toHaveBeenCalled();
  });

  it('rejects an empty invoiceIds array (400)', async () => {
    const res = await pushBulk([]);
    expect(res.status).toBe(400);
    expect(enqueueAccountingInvoicePushMock).not.toHaveBeenCalled();
  });

  it('requires MFA (403) before touching the DB', async () => {
    authState.mfa = false;
    const res = await pushBulk([INVOICE_ID]);
    expect(res.status).toBe(403);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('denies a partner-scoped caller without INVOICES_WRITE (403)', async () => {
    authState.permissions = new Set();
    const res = await pushBulk([INVOICE_ID]);
    expect(res.status).toBe(403);
    expect(enqueueAccountingInvoicePushMock).not.toHaveBeenCalled();
  });

  it('allows a SYSTEM-scope caller that holds no per-partner role', async () => {
    authState.scope = 'system';
    authState.permissions = new Set();
    selectMock.mockReturnValue({
      from: () => ({ where: () => Promise.resolve([{ id: INVOICE_ID }]) }),
    });
    const res = await pushBulk([INVOICE_ID], `?partnerId=${OTHER_PARTNER_ID}`);
    expect(res.status).toBe(200);
    expect(enqueueAccountingInvoicePushMock).toHaveBeenCalledWith(INVOICE_ID, OTHER_PARTNER_ID);
  });
});

describe('GET /accounting/:provider/remote-candidates', () => {
  function getCandidates(query: string) {
    return app().request(`/accounting/quickbooks/remote-candidates${query}`);
  }

  it('threads the query through to listRemoteCustomers for entityType=org', async () => {
    resolveConnectionAndTokenMock.mockResolvedValue({ conn: { provider: 'quickbooks' }, liveConn: { accessToken: 'tok' } });
    listRemoteCustomersMock.mockResolvedValue([
      { id: 'qb-1', displayName: 'Acme', email: 'billing@acme.test', currencyCode: 'USD', syncToken: '0' },
    ]);
    const res = await getCandidates('?entityType=org&q=Acme');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [{ id: 'qb-1', displayName: 'Acme', email: 'billing@acme.test', currencyCode: 'USD' }] });
    expect(resolveConnectionAndTokenMock).toHaveBeenCalledWith('p1', 'quickbooks', expect.any(Function));
    await expectAuthContextRunner(resolveConnectionAndTokenMock.mock.calls[0]![2]);
    expect(listRemoteCustomersMock).toHaveBeenCalledWith({ accessToken: 'tok' }, 'Acme');
    expect(listRemoteItemsMock).not.toHaveBeenCalled();
  });

  it('threads the query through to listRemoteItems for entityType=catalog_item', async () => {
    resolveConnectionAndTokenMock.mockResolvedValue({ conn: { provider: 'quickbooks' }, liveConn: { accessToken: 'tok' } });
    listRemoteItemsMock.mockResolvedValue([{ id: 'qb-item-1', displayName: 'Widget', sku: 'W-1', syncToken: '0' }]);
    const res = await getCandidates('?entityType=catalog_item&q=Widget');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [{ id: 'qb-item-1', displayName: 'Widget', sku: 'W-1' }] });
    expect(listRemoteItemsMock).toHaveBeenCalledWith({ accessToken: 'tok' }, 'Widget');
    expect(listRemoteCustomersMock).not.toHaveBeenCalled();
  });

  it('works with no q (optional)', async () => {
    resolveConnectionAndTokenMock.mockResolvedValue({ conn: { provider: 'quickbooks' }, liveConn: { accessToken: 'tok' } });
    listRemoteCustomersMock.mockResolvedValue([]);
    const res = await getCandidates('?entityType=org');
    expect(res.status).toBe(200);
    expect(listRemoteCustomersMock).toHaveBeenCalledWith({ accessToken: 'tok' }, undefined);
  });

  it('maps a reauth_required AccountingMappingError to 409', async () => {
    resolveConnectionAndTokenMock.mockRejectedValue(new AccountingMappingError('reauth_required', 409, 'QuickBooks needs to be reconnected'));
    const res = await getCandidates('?entityType=org&q=Acme');
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'reauth_required' });
    expect(listRemoteCustomersMock).not.toHaveBeenCalled();
  });

  it('maps a not_connected AccountingMappingError to 404', async () => {
    resolveConnectionAndTokenMock.mockRejectedValue(new AccountingMappingError('not_connected', 404, 'QuickBooks is not connected for this partner'));
    const res = await getCandidates('?entityType=org');
    expect(res.status).toBe(404);
  });

  it('rejects a missing/invalid entityType (400) before calling the service', async () => {
    const res = await getCandidates('');
    expect(res.status).toBe(400);
    expect(resolveConnectionAndTokenMock).not.toHaveBeenCalled();
  });

  it('is read-only: no MFA/permission gate blocks a plain partner-scoped caller', async () => {
    authState.permissions = new Set();
    resolveConnectionAndTokenMock.mockResolvedValue({ conn: { provider: 'quickbooks' }, liveConn: { accessToken: 'tok' } });
    listRemoteCustomersMock.mockResolvedValue([]);
    const res = await getCandidates('?entityType=org');
    expect(res.status).toBe(200);
  });

  it('partner scope cannot request another partner (403) before calling the service', async () => {
    const res = await getCandidates(`?entityType=org&partnerId=${OTHER_PARTNER_ID}`);
    expect(res.status).toBe(403);
    expect(resolveConnectionAndTokenMock).not.toHaveBeenCalled();
  });
});
