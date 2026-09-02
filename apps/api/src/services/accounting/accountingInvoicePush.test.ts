import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Guarded invoice-push coordinator (Phase C, Task 3 —
 * .superpowers/sdd/2026-09-01-quickbooks-phase-c-invoice-push/task-3-brief.md).
 *
 * Mirrors the mocking pattern in accountingMappingService.test.ts: mock `db`,
 * `resolveConnectionAndToken`/`syncMappedEntity` (accountingMappingService),
 * the provider registry, and Sentry, then exercise the real coordinator logic
 * against those mocks.
 */
const {
  selectMock,
  insertMock,
  updateMock,
  resolveConnectionMock,
  resolveLiveConnectionMock,
  syncMappedEntityMock,
  enqueueAccountingInvoiceVoidMock,
  pushInvoiceMock,
  voidInvoiceMock,
  captureExceptionMock,
  AccountingMappingError,
} = vi.hoisted(() => {
  class AccountingMappingError extends Error {
    constructor(
      public readonly code: string,
      public readonly status: 404 | 409 | 502,
      message: string,
    ) {
      super(message);
      this.name = 'AccountingMappingError';
    }
  }
  return {
    selectMock: vi.fn(),
    insertMock: vi.fn(),
    updateMock: vi.fn(),
    resolveConnectionMock: vi.fn(),
    resolveLiveConnectionMock: vi.fn(),
    syncMappedEntityMock: vi.fn(),
    enqueueAccountingInvoiceVoidMock: vi.fn(),
    pushInvoiceMock: vi.fn(),
    voidInvoiceMock: vi.fn(),
    captureExceptionMock: vi.fn(),
    AccountingMappingError,
  };
});

