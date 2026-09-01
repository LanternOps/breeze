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
  resolveConnectionAndTokenMock,
  syncMappedEntityMock,
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
    resolveConnectionAndTokenMock: vi.fn(),
    syncMappedEntityMock: vi.fn(),
    pushInvoiceMock: vi.fn(),
    voidInvoiceMock: vi.fn(),
    captureExceptionMock: vi.fn(),
    AccountingMappingError,
  };
});

vi.mock('../../db', () => ({
  db: { select: selectMock, insert: insertMock, update: updateMock },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));

vi.mock('./accountingMappingService', () => ({
  resolveConnectionAndToken: resolveConnectionAndTokenMock,
  syncMappedEntity: syncMappedEntityMock,
  AccountingMappingError,
}));

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
    }];
  }
  return overrides.map((o, i) => ({
    id: `line-${i + 1}`, invoiceId: INVOICE, catalogItemId: null, name: `Line ${i + 1}`, description: null,
    quantity: '1', unitPrice: '100.00', lineTotal: '100.00', taxable: true, sortOrder: i,
    ...o,
  }));
}

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
        else if (table === invoiceLines) rows = currentLines;
        else if (table === accountingEntityMappings) rows = currentMappings;
        else rows = [];
        return {
          orderBy: () => Promise.resolve(rows),
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
  insertedValues.length = 0;
  updatedPatches.length = 0;
  insertUniqueViolation = null;
  stubInsert();
  stubUpdate();
  setup();
  resolveConnectionAndTokenMock.mockResolvedValue({ conn: conn(), liveConn: liveConn() });
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

describe('pushInvoiceToAccounting', () => {
  it('rejects a draft invoice with invoice_not_pushable and never calls the provider', async () => {
    setup({ invoice: { status: 'draft', invoiceNumber: null } });

    await expect(pushInvoiceToAccounting(INVOICE, PARTNER)).rejects.toMatchObject({
      code: 'invoice_not_pushable', status: 409,
    });
    expect(pushInvoiceMock).not.toHaveBeenCalled();
  });

  it('rejects a voided invoice with invoice_not_pushable', async () => {
    setup({ invoice: { status: 'void' } });
    await expect(pushInvoiceToAccounting(INVOICE, PARTNER)).rejects.toMatchObject({
      code: 'invoice_not_pushable', status: 409,
    });
    expect(pushInvoiceMock).not.toHaveBeenCalled();
  });

  describe('currency guard runs before any provider call', () => {
    it('blocks with home_currency_unknown when the realm home currency is unavailable', async () => {
      resolveConnectionAndTokenMock.mockResolvedValue({ conn: conn({ homeCurrency: null }), liveConn: liveConn({ homeCurrency: null }) });

      await expect(pushInvoiceToAccounting(INVOICE, PARTNER)).rejects.toMatchObject({
        code: 'home_currency_unknown', status: 409,
      });
      expect(pushInvoiceMock).not.toHaveBeenCalled();
    });

    it('blocks a currency mismatch with a single-currency-realm message when multiCurrencyEnabled !== true', async () => {
      setup({ invoice: { currencyCode: 'EUR' } });
      resolveConnectionAndTokenMock.mockResolvedValue({
        conn: conn({ homeCurrency: 'USD', multiCurrencyEnabled: false }),
        liveConn: liveConn({ homeCurrency: 'USD', multiCurrencyEnabled: false }),
      });

      let caught: AccountingInvoicePushError | undefined;
      try {
        await pushInvoiceToAccounting(INVOICE, PARTNER);
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
      resolveConnectionAndTokenMock.mockResolvedValue({
        conn: conn({ homeCurrency: 'USD', multiCurrencyEnabled: true }),
        liveConn: liveConn({ homeCurrency: 'USD', multiCurrencyEnabled: true }),
      });

      let caught: AccountingInvoicePushError | undefined;
      try {
        await pushInvoiceToAccounting(INVOICE, PARTNER);
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

    await expect(pushInvoiceToAccounting(INVOICE, PARTNER)).rejects.toMatchObject({
      code: 'customer_currency_mismatch', status: 409,
    });
    expect(pushInvoiceMock).not.toHaveBeenCalled();
  });

  it('allows a null remoteCurrencyCode (unknown is not a mismatch)', async () => {
    setup({ mappings: [orgMappingRow({ remoteCurrencyCode: null })] });
    await expect(pushInvoiceToAccounting(INVOICE, PARTNER)).resolves.toMatchObject({ syncStatus: 'synced' });
  });

  it.each([
    ['unlinked' as const],
    ['suggested' as const],
  ])('rejects with customer_not_mapped when the org mapping linkStatus is %s', async (linkStatus) => {
    setup({ mappings: [orgMappingRow({ linkStatus, remoteEntityId: null, syncStatus: 'pending' })] });

    await expect(pushInvoiceToAccounting(INVOICE, PARTNER)).rejects.toMatchObject({
      code: 'customer_not_mapped', status: 409,
    });
    expect(pushInvoiceMock).not.toHaveBeenCalled();
  });

  it('rejects with customer_not_mapped when no org mapping row exists at all', async () => {
    setup({ mappings: [] });
    await expect(pushInvoiceToAccounting(INVOICE, PARTNER)).rejects.toMatchObject({
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

    await pushInvoiceToAccounting(INVOICE, PARTNER);

    expect(syncMappedEntityMock).toHaveBeenCalledWith(expect.objectContaining({ breezeEntityType: 'org', breezeEntityId: ORG }));
    expect(syncMappedEntityMock).toHaveBeenCalledWith(expect.objectContaining({ breezeEntityType: 'catalog_item', breezeEntityId: 'item-1' }));
    expect(syncMappedEntityMock).not.toHaveBeenCalledWith(expect.objectContaining({ breezeEntityId: 'item-2' }));

    const [, , lineMappings] = pushInvoiceMock.mock.calls[0]!;
    expect(lineMappings).toContainEqual({ invoiceLineId: 'line-1', remoteItemRef: { id: 'qb-synced', syncToken: '0' } });
    expect(lineMappings).toContainEqual({ invoiceLineId: 'line-2', remoteItemRef: null });
  });

  it('sends all lines including hidden zero-priced bundle children, stamps currencyCode and ISO dates, and upserts the mapping row create_new -> confirmed/synced', async () => {
    setup({
      lines: [
        { id: 'line-1', name: 'Bundle parent', lineTotal: '100.00' },
        { id: 'line-2', name: 'Hidden child', lineTotal: '0.00', unitPrice: '0.00' },
      ],
    });
    // The hidden child row also needs customerVisible carried through, but the
    // coordinator loads ALL columns via `select()`, so a plain object with the
    // extra field is enough for this mock — the assertion below just proves
    // BOTH lines reached the payload regardless of price/visibility.

    const outcome = await pushInvoiceToAccounting(INVOICE, PARTNER);

    const [, payload] = pushInvoiceMock.mock.calls[0]!;
    expect(payload.lines).toHaveLength(2);
    expect(payload.lines.map((l: { invoiceLineId: string }) => l.invoiceLineId)).toEqual(['line-1', 'line-2']);
    expect(payload.currencyCode).toBe('USD');
    expect(payload.txnDate).toBe('2026-09-01');
    expect(payload.dueDate).toBe('2026-10-01');
    expect(payload.mapping).toBeNull(); // no prior invoice mapping row -> create path

    expect(insertedValues).toContainEqual(expect.objectContaining({
      breezeEntityType: 'invoice', breezeEntityId: INVOICE, linkStatus: 'create_new', syncStatus: 'pending',
    }));
    expect(outcome).toMatchObject({ remoteEntityId: 'qb-inv-1', syncStatus: 'synced', taxVarianceCents: null });
  });

  it('flags synced_with_tax_variance when remoteTaxTotal differs from invoice taxTotal by more than 1 cent', async () => {
    pushInvoiceMock.mockResolvedValue({ id: 'qb-inv-1', syncToken: '0', docNumber: null, remoteTaxTotal: '7.02', remoteTotal: '107.02' });

    const outcome = await pushInvoiceToAccounting(INVOICE, PARTNER);

    expect(outcome.syncStatus).toBe('synced_with_tax_variance');
    expect(outcome.taxVarianceCents).toBe(2);
  });

  it('treats a 1-cent tax difference as plain synced (within tolerance)', async () => {
    pushInvoiceMock.mockResolvedValue({ id: 'qb-inv-1', syncToken: '0', docNumber: null, remoteTaxTotal: '7.01', remoteTotal: '107.01' });

    const outcome = await pushInvoiceToAccounting(INVOICE, PARTNER);

    expect(outcome.syncStatus).toBe('synced');
    expect(outcome.taxVarianceCents).toBeNull();
  });

  it('persists remote_doc_number only when the QBO DocNumber differs from the Breeze invoice number', async () => {
    pushInvoiceMock.mockResolvedValue({ id: 'qb-inv-1', syncToken: '0', docNumber: 'INV-2026-9999', remoteTaxTotal: '7.00', remoteTotal: '107.00' });

    const outcome = await pushInvoiceToAccounting(INVOICE, PARTNER);

    expect(outcome.docNumber).toBe('INV-2026-9999');
    const mappingUpdate = updatedPatches.find((u) => 'remoteDocNumber' in u.patch);
    expect(mappingUpdate?.patch.remoteDocNumber).toBe('INV-2026-9999');
  });

  it('does not persist remote_doc_number when the QBO DocNumber matches the Breeze invoice number', async () => {
    pushInvoiceMock.mockResolvedValue({ id: 'qb-inv-1', syncToken: '0', docNumber: 'INV-2026-0001', remoteTaxTotal: '7.00', remoteTotal: '107.00' });

    const outcome = await pushInvoiceToAccounting(INVOICE, PARTNER);

    expect(outcome.docNumber).toBe('INV-2026-0001');
    const mappingUpdate = updatedPatches.find((u) => 'remoteDocNumber' in u.patch);
    expect(mappingUpdate?.patch.remoteDocNumber).toBeNull();
  });

  it('on provider failure, marks the mapping error with the exact sanitized message and rethrows quickbooks_error 502', async () => {
    pushInvoiceMock.mockRejectedValue(Object.assign(new Error('boom'), { status: 500 }));

    let caught: AccountingInvoicePushError | undefined;
    try {
      await pushInvoiceToAccounting(INVOICE, PARTNER);
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
      await pushInvoiceToAccounting(INVOICE, PARTNER);
    } catch (err) {
      caught = err as AccountingInvoicePushError;
    }

    expect(pushed).toBe(true);
    expect(caught?.code).toBe('record_failed');
    expect(caught?.status).toBe(502);
    expect(caught?.message).toContain('qb-inv-1');
    expect(caught?.message).toMatch(/do not retry/i);
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

    await pushInvoiceToAccounting(INVOICE, PARTNER);

    expect(insertedValues.some((v) => v.breezeEntityType === 'invoice')).toBe(false);
    const [, payload] = pushInvoiceMock.mock.calls[0]!;
    expect(payload.mapping).toEqual({ remoteEntityId: 'qb-inv-1', remoteSyncToken: '3' });
  });

  it('maps a concurrent-insert race (unique violation on first push) to quickbooks_error instead of a raw 500', async () => {
    setup({ mappings: [orgMappingRow()] });
    stubInsertWithViolation();
    insertUniqueViolation = 'accounting_entity_mappings_breeze_uniq';

    await expect(pushInvoiceToAccounting(INVOICE, PARTNER)).rejects.toMatchObject({ code: 'quickbooks_error', status: 502 });
    expect(pushInvoiceMock).not.toHaveBeenCalled();
  });
});

describe('voidInvoiceInAccounting', () => {
  it('resolves without calling the provider when the invoice was never pushed', async () => {
    setup({ mappings: [orgMappingRow()] }); // no invoice mapping row at all

    await expect(voidInvoiceInAccounting(INVOICE, PARTNER)).resolves.toBeUndefined();
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

    await voidInvoiceInAccounting(INVOICE, PARTNER);

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
      await voidInvoiceInAccounting(INVOICE, PARTNER);
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
