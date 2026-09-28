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
  // Mirrors the real 4-arg signature (status includes 429; opts.retryAfterMs).
  class AccountingInvoicePushError extends Error {
    code: string;
    status: 404 | 409 | 429 | 502;
    retryAfterMs?: number;
    constructor(code: string, status: 404 | 409 | 429 | 502, message: string, opts: { retryAfterMs?: number } = {}) {
      super(message);
      this.code = code;
      this.status = status;
      this.retryAfterMs = opts.retryAfterMs;
      this.name = 'AccountingInvoicePushError';
    }
  }
  // Mirrors the real 4-arg signature (status includes 429; opts.retryAfterMs).
  class AccountingMappingError extends Error {
    code: string;
    status: 404 | 409 | 429 | 502;
    retryAfterMs?: number;
    constructor(code: string, status: 404 | 409 | 429 | 502, message: string, opts: { retryAfterMs?: number } = {}) {
      super(message);
      this.code = code;
      this.status = status;
      this.retryAfterMs = opts.retryAfterMs;
      this.name = 'AccountingMappingError';
    }
  }
  const authState = {
    scope: 'partner' as 'partner' | 'system' | 'organization',
    partnerOrgAccess: 'all' as 'all' | 'selected' | 'none' | null,
    permissions: new Set<string>(['accounting:read', 'accounting:manage', 'invoices:write']),
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
  enqueueAccountingMappingSync: vi.fn().mockResolvedValue(true),
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
  // Only QuickBooks is a registered provider today (Xero W01 capability gate).
  providerSupports: (id: string, cap: string) => providerSupportsMock(id, cap),
  accountingProviderDisplayName: (id: string) => (id === 'quickbooks' ? 'QuickBooks' : `UNKNOWN_PROVIDER:${id}`),
  // Xero W01 route gate: only QuickBooks is registered, configured and capable.
  findAccountingProvider: (id: string) => (id === 'quickbooks'
    ? { provider: 'quickbooks', displayName: 'QuickBooks', configError: () => null } : null),
}));

// Xero W01: push-bulk resolves the partner's ONE connection before enqueueing
// (each job carries its id). Defaults to a connected QuickBooks row so the
// existing bulk tests drive exactly the path they always did.
const { resolveActiveConnectionRefMock, providerSupportsMock } = vi.hoisted(() => ({
  resolveActiveConnectionRefMock: vi.fn(),
  providerSupportsMock: vi.fn(),
}));
// Honours the capability argument (QuickBooks supports everything) so the
// per-route capability table can deny exactly one capability.
const defaultProviderSupports = (id: string, _cap: string) => id === 'quickbooks';
vi.mock('../../services/accounting/accountingConnectionService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/accounting/accountingConnectionService')>()),
  resolveActiveConnectionRef: resolveActiveConnectionRefMock,
}));

// Not exercised by these tests, but imported transitively by routes/accounting/index.ts.
vi.mock('../../services/accounting/accountingCustomerImport', () => ({
  listAccountingCustomersAnnotated: vi.fn(),
  importAccountingCustomers: vi.fn(),
  AccountingImportError: class AccountingImportError extends Error {
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
      partnerOrgAccess: authState.partnerOrgAccess,
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

import { accountingRoutes } from './index';
import { AccountingProviderError } from '../../services/accounting/accountingProviderError';
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
    totalVarianceCents: 5000,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveActiveConnectionRefMock.mockResolvedValue({ id: 'c1', partnerId: 'p1', provider: 'quickbooks', status: 'connected' });
  authState.scope = 'partner';
  authState.permissions = new Set(['accounting:read', 'accounting:manage', 'invoices:write']);
  authState.mfa = true;
  // The enqueue helper reports whether the queue ACCEPTED the job; the bulk
  // route counts on that, so the default must be a real acceptance.
  enqueueAccountingInvoicePushMock.mockResolvedValue(true);
  providerSupportsMock.mockImplementation(defaultProviderSupports);
});

// Xero W01 review: pin the capability EACH route in this file gates on (plan
// Task 15, "Route -> capability map"). The provider is registered and
// configured but lacks exactly that capability: the route must answer 409
// capability_unavailable and must have asked for that exact capability.
describe('per-route capability gate (Xero W01)', () => {
  it.each([
    ['POST /:provider/invoices/:invoiceId/push', 'invoicePush', `/accounting/quickbooks/invoices/${INVOICE_ID}/push`, { method: 'POST' }],
    ['POST /:provider/invoices/push-bulk', 'invoicePush', '/accounting/quickbooks/invoices/push-bulk', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ invoiceIds: [INVOICE_ID] }),
    }],
    ['GET /:provider/remote-candidates', 'mapping', '/accounting/quickbooks/remote-candidates?entityType=org&q=Acme', undefined],
  ] as const)('%s answers 409 capability_unavailable without %s', async (_route, capability, url, init) => {
    providerSupportsMock.mockImplementation((id: string, cap: string) => defaultProviderSupports(id, cap) && cap !== capability);
    const res = await app().request(url, init);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'capability_unavailable' });
    expect(providerSupportsMock).toHaveBeenCalledWith('quickbooks', capability);
    // The route's gate is the FIRST capability check (push-bulk re-checks
    // invoicePush on the connection afterwards, which must not mask the gate).
    expect(providerSupportsMock).toHaveBeenNthCalledWith(1, 'quickbooks', capability);
    expect(pushInvoiceToAccountingMock).not.toHaveBeenCalled();
    expect(enqueueAccountingInvoicePushMock).not.toHaveBeenCalled();
    expect(resolveConnectionAndTokenMock).not.toHaveBeenCalled();
  });
});