vi.mock('../../db', () => ({
  db: { select: selectMock, insert: insertMock, update: updateMock },
  hasDbAccessContext: () => ctx.depth > 0,
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));

vi.mock('./accountingMappingService', () => ({
  resolveConnection: resolveConnectionMock,
  resolveLiveConnection: resolveLiveConnectionMock,
  syncMappedEntity: syncMappedEntityMock,
  AccountingMappingError,
}));

vi.mock('../../jobs/accountingSyncWorker', () => ({
  enqueueAccountingInvoiceVoid: enqueueAccountingInvoiceVoidMock,
}));

/**
 * Stands in for the real AsyncLocalStorage context stack. `runCtx` is the
 * `DbContextRunner` the coordinator now takes; it logs enter/exit and tracks
 * depth so a test can prove each DB phase ran in its own short context and
 * that nothing was held across a QuickBooks call. The db mock's
 * `hasDbAccessContext` reads the same depth, so the real (unmocked)
 * `dbContextGuard.assertNoAmbientDbContext` runs its real logic.
 */
const ctx = vi.hoisted(() => ({ depth: 0, events: [] as string[] }));
const runCtx = async <T>(fn: () => Promise<T>): Promise<T> => {
  ctx.depth++;
  ctx.events.push('ctx:enter');
  try {
    return await fn();
  } finally {
    ctx.events.push('ctx:exit');
    ctx.depth--;
  }
};

vi.mock('./providerRegistry', () => ({
  getAccountingProvider: () => ({
    pushInvoice: pushInvoiceMock,
    voidInvoice: voidInvoiceMock,
  }),
}));

vi.mock('../sentry', () => ({ captureException: captureExceptionMock }));

import { invoices, invoiceLines, accountingEntityMappings } from '../../db/schema';
import {
  pushInvoiceToAccounting,
  voidInvoiceInAccounting,
  AccountingInvoicePushError,
} from './accountingInvoicePush';

const PARTNER = 'p1';
const ORG = 'org-a';
const INVOICE = 'inv-1';
const CONN_ID = 'c1';

function conn(overrides: Record<string, unknown> = {}) {
  return {
    id: CONN_ID, partnerId: PARTNER, provider: 'quickbooks', realmId: 'r1',
    environment: 'sandbox', status: 'connected', homeCurrency: 'USD', multiCurrencyEnabled: false,
    defaultIncomeAccountRef: '79', defaultTaxCodeRef: 'TAX-1',
    realmIdFingerprint: null, pullPayments: true, pushPayments: true, lastReconcileAt: null, cdcCursor: null,
    ...overrides,
  };
}

function liveConn(overrides: Record<string, unknown> = {}) {
  return { ...conn(overrides), accessToken: 'fresh-token' };
}

interface InvRow {
  id: string; partnerId: string; orgId: string; invoiceNumber: string | null; status: string;
  currencyCode: string; issueDate: string | null; dueDate: string | null;
  subtotal: string; taxTotal: string; total: string;
}
interface LineRow {
  id: string; invoiceId: string; catalogItemId: string | null; name: string | null; description: string | null;
  quantity: string; unitPrice: string; lineTotal: string; taxable: boolean; sortOrder: number;
  customerVisible: boolean;
}
interface MappingRow {
  id: string; integrationId: string; partnerId: string; breezeEntityType: string; breezeEntityId: string;
  remoteEntityType: string; remoteEntityId: string | null; remoteSyncToken: string | null;
  remoteCurrencyCode: string | null; remoteDocNumber: string | null;
  linkStatus: string; syncStatus: string; lastError: string | null;
}

function conditionContainsValue(obj: unknown, value: string, seen = new Set<unknown>()): boolean {
  if (obj === value) return true;
  if (obj && typeof obj === 'object') {
    if (seen.has(obj)) return false;
    seen.add(obj);
    for (const v of Object.values(obj as Record<string, unknown>)) {
      if (conditionContainsValue(v, value, seen)) return true;
    }
  }
  return false;
}

function pgUniqueViolation(constraint: string) {
  return Object.assign(new Error(`duplicate key value violates unique constraint "${constraint}"`), {
    code: '23505',
    constraint_name: constraint,
  });
}

let currentInvoices: InvRow[] = [];
let currentLines: LineRow[] = [];
let currentMappings: MappingRow[] = [];
const insertedValues: Array<Record<string, unknown>> = [];
const updatedPatches: Array<{ table: unknown; patch: Record<string, unknown> }> = [];

function defaultInvoice(overrides: Partial<InvRow> = {}): InvRow {
  return {
    id: INVOICE, partnerId: PARTNER, orgId: ORG, invoiceNumber: 'INV-2026-0001', status: 'sent',
    currencyCode: 'USD', issueDate: '2026-09-01', dueDate: '2026-10-01',
    subtotal: '100.00', taxTotal: '7.00', total: '107.00',
    ...overrides,
  };
}

function defaultLines(overrides: Partial<LineRow>[] = []): LineRow[] {
  if (overrides.length === 0) {
    return [{
      id: 'line-1', invoiceId: INVOICE, catalogItemId: null, name: 'Widget', description: null,
      quantity: '1', unitPrice: '100.00', lineTotal: '100.00', taxable: true, sortOrder: 0,
      customerVisible: true,
    }];
  }
  return overrides.map((o, i) => ({
    id: `line-${i + 1}`, invoiceId: INVOICE, catalogItemId: null, name: `Line ${i + 1}`, description: null,
    quantity: '1', unitPrice: '100.00', lineTotal: '100.00', taxable: true, sortOrder: i,
    customerVisible: true,
    ...o,
  }));
}

/**
 * Walks a REAL (unmocked) drizzle-orm compiled SQL tree — invoices/
 * invoiceLines/accountingEntityMappings are real schema imports here, not
 * mocked, so `eq(...)`/`and(...)` produce genuine SQL objects with a
 * `queryChunks` tree. Mirrors the `flattenSql` technique in
 * ticketService.test.ts (memory/vacuous_drizzle_where_clause_assertions):
 * walking the COMPILED SQL proves a real `eq(column, value)` call happened
 * against a real Column, rather than trusting a mock that ignores its `where`/
 * `orderBy` arguments entirely (the vacuity a mutation-test caught here —
 * adding a stray `customerVisible` filter or swapping `orderBy(sortOrder)`
 * for `orderBy(id)` left every assertion green because nothing inspected the
 * compiled condition).
 */
function sqlColumnsAndValues(node: unknown): { columns: string[]; values: unknown[] } {
  const columns: string[] = [];
  const values: unknown[] = [];
  const walk = (n: unknown): void => {
    if (!n || typeof n !== 'object') return;
    const rec = n as Record<string, unknown>;
    if (Array.isArray(rec.queryChunks)) {
      for (const c of rec.queryChunks as unknown[]) walk(c);
      return;
    }
    if (Array.isArray(rec.value)) return; // StringChunk punctuation (" = ", " and ", …) — not data
    if (typeof rec.name === 'string' && 'columnType' in rec) { columns.push(rec.name); return; } // Column ref
    if ('value' in rec && 'encoder' in rec) { values.push(rec.value); return; } // bound Param
  };
  walk(node);
  return { columns, values };
}

// Captured verbatim from the mocked `where`/`orderBy` calls issued against
// `invoiceLines` specifically, so tests can prove (not assume) what the
// coordinator actually queried for — reset on every setup().
let lastLinesWhereCond: unknown = null;
let lastLinesOrderByArg: unknown = null;

function orgMappingRow(overrides: Partial<MappingRow> = {}): MappingRow {
  return {
    id: 'map-org-1', integrationId: CONN_ID, partnerId: PARTNER, breezeEntityType: 'org', breezeEntityId: ORG,
    remoteEntityType: 'Customer', remoteEntityId: 'qb-cust-1', remoteSyncToken: '0',
    remoteCurrencyCode: null, remoteDocNumber: null, linkStatus: 'confirmed', syncStatus: 'synced', lastError: null,
    ...overrides,
  };
}

function setup(opts: {
  invoice?: Partial<InvRow>;
  lines?: Partial<LineRow>[];
  mappings?: MappingRow[];
} = {}) {
  currentInvoices = [defaultInvoice(opts.invoice)];
  currentLines = defaultLines(opts.lines);
  currentMappings = (opts.mappings ?? [orgMappingRow()]).map((m) => ({ ...m }));
  lastLinesWhereCond = null;
  lastLinesOrderByArg = null;

  selectMock.mockImplementation(() => ({
    from: (table: unknown) => ({
      where: (cond: unknown) => {
        // invoiceLines is scoped by invoiceId (already partner-verified via the
        // invoice row lookup), mirroring invoiceService.getInvoice's own
        // unscoped `where(eq(invoiceLines.invoiceId, invoiceId))` — every OTHER
        // table's read must still carry the partner id.
        if (table !== invoiceLines && !conditionContainsValue(cond, PARTNER)) {
          throw new Error('query issued without partner scoping — every read must filter by partnerId');
        }
        let rows: unknown[];
        if (table === invoices) rows = currentInvoices;
        else if (table === invoiceLines) { lastLinesWhereCond = cond; rows = currentLines; }
        else if (table === accountingEntityMappings) rows = currentMappings;
        else rows = [];
        return {
          orderBy: (arg: unknown) => {
            if (table === invoiceLines) lastLinesOrderByArg = arg;
            return Promise.resolve(rows);
          },
          limit: () => Promise.resolve(rows),
          then: (resolve: (v: unknown[]) => unknown) => Promise.resolve(rows).then(resolve),
        };
      },
    }),
  }));
}

function stubInsert() {
  let n = 0;
  insertMock.mockImplementation(() => ({
    values: (v: Record<string, unknown>) => {
      n++;
      const row = { id: `gen-${n}`, lastError: null, createdAt: new Date(), updatedAt: new Date(), ...v };
      const finalize = () => {
        insertedValues.push(row);
        currentMappings.push(row as unknown as MappingRow);
        return Promise.resolve([row]);
      };
      return { returning: finalize };
    },
  }));
}

function stubUpdate() {
  updateMock.mockImplementation((table: unknown) => ({
    set: (patch: Record<string, unknown>) => ({
      where: (cond: unknown) => ({
        returning: () => {
          if (!conditionContainsValue(cond, PARTNER)) {
            throw new Error('update issued without partner scoping — every write must filter by partnerId');
          }
          updatedPatches.push({ table, patch });
          const idx = currentMappings.findIndex((row) => conditionContainsValue(cond, row.id));
          if (idx === -1) return Promise.resolve([]);
          currentMappings[idx] = { ...currentMappings[idx], ...patch } as MappingRow;
          return Promise.resolve([currentMappings[idx]]);
        },
      }),
    }),
  }));
}

// Row-level "insert would violate accounting_entity_mappings_breeze_uniq"
// simulation, toggled per-test.
let insertUniqueViolation: string | null = null;

function stubInsertWithViolation() {
  insertMock.mockImplementation(() => ({
    values: () => ({
      returning: () => {
        if (insertUniqueViolation) return Promise.reject(pgUniqueViolation(insertUniqueViolation));
        return Promise.resolve([]);
      },
    }),
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  ctx.depth = 0;
  ctx.events.length = 0;
  insertedValues.length = 0;
  updatedPatches.length = 0;
  insertUniqueViolation = null;
  stubInsert();
  stubUpdate();
  setup();
  resolveConnectionMock.mockResolvedValue(conn());
  resolveLiveConnectionMock.mockResolvedValue(liveConn());
  syncMappedEntityMock.mockImplementation(async ({ breezeEntityType, breezeEntityId }: { breezeEntityType: string; breezeEntityId: string }) => {
    const idx = currentMappings.findIndex((m) => m.breezeEntityType === breezeEntityType && m.breezeEntityId === breezeEntityId);
    if (idx === -1) throw new Error('syncMappedEntity called for an unmapped entity in test setup');
    const existing = currentMappings[idx] as MappingRow;
    const updated: MappingRow = {
      ...existing,
      remoteEntityId: existing.remoteEntityId ?? 'qb-synced',
      remoteSyncToken: existing.remoteSyncToken ?? '0',
      syncStatus: 'synced',
    };
    currentMappings[idx] = updated;
    return updated;
  });
  pushInvoiceMock.mockResolvedValue({
    id: 'qb-inv-1', syncToken: '0', docNumber: 'INV-2026-0001',
    remoteTaxTotal: '7.00', remoteTotal: '107.00',
  });
  voidInvoiceMock.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// Review round 3 — DB-context phase split (#1105 / lost-sync-state class).
// ---------------------------------------------------------------------------

describe('DB access context contract', () => {
  it.each([
    ['pushInvoiceToAccounting', (): Promise<unknown> => pushInvoiceToAccounting(INVOICE, PARTNER, runCtx)],
    ['voidInvoiceInAccounting', (): Promise<unknown> => voidInvoiceInAccounting(INVOICE, PARTNER, runCtx)],
  ] as const)('%s refuses to run inside an ambient DB access context', async (_name, coordinator) => {
    await expect(runCtx(coordinator)).rejects.toThrow(/no ambient DB access context/i);
    expect(pushInvoiceMock).not.toHaveBeenCalled();
    expect(voidInvoiceMock).not.toHaveBeenCalled();
  });

  it('runs the currency guard BEFORE resolving a token, so an expired grant never refreshes for an unpushable invoice', async () => {
    // The realm is USD and the invoice is EUR: the push can never succeed. If
    // the token were resolved first (the old shape resolved connection+token
    // up front), an expired access token would fire a QuickBooks refresh —
    // network I/O, token rotation and possibly a `reauth_required` flip — for
    // work that was always going to 409.
    setup({ invoice: { currencyCode: 'EUR' } });
    resolveConnectionMock.mockResolvedValue(conn({ homeCurrency: 'USD', multiCurrencyEnabled: false }));
    resolveLiveConnectionMock.mockRejectedValue(new Error('token refresh must not be reached'));

    await expect(pushInvoiceToAccounting(INVOICE, PARTNER, runCtx)).rejects.toMatchObject({ code: 'currency_mismatch' });
    expect(resolveLiveConnectionMock).not.toHaveBeenCalled();
    expect(pushInvoiceMock).not.toHaveBeenCalled();
  });

  it('calls QuickBooks with NO context open, and marks the failure in a FRESH context that commits before the throw', async () => {
    let depthAtProviderCall = -1;
    pushInvoiceMock.mockImplementationOnce(async () => {
      depthAtProviderCall = ctx.depth;
      ctx.events.push('provider');
      throw Object.assign(new Error('boom'), { status: 500 });
    });

    await expect(pushInvoiceToAccounting(INVOICE, PARTNER, runCtx)).rejects.toMatchObject({ code: 'quickbooks_error' });

    expect(depthAtProviderCall).toBe(0);
    // Phase 1, Phase 1b, then the provider call with nothing held, then the
    // error marker in a context opened AFTER it — a real transaction that
    // commits, not a savepoint the throw rolls back.
    expect(ctx.events).toEqual([
      'ctx:enter', 'ctx:exit', // phase 1: connection, invoice, guards, mappings
      'ctx:enter', 'ctx:exit', // phase 1b: pending mapping row claim
      'provider',
      'ctx:enter', 'ctx:exit', // phase 2: markInvoiceMappingError
    ]);
    expect(ctx.depth).toBe(0);
  });
});

describe('pushInvoiceToAccounting', () => {
  it('rejects a draft invoice with invoice_not_pushable and never calls the provider', async () => {
    setup({ invoice: { status: 'draft', invoiceNumber: null } });

    await expect(pushInvoiceToAccounting(INVOICE, PARTNER, runCtx)).rejects.toMatchObject({
      code: 'invoice_not_pushable', status: 409,
    });
    expect(pushInvoiceMock).not.toHaveBeenCalled();
  });

  it('rejects a voided invoice with invoice_not_pushable', async () => {
    setup({ invoice: { status: 'void' } });
    await expect(pushInvoiceToAccounting(INVOICE, PARTNER, runCtx)).rejects.toMatchObject({
      code: 'invoice_not_pushable', status: 409,
    });
    expect(pushInvoiceMock).not.toHaveBeenCalled();
  });

  describe('currency guard runs before any provider call', () => {
    it('blocks with home_currency_unknown when the realm home currency is unavailable', async () => {
      resolveConnectionMock.mockResolvedValue(conn({ homeCurrency: null }));
      resolveLiveConnectionMock.mockResolvedValue(liveConn({ homeCurrency: null }));

      await expect(pushInvoiceToAccounting(INVOICE, PARTNER, runCtx)).rejects.toMatchObject({
        code: 'home_currency_unknown', status: 409,
      });
      expect(pushInvoiceMock).not.toHaveBeenCalled();
    });

    it('blocks a currency mismatch with a single-currency-realm message when multiCurrencyEnabled !== true', async () => {
      setup({ invoice: { currencyCode: 'EUR' } });
      resolveConnectionMock.mockResolvedValue(conn({ homeCurrency: 'USD', multiCurrencyEnabled: false }));
      resolveLiveConnectionMock.mockResolvedValue(liveConn({ homeCurrency: 'USD', multiCurrencyEnabled: false }));

      let caught: AccountingInvoicePushError | undefined;
      try {
        await pushInvoiceToAccounting(INVOICE, PARTNER, runCtx);
      } catch (err) {
        caught = err as AccountingInvoicePushError;
      }
      expect(caught?.code).toBe('currency_mismatch');
      expect(caught?.status).toBe(409);
      expect(caught?.message).toContain('Enable multi-currency in QuickBooks or invoice in USD');
      expect(pushInvoiceMock).not.toHaveBeenCalled();
    });

    it('blocks a currency mismatch with a multi-currency-realm message when multiCurrencyEnabled === true', async () => {
      setup({ invoice: { currencyCode: 'EUR' } });
      resolveConnectionMock.mockResolvedValue(conn({ homeCurrency: 'USD', multiCurrencyEnabled: true }));
      resolveLiveConnectionMock.mockResolvedValue(liveConn({ homeCurrency: 'USD', multiCurrencyEnabled: true }));

      let caught: AccountingInvoicePushError | undefined;
      try {
        await pushInvoiceToAccounting(INVOICE, PARTNER, runCtx);
      } catch (err) {
        caught = err as AccountingInvoicePushError;
      }
      expect(caught?.code).toBe('currency_mismatch');
      expect(caught?.status).toBe(409);
      expect(caught?.message).toContain('foreign-currency invoice push is not yet supported');
      expect(pushInvoiceMock).not.toHaveBeenCalled();
    });
  });

  it('rejects with customer_currency_mismatch when the mapped customer currency differs from the invoice', async () => {
    setup({ mappings: [orgMappingRow({ remoteCurrencyCode: 'EUR' })] });

    await expect(pushInvoiceToAccounting(INVOICE, PARTNER, runCtx)).rejects.toMatchObject({
      code: 'customer_currency_mismatch', status: 409,
    });
    expect(pushInvoiceMock).not.toHaveBeenCalled();
  });

  it('allows a null remoteCurrencyCode (unknown is not a mismatch)', async () => {
    setup({ mappings: [orgMappingRow({ remoteCurrencyCode: null })] });
    await expect(pushInvoiceToAccounting(INVOICE, PARTNER, runCtx)).resolves.toMatchObject({ syncStatus: 'synced' });
  });

  it.each([
    ['unlinked' as const],
    ['suggested' as const],
  ])('rejects with customer_not_mapped when the org mapping linkStatus is %s', async (linkStatus) => {
    setup({ mappings: [orgMappingRow({ linkStatus, remoteEntityId: null, syncStatus: 'pending' })] });

    await expect(pushInvoiceToAccounting(INVOICE, PARTNER, runCtx)).rejects.toMatchObject({
      code: 'customer_not_mapped', status: 409,
    });
    expect(pushInvoiceMock).not.toHaveBeenCalled();
  });

  it('rejects with customer_not_mapped when no org mapping row exists at all', async () => {
    setup({ mappings: [] });
    await expect(pushInvoiceToAccounting(INVOICE, PARTNER, runCtx)).rejects.toMatchObject({
      code: 'customer_not_mapped', status: 409,
    });
  });

  it('syncs a create_new/pending org mapping before pushing, and syncs mapped catalog lines too, but pushes an unmapped line ad-hoc', async () => {
    setup({
      mappings: [
        orgMappingRow({ linkStatus: 'create_new', remoteEntityId: null, remoteSyncToken: null, syncStatus: 'pending' }),
        {
          id: 'map-item-1', integrationId: CONN_ID, partnerId: PARTNER, breezeEntityType: 'catalog_item',
          breezeEntityId: 'item-1', remoteEntityType: 'Item', remoteEntityId: null, remoteSyncToken: null,
          remoteCurrencyCode: null, remoteDocNumber: null, linkStatus: 'confirmed', syncStatus: 'pending', lastError: null,
        },
      ],
      lines: [
        { id: 'line-1', catalogItemId: 'item-1', name: 'Mapped item' },
        { id: 'line-2', catalogItemId: 'item-2', name: 'Unmapped item' },
      ],
    });

    await pushInvoiceToAccounting(INVOICE, PARTNER, runCtx);

    expect(syncMappedEntityMock).toHaveBeenCalledWith(expect.objectContaining({ breezeEntityType: 'org', breezeEntityId: ORG }), runCtx);
    expect(syncMappedEntityMock).toHaveBeenCalledWith(expect.objectContaining({ breezeEntityType: 'catalog_item', breezeEntityId: 'item-1' }), runCtx);
    expect(syncMappedEntityMock).not.toHaveBeenCalledWith(expect.objectContaining({ breezeEntityId: 'item-2' }), runCtx);
    // Step 3 order (brief): the org sync must land BEFORE the line-item sync,
    // not just "both happened" — a bundle-child sync racing ahead of the
    // customer that owns it would build lineMappings for a customer QuickBooks
    // doesn't know about yet.
    const orgCallOrder = syncMappedEntityMock.mock.invocationCallOrder[
      syncMappedEntityMock.mock.calls.findIndex((c) => (c[0] as { breezeEntityType: string }).breezeEntityType === 'org')
    ];
    const itemCallOrder = syncMappedEntityMock.mock.invocationCallOrder[
      syncMappedEntityMock.mock.calls.findIndex((c) => (c[0] as { breezeEntityType: string }).breezeEntityType === 'catalog_item')
    ];
    expect(orgCallOrder).toBeLessThan(itemCallOrder!);

    const [, , lineMappings] = pushInvoiceMock.mock.calls[0]!;
    expect(lineMappings).toContainEqual({ invoiceLineId: 'line-1', remoteItemRef: { id: 'qb-synced', syncToken: '0' } });
    expect(lineMappings).toContainEqual({ invoiceLineId: 'line-2', remoteItemRef: null });
  });

  it('sends all lines including hidden zero-priced bundle children, stamps currencyCode and ISO dates, and upserts the mapping row create_new -> confirmed/synced', async () => {
    setup({
      lines: [
        { id: 'line-1', name: 'Bundle parent', lineTotal: '100.00' },
        // customerVisible: false is the actual "hidden" signal (matches the
        // real invoice_lines.customer_visible column) — the assertions below
        // prove the coordinator's WHERE clause carries no predicate on it.
        { id: 'line-2', name: 'Hidden child', lineTotal: '0.00', unitPrice: '0.00', customerVisible: false },
      ],
    });

    const outcome = await pushInvoiceToAccounting(INVOICE, PARTNER, runCtx);

    const [, payload] = pushInvoiceMock.mock.calls[0]!;
    expect(payload.lines).toHaveLength(2);
    expect(payload.lines.map((l: { invoiceLineId: string }) => l.invoiceLineId)).toEqual(['line-1', 'line-2']);
    expect(payload.currencyCode).toBe('USD');
    expect(payload.txnDate).toBe('2026-09-01');
    expect(payload.dueDate).toBe('2026-10-01');
    expect(payload.mapping).toBeNull(); // no prior invoice mapping row -> create path

    // Prove "all lines including hidden" isn't vacuous: walk the REAL compiled
    // SQL the coordinator issued for invoiceLines and assert it filters by
    // invoice_id ONLY — no customer_visible predicate exists to have excluded
    // the hidden line (a mutation-proof: adding one here made this fail before
    // this assertion existed, while the mock silently kept returning both rows).
    const { columns, values } = sqlColumnsAndValues(lastLinesWhereCond);
    expect(columns).toEqual(['invoice_id']);
    expect(values).toEqual([INVOICE]);
    // Prove "ORDER BY sortOrder": the actual invoiceLines.sortOrder Column
    // object was passed to .orderBy(), by reference — not a different column
    // (e.g. `id`) that would happen to produce the same order in this fixture.
    expect(lastLinesOrderByArg).toBe(invoiceLines.sortOrder);

    expect(insertedValues).toContainEqual(expect.objectContaining({
      breezeEntityType: 'invoice', breezeEntityId: INVOICE, linkStatus: 'create_new', syncStatus: 'pending',
    }));
    expect(outcome).toMatchObject({ remoteEntityId: 'qb-inv-1', syncStatus: 'synced', taxVarianceCents: null });
  });

  it('flags synced_with_tax_variance when remoteTaxTotal differs from invoice taxTotal by more than 1 cent', async () => {
    pushInvoiceMock.mockResolvedValue({ id: 'qb-inv-1', syncToken: '0', docNumber: null, remoteTaxTotal: '7.02', remoteTotal: '107.02' });

    const outcome = await pushInvoiceToAccounting(INVOICE, PARTNER, runCtx);

    expect(outcome.syncStatus).toBe('synced_with_tax_variance');
    expect(outcome.taxVarianceCents).toBe(2);
  });

  it('treats a 1-cent tax difference as plain synced (within tolerance)', async () => {
    pushInvoiceMock.mockResolvedValue({ id: 'qb-inv-1', syncToken: '0', docNumber: null, remoteTaxTotal: '7.01', remoteTotal: '107.01' });

    const outcome = await pushInvoiceToAccounting(INVOICE, PARTNER, runCtx);

    expect(outcome.syncStatus).toBe('synced');
    expect(outcome.taxVarianceCents).toBeNull();
  });

  it('persists remote_doc_number only when the QBO DocNumber differs from the Breeze invoice number', async () => {
    pushInvoiceMock.mockResolvedValue({ id: 'qb-inv-1', syncToken: '0', docNumber: 'INV-2026-9999', remoteTaxTotal: '7.00', remoteTotal: '107.00' });

    const outcome = await pushInvoiceToAccounting(INVOICE, PARTNER, runCtx);

    expect(outcome.docNumber).toBe('INV-2026-9999');
    const mappingUpdate = updatedPatches.find((u) => 'remoteDocNumber' in u.patch);
    expect(mappingUpdate?.patch.remoteDocNumber).toBe('INV-2026-9999');
  });

  it('does not persist remote_doc_number when the QBO DocNumber matches the Breeze invoice number', async () => {
    pushInvoiceMock.mockResolvedValue({ id: 'qb-inv-1', syncToken: '0', docNumber: 'INV-2026-0001', remoteTaxTotal: '7.00', remoteTotal: '107.00' });

    const outcome = await pushInvoiceToAccounting(INVOICE, PARTNER, runCtx);

    expect(outcome.docNumber).toBe('INV-2026-0001');
    const mappingUpdate = updatedPatches.find((u) => 'remoteDocNumber' in u.patch);
    expect(mappingUpdate?.patch.remoteDocNumber).toBeNull();
  });

  it('on provider failure, marks the mapping error with the exact sanitized message and rethrows quickbooks_error 502', async () => {
    pushInvoiceMock.mockRejectedValue(Object.assign(new Error('boom'), { status: 500 }));

    let caught: AccountingInvoicePushError | undefined;
    try {
      await pushInvoiceToAccounting(INVOICE, PARTNER, runCtx);
    } catch (err) {
      caught = err as AccountingInvoicePushError;
    }

    expect(caught?.code).toBe('quickbooks_error');
    expect(caught?.status).toBe(502);
    expect(caught?.message).toBe('QuickBooks rejected the invoice sync (HTTP 500)');
    const errorUpdate = updatedPatches.find((u) => u.patch.syncStatus === 'error');
    expect(errorUpdate?.patch.lastError).toBe('QuickBooks rejected the invoice sync (HTTP 500)');
    expect(captureExceptionMock).toHaveBeenCalled();
  });

  it('on a zero-row persist after a successful remote push, throws record_failed 502 embedding the remote id and never retries', async () => {
    // Simulate the update-after-push finding no matching row (id/partner mismatch
    // — the same "remote succeeded but Breeze failed to record it" seam as
    // accountingMappingService's persistRemoteRef).
    const originalUpdate = updateMock.getMockImplementation();
    let pushed = false;
    updateMock.mockImplementation((table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: (cond: unknown) => ({
          returning: () => {
            if (patch.remoteEntityId === 'qb-inv-1') { pushed = true; return Promise.resolve([]); }
            return originalUpdate!(table).set(patch).where(cond).returning();
          },
        }),
      }),
    }));

    let caught: AccountingInvoicePushError | undefined;
    try {
      await pushInvoiceToAccounting(INVOICE, PARTNER, runCtx);
    } catch (err) {
      caught = err as AccountingInvoicePushError;
    }

    expect(pushed).toBe(true);
    expect(caught?.code).toBe('record_failed');
    expect(caught?.status).toBe(502);
    expect(caught?.message).toContain('qb-inv-1');
    expect(caught?.message).toMatch(/do not retry/i);

    // Review finding 3: the row must NOT be left at sync_status='pending' with
    // no remote id — a stale-pending reaper would re-push and duplicate the
    // QuickBooks invoice. It should be marked 'error' with the record_failed
    // text (best-effort — the update above is separate from the one that just
    // failed, so it can succeed even though that one didn't).
    const invoiceMapping = currentMappings.find((m) => m.breezeEntityType === 'invoice');
    expect(invoiceMapping?.syncStatus).toBe('error');
    expect(invoiceMapping?.lastError).toContain('qb-inv-1');
    expect(invoiceMapping?.lastError).toMatch(/do not retry/i);
  });

  it('enqueues a void when the invoice was voided while the push was in flight', async () => {
    // The invoice flips to void between Phase 1 and Phase 2. The void job that
    // fired at that moment saw a pending row with no remote id and backed off
    // with sync_in_progress, so nothing else will re-drive it — this push must.
    let pushed = false;
    pushInvoiceMock.mockImplementationOnce(async () => {
      pushed = true;
      currentInvoices = [defaultInvoice({ status: 'void' })];
      return { id: 'qb-inv-1', syncToken: '0', docNumber: 'INV-2026-0001', remoteTaxTotal: '7.00', remoteTotal: '107.00' };
    });

    await pushInvoiceToAccounting(INVOICE, PARTNER, runCtx);

    expect(pushed).toBe(true);
    expect(enqueueAccountingInvoiceVoidMock).toHaveBeenCalledWith(INVOICE, PARTNER);
  });

  it('does NOT enqueue a void when the invoice is still issued after the push', async () => {
    await pushInvoiceToAccounting(INVOICE, PARTNER, runCtx);
    expect(enqueueAccountingInvoiceVoidMock).not.toHaveBeenCalled();
  });

  it('re-pushes an already-synced invoice mapping via the sparse update path (no duplicate insert)', async () => {
    setup({
      mappings: [
        orgMappingRow(),
        {
          id: 'map-inv-1', integrationId: CONN_ID, partnerId: PARTNER, breezeEntityType: 'invoice', breezeEntityId: INVOICE,
          remoteEntityType: 'Invoice', remoteEntityId: 'qb-inv-1', remoteSyncToken: '3',
          remoteCurrencyCode: null, remoteDocNumber: null, linkStatus: 'confirmed', syncStatus: 'synced', lastError: null,
        },
      ],
    });

    await pushInvoiceToAccounting(INVOICE, PARTNER, runCtx);

    expect(insertedValues.some((v) => v.breezeEntityType === 'invoice')).toBe(false);
    const [, payload] = pushInvoiceMock.mock.calls[0]!;
    expect(payload.mapping).toEqual({ remoteEntityId: 'qb-inv-1', remoteSyncToken: '3' });
  });

  it('maps a concurrent-insert race (unique violation on first push) to quickbooks_error instead of a raw 500', async () => {
    setup({ mappings: [orgMappingRow()] });
    stubInsertWithViolation();
    insertUniqueViolation = 'accounting_entity_mappings_breeze_uniq';

    await expect(pushInvoiceToAccounting(INVOICE, PARTNER, runCtx)).rejects.toMatchObject({ code: 'quickbooks_error', status: 502 });
    expect(pushInvoiceMock).not.toHaveBeenCalled();
  });

  describe('nested dependency-sync failures (syncMappedEntity)', () => {
    it('maps a permanent pre-flight 409 from the ORG sync (e.g. a create-time currency_mismatch) to dependency_not_ready, never quickbooks_error', async () => {
      setup({
        mappings: [orgMappingRow({ linkStatus: 'create_new', remoteEntityId: null, remoteSyncToken: null, syncStatus: 'pending' })],
      });
      syncMappedEntityMock.mockRejectedValueOnce(
        new AccountingMappingError('currency_mismatch', 409, 'This organization is priced in EUR, but the connected QuickBooks company\'s home currency is USD.'),
      );

      let caught: AccountingInvoicePushError | undefined;
      try {
        await pushInvoiceToAccounting(INVOICE, PARTNER, runCtx);
      } catch (err) {
        caught = err as AccountingInvoicePushError;
      }

      expect(caught?.code).toBe('dependency_not_ready');
      expect(caught?.status).toBe(409);
      expect(caught?.message).toContain('home currency is USD');
      expect(pushInvoiceMock).not.toHaveBeenCalled();
    });

    it('maps a permanent pre-flight 409 from a CATALOG-ITEM sync (e.g. income_account_required) to dependency_not_ready', async () => {
      setup({
        mappings: [
          orgMappingRow(), // already synced — only the item sync should fire
          {
            id: 'map-item-1', integrationId: CONN_ID, partnerId: PARTNER, breezeEntityType: 'catalog_item',
            breezeEntityId: 'item-1', remoteEntityType: 'Item', remoteEntityId: null, remoteSyncToken: null,
            remoteCurrencyCode: null, remoteDocNumber: null, linkStatus: 'confirmed', syncStatus: 'pending', lastError: null,
          },
        ],
        lines: [{ id: 'line-1', catalogItemId: 'item-1' }],
      });
      syncMappedEntityMock.mockRejectedValueOnce(
        new AccountingMappingError('income_account_required', 409, 'Select a default QuickBooks income account before creating catalog items in QuickBooks'),
      );

      let caught: AccountingInvoicePushError | undefined;
      try {
        await pushInvoiceToAccounting(INVOICE, PARTNER, runCtx);
      } catch (err) {
        caught = err as AccountingInvoicePushError;
      }

      expect(caught?.code).toBe('dependency_not_ready');
      expect(caught?.status).toBe(409);
      expect(pushInvoiceMock).not.toHaveBeenCalled();
    });

    it('preserves a genuine quickbooks_error/502 from a nested sync as quickbooks_error — not conflated with dependency_not_ready', async () => {
      setup({
        mappings: [orgMappingRow({ linkStatus: 'create_new', remoteEntityId: null, remoteSyncToken: null, syncStatus: 'pending' })],
      });
      syncMappedEntityMock.mockRejectedValueOnce(
        new AccountingMappingError('quickbooks_error', 502, 'QuickBooks rejected the customer sync (HTTP 500)'),
      );

      let caught: AccountingInvoicePushError | undefined;
      try {
        await pushInvoiceToAccounting(INVOICE, PARTNER, runCtx);
      } catch (err) {
        caught = err as AccountingInvoicePushError;
      }

      expect(caught?.code).toBe('quickbooks_error');
      expect(caught?.status).toBe(502);
      expect(pushInvoiceMock).not.toHaveBeenCalled();
    });

    it('re-types reauth_required/not_connected from a nested sync to their exact counterparts', async () => {
      setup({
        mappings: [orgMappingRow({ linkStatus: 'create_new', remoteEntityId: null, remoteSyncToken: null, syncStatus: 'pending' })],
      });
      syncMappedEntityMock.mockRejectedValueOnce(new AccountingMappingError('reauth_required', 409, 'QuickBooks needs to be reconnected'));

      await expect(pushInvoiceToAccounting(INVOICE, PARTNER, runCtx)).rejects.toMatchObject({ code: 'reauth_required', status: 409 });
    });
  });
});

describe('voidInvoiceInAccounting', () => {
  it('resolves without calling the provider when the invoice was never pushed', async () => {
    setup({ mappings: [orgMappingRow()] }); // no invoice mapping row at all

    await expect(voidInvoiceInAccounting(INVOICE, PARTNER, runCtx)).resolves.toBeUndefined();
    expect(voidInvoiceMock).not.toHaveBeenCalled();
  });

  // --- push/void race (review round 3) --------------------------------------

  it('throws a NON-terminal sync_in_progress when a push is mid-flight (pending row, no remote id)', async () => {
    // The push coordinator's Phase 1b has claimed the row but its Phase 2 has
    // not landed the remote id yet. Returning "nothing to void" here would
    // leave the invoice open in QuickBooks forever once that push completes.
    setup({
      mappings: [
        orgMappingRow(),
        {
          id: 'map-inv-1', integrationId: CONN_ID, partnerId: PARTNER, breezeEntityType: 'invoice', breezeEntityId: INVOICE,
          remoteEntityType: 'Invoice', remoteEntityId: null, remoteSyncToken: null,
          remoteCurrencyCode: null, remoteDocNumber: null, linkStatus: 'create_new', syncStatus: 'pending', lastError: null,
        },
      ],
    });

    await expect(voidInvoiceInAccounting(INVOICE, PARTNER, runCtx)).rejects.toMatchObject({
      code: 'sync_in_progress', status: 409,
    });
    expect(voidInvoiceMock).not.toHaveBeenCalled();
  });

  it('still no-ops for an errored mapping with no remote id (that push never reached QuickBooks)', async () => {
    setup({
      mappings: [
        orgMappingRow(),
        {
          id: 'map-inv-1', integrationId: CONN_ID, partnerId: PARTNER, breezeEntityType: 'invoice', breezeEntityId: INVOICE,
          remoteEntityType: 'Invoice', remoteEntityId: null, remoteSyncToken: null,
          remoteCurrencyCode: null, remoteDocNumber: null, linkStatus: 'create_new', syncStatus: 'error', lastError: 'boom',
        },
      ],
    });

    await expect(voidInvoiceInAccounting(INVOICE, PARTNER, runCtx)).resolves.toBeUndefined();
    expect(voidInvoiceMock).not.toHaveBeenCalled();
  });

  it('calls provider.voidInvoice with the stored mapping for a pushed invoice, and leaves sync_status/last_error untouched on success', async () => {
    setup({
      mappings: [
        orgMappingRow(),
        {
          id: 'map-inv-1', integrationId: CONN_ID, partnerId: PARTNER, breezeEntityType: 'invoice', breezeEntityId: INVOICE,
          remoteEntityType: 'Invoice', remoteEntityId: 'qb-inv-1', remoteSyncToken: '3',
          remoteCurrencyCode: null, remoteDocNumber: null, linkStatus: 'confirmed', syncStatus: 'synced', lastError: null,
        },
      ],
    });

    await voidInvoiceInAccounting(INVOICE, PARTNER, runCtx);

    expect(voidInvoiceMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ invoiceId: INVOICE }),
      { remoteEntityId: 'qb-inv-1', remoteSyncToken: '3' },
    );
    const mapping = currentMappings.find((m) => m.id === 'map-inv-1')!;
    expect(mapping.syncStatus).toBe('synced');
    expect(mapping.lastError).toBeNull();
  });

  it('on provider void failure, marks the mapping error with a sanitized message and rethrows', async () => {
    setup({
      mappings: [
        orgMappingRow(),
        {
          id: 'map-inv-1', integrationId: CONN_ID, partnerId: PARTNER, breezeEntityType: 'invoice', breezeEntityId: INVOICE,
          remoteEntityType: 'Invoice', remoteEntityId: 'qb-inv-1', remoteSyncToken: '3',
          remoteCurrencyCode: null, remoteDocNumber: null, linkStatus: 'confirmed', syncStatus: 'synced', lastError: null,
        },
      ],
    });
    voidInvoiceMock.mockRejectedValue(Object.assign(new Error('boom'), { status: 500 }));

    let caught: AccountingInvoicePushError | undefined;
    try {
      await voidInvoiceInAccounting(INVOICE, PARTNER, runCtx);
    } catch (err) {
      caught = err as AccountingInvoicePushError;
    }

    expect(caught?.code).toBe('quickbooks_error');
    expect(caught?.status).toBe(502);
    expect(caught?.message).toBe('QuickBooks rejected the invoice sync (HTTP 500)');
    const mapping = currentMappings.find((m) => m.id === 'map-inv-1')!;
    expect(mapping.syncStatus).toBe('error');
    expect(mapping.lastError).toBe('QuickBooks rejected the invoice sync (HTTP 500)');
  });
});