describe('POST /accounting/:provider/invoices/:invoiceId/push', () => {
  function pushInvoice(invoiceId = INVOICE_ID, query = '') {
    return app().request(`/accounting/quickbooks/invoices/${invoiceId}/push${query}`, { method: 'POST' });
  }

  it('200 happy path: calls the coordinator inside withAuthDbAccessContext and audits', async () => {
    pushInvoiceToAccountingMock.mockResolvedValue(pushOutcome());
    const res = await pushInvoice();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ syncStatus: 'synced', docNumber: '1042', taxVarianceCents: 0, totalVarianceCents: 5000 });
    // The URL's :provider is the push target (Xero W01): never "whatever is connected now".
    expect(pushInvoiceToAccountingMock).toHaveBeenCalledWith(INVOICE_ID, 'p1', expect.any(Function), { provider: 'quickbooks' });
    await expectAuthContextRunner(pushInvoiceToAccountingMock.mock.calls[0]![2]);
    expect(writeRouteAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'accounting.invoice.push',
        resourceType: 'accounting_mapping',
        resourceId: 'map-1',
        details: expect.objectContaining({ invoiceId: INVOICE_ID, syncStatus: 'synced', docNumber: '1042', totalVarianceCents: 5000 }),
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

  // #4544: a mapping row carrying the remote-deleted marker must reject the
  // push with a stable 409 code, not a generic/quickbooks-flavored error the
  // web layer would have to guess at.
  it('409 pass-through: remote_deleted (invoice deleted/voided in QuickBooks) is never a silent no-op or a generic error', async () => {
    pushInvoiceToAccountingMock.mockRejectedValue(
      new AccountingInvoicePushError('remote_deleted', 409, 'QuickBooks reports this invoice as deleted — pushing again would create a duplicate.'),
    );
    const res = await pushInvoice();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'remote_deleted',
      message: 'QuickBooks reports this invoice as deleted — pushing again would create a duplicate.',
    });
    expect(writeRouteAuditMock).not.toHaveBeenCalled();
  });

  it('404 pass-through: an unpushable/unknown invoice preserves its code', async () => {
    pushInvoiceToAccountingMock.mockRejectedValue(new AccountingInvoicePushError('invoice_not_pushable', 404, 'Invoice not found for this partner'));
    const res = await pushInvoice();
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'invoice_not_pushable' });
  });

  it('502 pass-through for a genuine QuickBooks failure', async () => {
    pushInvoiceToAccountingMock.mockRejectedValue(new AccountingInvoicePushError('provider_error', 502, 'QuickBooks returned an error'));
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
    authState.permissions = new Set(['accounting:read', 'accounting:manage']);
    const res = await pushInvoice();
    expect(res.status).toBe(403);
    expect(pushInvoiceToAccountingMock).not.toHaveBeenCalled();
  });

  it('allows a SYSTEM-scope caller that holds no per-partner role (bypasses the permission check)', async () => {
    authState.scope = 'system';
    authState.permissions = new Set(['accounting:read', 'accounting:manage']);
    pushInvoiceToAccountingMock.mockResolvedValue(pushOutcome());
    const res = await pushInvoice(INVOICE_ID, `?partnerId=${OTHER_PARTNER_ID}`);
    expect(res.status).toBe(200);
    expect(pushInvoiceToAccountingMock).toHaveBeenCalledWith(INVOICE_ID, OTHER_PARTNER_ID, expect.any(Function), { provider: 'quickbooks' });
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
    // #7251: every bulk job carries the operator marker — the worker's
    // pushMode gate drops unmarked (automatic) jobs in manual mode, which made
    // bulk push a silent no-op in exactly the mode that needs it.
    expect(enqueueAccountingInvoicePushMock).toHaveBeenCalledWith(INVOICE_ID, 'p1', 'c1', { requestedBy: 'operator' });
    expect(enqueueAccountingInvoicePushMock).toHaveBeenCalledWith(INVOICE_ID_2, 'p1', 'c1', { requestedBy: 'operator' });
    expect(enqueueAccountingInvoicePushMock).not.toHaveBeenCalledWith(INVOICE_ID_FOREIGN, 'p1', 'c1', expect.anything());
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
    authState.permissions = new Set(['accounting:read', 'accounting:manage']);
    const res = await pushBulk([INVOICE_ID]);
    expect(res.status).toBe(403);
    expect(enqueueAccountingInvoicePushMock).not.toHaveBeenCalled();
  });

  it('allows a SYSTEM-scope caller that holds no per-partner role', async () => {
    authState.scope = 'system';
    authState.permissions = new Set(['accounting:read', 'accounting:manage']);
    selectMock.mockReturnValue({
      from: () => ({ where: () => Promise.resolve([{ id: INVOICE_ID }]) }),
    });
    const res = await pushBulk([INVOICE_ID], `?partnerId=${OTHER_PARTNER_ID}`);
    expect(res.status).toBe(200);
    expect(enqueueAccountingInvoicePushMock).toHaveBeenCalledWith(INVOICE_ID, OTHER_PARTNER_ID, 'c1', { requestedBy: 'operator' });
  });

  // Xero W01 capability gate (spec: routes return 409 capability_unavailable).
  it('resolves the partner connection ONCE per request and stamps its id on every job', async () => {
    selectMock.mockReturnValue({
      from: () => ({ where: () => Promise.resolve([{ id: INVOICE_ID }, { id: INVOICE_ID_2 }]) }),
    });
    const res = await pushBulk([INVOICE_ID, INVOICE_ID_2]);
    expect(res.status).toBe(200);
    expect(resolveActiveConnectionRefMock).toHaveBeenCalledTimes(1);
    expect(resolveActiveConnectionRefMock).toHaveBeenCalledWith(expect.anything(), 'p1');
    expect(enqueueAccountingInvoicePushMock.mock.calls.map((call) => call[2])).toEqual(['c1', 'c1']);
  });

  it('409 capability_unavailable when the connected provider is not the one in the URL', async () => {
    resolveActiveConnectionRefMock.mockResolvedValue({ id: 'c-x', partnerId: 'p1', provider: 'xero', status: 'connected' });
    selectMock.mockReturnValue({ from: () => ({ where: () => Promise.resolve([{ id: INVOICE_ID }]) }) });
    const res = await pushBulk([INVOICE_ID]);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'capability_unavailable' });
    expect(enqueueAccountingInvoicePushMock).not.toHaveBeenCalled();
  });

  it('409 capability_unavailable when the connected provider cannot push invoices', async () => {
    providerSupportsMock.mockReturnValueOnce(false);
    selectMock.mockReturnValue({ from: () => ({ where: () => Promise.resolve([{ id: INVOICE_ID }]) }) });
    const res = await pushBulk([INVOICE_ID]);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'capability_unavailable' });
    expect(providerSupportsMock).toHaveBeenCalledWith('quickbooks', 'invoicePush');
    expect(enqueueAccountingInvoicePushMock).not.toHaveBeenCalled();
  });

  it('with NO connection at all keeps the 200 response shape and enqueues nothing (every owned id is skipped)', async () => {
    resolveActiveConnectionRefMock.mockResolvedValue(null);
    selectMock.mockReturnValue({
      from: () => ({ where: () => Promise.resolve([{ id: INVOICE_ID }, { id: INVOICE_ID_2 }]) }),
    });
    const res = await pushBulk([INVOICE_ID, INVOICE_ID_2, INVOICE_ID_FOREIGN]);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enqueued: 0, skipped: 3, failed: 0 });
    expect(enqueueAccountingInvoicePushMock).not.toHaveBeenCalled();
  });
});

describe('GET /accounting/:provider/remote-candidates', () => {
  function getCandidates(query: string) {
    return app().request(`/accounting/quickbooks/remote-candidates${query}`);
  }

  it('threads the query through to listRemoteCustomers for entityType=org', async () => {
    resolveConnectionAndTokenMock.mockResolvedValue({ conn: { provider: 'quickbooks' }, liveConn: { accessToken: 'tok' } });
    listRemoteCustomersMock.mockResolvedValue([
      { id: 'qb-1', displayName: 'Acme', email: 'billing@acme.test', currencyCode: 'USD', remoteVersion: '0' },
    ]);
    const res = await getCandidates('?entityType=org&q=Acme');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [{ id: 'qb-1', displayName: 'Acme', email: 'billing@acme.test', currencyCode: 'USD' }] });
    // Xero W01: the route's :provider is the connection target.
    expect(resolveConnectionAndTokenMock).toHaveBeenCalledWith('p1', { provider: 'quickbooks' }, expect.any(Function));
    await expectAuthContextRunner(resolveConnectionAndTokenMock.mock.calls[0]![2]);
    expect(listRemoteCustomersMock).toHaveBeenCalledWith({ accessToken: 'tok' }, 'Acme');
    expect(listRemoteItemsMock).not.toHaveBeenCalled();
  });

  it('threads the query through to listRemoteItems for entityType=catalog_item', async () => {
    resolveConnectionAndTokenMock.mockResolvedValue({ conn: { provider: 'quickbooks' }, liveConn: { accessToken: 'tok' } });
    listRemoteItemsMock.mockResolvedValue([{ id: 'qb-item-1', displayName: 'Widget', sku: 'W-1', remoteVersion: '0' }]);
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
    authState.permissions = new Set(['accounting:read', 'accounting:manage']);
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

// Xero W01 Task 14: a throttled call answers 429 with Retry-After (whole
// seconds, rounded up) instead of 502/500.
describe('rate limiting answers 429 with Retry-After (Xero W01)', () => {
  it('a throttled manual push answers 429 with Retry-After', async () => {
    pushInvoiceToAccountingMock.mockRejectedValue(
      new AccountingInvoicePushError('rate_limited', 429, 'QuickBooks is rate limiting requests; push again if this does not clear shortly', { retryAfterMs: 30_000 }),
    );
    const res = await app().request(`/accounting/quickbooks/invoices/${INVOICE_ID}/push`, { method: 'POST' });
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('30');
    // The invoice-push body shape is `{ error: code, message }` (unchanged).
    expect(await res.json()).toEqual({ error: 'rate_limited', message: 'QuickBooks is rate limiting requests; push again if this does not clear shortly' });
    expect(writeRouteAuditMock).not.toHaveBeenCalled();
  });

  it('rounds a sub-second Retry-After UP, never to 0', async () => {
    pushInvoiceToAccountingMock.mockRejectedValue(new AccountingInvoicePushError('rate_limited', 429, 'throttled', { retryAfterMs: 1_200 }));
    const res = await app().request(`/accounting/quickbooks/invoices/${INVOICE_ID}/push`, { method: 'POST' });
    expect(res.headers.get('Retry-After')).toBe('2');
  });

  it('a non-throttle error carries no Retry-After', async () => {
    pushInvoiceToAccountingMock.mockRejectedValue(new AccountingInvoicePushError('provider_error', 502, 'QuickBooks returned an error'));
    const res = await app().request(`/accounting/quickbooks/invoices/${INVOICE_ID}/push`, { method: 'POST' });
    expect(res.status).toBe(502);
    expect(res.headers.get('Retry-After')).toBeNull();
  });

  it('a throttled token refresh on remote-candidates answers 429 with Retry-After (mapping error shape)', async () => {
    resolveConnectionAndTokenMock.mockRejectedValue(new AccountingMappingError('rate_limited', 429, 'QuickBooks is rate limiting requests; try again shortly', { retryAfterMs: 60_000 }));
    const res = await app().request('/accounting/quickbooks/remote-candidates?entityType=org');
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('60');
    expect(await res.json()).toEqual({ error: 'QuickBooks is rate limiting requests; try again shortly', code: 'rate_limited' });
  });

  it('a RAW provider throttle from the direct remote-candidates call answers 429, not a 500', async () => {
    resolveConnectionAndTokenMock.mockResolvedValue({ conn: { provider: 'quickbooks' }, liveConn: { accessToken: 'tok' } });
    listRemoteCustomersMock.mockRejectedValue(new AccountingProviderError({
      kind: 'rate_limited', provider: 'quickbooks', operation: 'QuickBooks customer query', httpStatus: 429, retryAfterMs: 5_000,
    }));
    const res = await app().request('/accounting/quickbooks/remote-candidates?entityType=org&q=Acme');
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('5');
    expect(await res.json()).toEqual({ error: 'QuickBooks is rate limiting requests; try again shortly', code: 'rate_limited' });
  });

  it.each([
    ['local', 'Breeze is pacing requests to QuickBooks; try again shortly'],
    ['limiter_unavailable', 'Breeze could not reach its rate limiter; try again shortly'],
  ] as const)('a RAW %s throttle on remote-candidates is worded as Breeze\'s, never the provider\'s (F1)', async (throttleSource, error) => {
    resolveConnectionAndTokenMock.mockResolvedValue({ conn: { provider: 'quickbooks' }, liveConn: { accessToken: 'tok' } });
    listRemoteCustomersMock.mockRejectedValue(new AccountingProviderError({
      kind: 'rate_limited', provider: 'quickbooks', operation: 'accounting call slot (per connection)', retryAfterMs: 5_000, throttleSource,
    }));
    const res = await app().request('/accounting/quickbooks/remote-candidates?entityType=org&q=Acme');
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('5');
    expect(await res.json()).toEqual({ error, code: 'rate_limited' });
  });
});
