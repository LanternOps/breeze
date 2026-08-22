import { describe, it, expect, vi, beforeEach } from 'vitest';

// Controllable Drizzle chain mock (same pattern as invoiceService.test.ts /
// quoteService.test.ts): every builder method returns the same chain; a query
// resolves when awaited (the chain is a thenable that yields the next queued
// result). Tests queue the rows each db call should resolve to, in call order.
const results: unknown[][] = [];
function queueResult(rows: unknown[]) { results.push(rows); }

vi.mock('../db', () => {
  const makeChain = () => {
    const chain: Record<string, unknown> = {};
    const methods = ['select', 'from', 'where', 'limit', 'orderBy', 'insert', 'values', 'returning', 'update', 'set', 'delete', 'for', 'innerJoin', 'leftJoin', 'execute', 'onConflictDoNothing'];
    for (const m of methods) chain[m] = vi.fn(() => chain);
    // Execute the callback with the same chain as `tx` — each awaited tx call
    // still consumes one queued result, exactly like a bare db call.
    chain.transaction = vi.fn(async (run: (tx: unknown) => unknown) => run(chain));
    (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) => {
      const rows = results.shift() ?? [];
      return Promise.resolve(rows).then(resolve);
    };
    return chain;
  };
  const db = makeChain();
  return {
    db,
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
  };
});

// generateDueInvoice dependencies — not under test here; stubbed so importing
// contractService doesn't pull the invoice/PDF/queue stack into this suite.
vi.mock('./contractEvents', () => ({ emitContractEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./invoiceService', () => ({
  createManualInvoice: vi.fn(), addContractLine: vi.fn(), deleteDraftInvoice: vi.fn(),
}));
vi.mock('./contractQuantities', () => ({ countContractDevices: vi.fn(), countContractSeats: vi.fn() }));
// Multi-currency wave 3 (#3775): catalog contract lines price through the
// resolver. Mock only resolvePrice; CatalogServiceError stays real so the
// NO_PRICE_FOR_CURRENCY mapping is exercised against the genuine class.
vi.mock('./catalogService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./catalogService')>();
  return { ...actual, resolvePrice: vi.fn() };
});

import * as svc from './contractService';
import { db } from '../db';
import { resolvePrice, CatalogServiceError } from './catalogService';
import { createManualInvoice, addContractLine } from './invoiceService';

const resolvePriceMock = vi.mocked(resolvePrice);

type Chain = { set: { mock: { calls: unknown[][] } }; delete: { mock: { calls: unknown[][] } } };

const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'] };

describe('changeContractCurrency (draft currency immutability, #3774)', () => {
  beforeEach(() => { results.length = 0; vi.clearAllMocks(); });

  it('rejects a non-draft contract with NOT_A_DRAFT (409)', async () => {
    queueResult([{ id: 'c1', status: 'active', orgId: 'org1', partnerId: 'p1', currencyCode: 'USD' }]);
    await expect(
      svc.changeContractCurrency('c1', { currencyCode: 'EUR', clearLines: false }, actor)
    ).rejects.toMatchObject({ code: 'NOT_A_DRAFT', status: 409 });
  });

  it('throws CONTRACT_NOT_FOUND (404) when the contract is absent', async () => {
    queueResult([]);
    await expect(
      svc.changeContractCurrency('missing', { currencyCode: 'EUR', clearLines: false }, actor)
    ).rejects.toMatchObject({ code: 'CONTRACT_NOT_FOUND', status: 404 });
  });

  it('refuses to restamp over monetary lines without clearLines (CURRENCY_LOCKED 409)', async () => {
    queueResult([{ id: 'c1', status: 'draft', orgId: 'org1', partnerId: 'p1', currencyCode: 'USD' }]);
    queueResult([{ id: 'l1' }]); // one contract line
    await expect(
      svc.changeContractCurrency('c1', { currencyCode: 'EUR', clearLines: false }, actor)
    ).rejects.toMatchObject({ code: 'CURRENCY_LOCKED', status: 409 });
    expect((db as unknown as Chain).delete.mock.calls.length).toBe(0);
  });

  it('restamps a line-less draft and returns the new currency', async () => {
    queueResult([{ id: 'c1', status: 'draft', orgId: 'org1', partnerId: 'p1', currencyCode: 'USD' }]);
    queueResult([]); // no lines
    queueResult([{ id: 'c1', status: 'draft', orgId: 'org1', currencyCode: 'EUR' }]); // update returning
    const updated = await svc.changeContractCurrency('c1', { currencyCode: 'EUR', clearLines: false }, actor);
    expect(updated.currencyCode).toBe('EUR');
    const setMock = (db as unknown as Chain).set;
    expect(setMock.mock.calls[0]![0]).toMatchObject({ currencyCode: 'EUR' });
    expect((db as unknown as Chain).delete.mock.calls.length).toBe(0);
  });

  it('clearLines: true deletes the lines and restamps atomically', async () => {
    queueResult([{ id: 'c1', status: 'draft', orgId: 'org1', partnerId: 'p1', currencyCode: 'EUR' }]);
    queueResult([{ id: 'l1' }, { id: 'l2' }]); // two contract lines
    queueResult([]); // delete
    queueResult([{ id: 'c1', status: 'draft', orgId: 'org1', currencyCode: 'JPY' }]); // update returning
    const updated = await svc.changeContractCurrency('c1', { currencyCode: 'JPY', clearLines: true }, actor);
    expect(updated.currencyCode).toBe('JPY');
    expect((db as unknown as Chain).delete.mock.calls.length).toBe(1);
  });

  it('same-currency change is a no-op (returns the row untouched)', async () => {
    queueResult([{ id: 'c1', status: 'draft', orgId: 'org1', partnerId: 'p1', currencyCode: 'EUR' }]);
    const updated = await svc.changeContractCurrency('c1', { currencyCode: 'EUR', clearLines: true }, actor);
    expect(updated.currencyCode).toBe('EUR');
    const setMock = (db as unknown as Chain).set;
    expect(setMock.mock.calls.length).toBe(0);
    expect((db as unknown as Chain).delete.mock.calls.length).toBe(0);
  });

  it('denies an actor without access to the contract org (ORG_DENIED 403)', async () => {
    queueResult([{ id: 'c1', status: 'draft', orgId: 'org1', partnerId: 'p1', currencyCode: 'USD' }]);
    const denied = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['other-org'] };
    await expect(
      svc.changeContractCurrency('c1', { currencyCode: 'EUR', clearLines: false }, denied)
    ).rejects.toMatchObject({ code: 'ORG_DENIED', status: 403 });
  });
});

describe('changeContractCurrency reprice (price-book reprice of catalog lines, #3775)', () => {
  beforeEach(() => { results.length = 0; vi.clearAllMocks(); });
  const draft = { id: 'c1', status: 'draft', orgId: 'org1', partnerId: 'p1', currencyCode: 'USD' };
  const resolved = {
    unitPrice: '20.00', currencyCode: 'EUR', costBasis: null, costCurrency: 'USD',
    marginAvailable: false, taxable: true, taxCategory: null, source: 'price_book' as const,
  };

  it('reprices catalog lines from the price book and restamps — no delete', async () => {
    queueResult([draft]);
    queueResult([{ id: 'l1', catalogItemId: 'cat1' }, { id: 'l2', catalogItemId: 'cat2' }]);
    resolvePriceMock.mockResolvedValueOnce(resolved).mockResolvedValueOnce({ ...resolved, unitPrice: '5.00' });
    queueResult([]); // l1 update
    queueResult([]); // l2 update
    queueResult([{ ...draft, currencyCode: 'EUR' }]); // header update returning
    const updated = await svc.changeContractCurrency('c1', { currencyCode: 'EUR', reprice: true }, actor);
    expect(updated.currencyCode).toBe('EUR');
    expect(resolvePriceMock).toHaveBeenCalledTimes(2);
    expect(resolvePriceMock).toHaveBeenNthCalledWith(1, 'cat1', 'EUR', 'org1', { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'] }, db);
    expect(resolvePriceMock).toHaveBeenNthCalledWith(2, 'cat2', 'EUR', 'org1', { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'] }, db);
    const setMock = (db as unknown as Chain).set;
    expect(setMock.mock.calls[0]![0]).toEqual({ unitPrice: '20.00' });
    expect(setMock.mock.calls[1]![0]).toEqual({ unitPrice: '5.00' });
    expect(setMock.mock.calls[2]![0]).toMatchObject({ currencyCode: 'EUR' });
    expect((db as unknown as Chain).delete.mock.calls.length).toBe(0);
  });

  it('refuses reprice when a non-catalog line exists (CURRENCY_LOCKED 409)', async () => {
    queueResult([draft]);
    queueResult([{ id: 'l1', catalogItemId: 'cat1' }, { id: 'l2', catalogItemId: null }]);
    await expect(
      svc.changeContractCurrency('c1', { currencyCode: 'EUR', reprice: true }, actor)
    ).rejects.toMatchObject({ code: 'CURRENCY_LOCKED', status: 409, message: expect.stringContaining('1 non-catalog line(s) cannot be repriced — pass clearLines instead') });
    expect(resolvePriceMock).not.toHaveBeenCalled();
    expect((db as unknown as Chain).set.mock.calls.length).toBe(0);
    expect((db as unknown as Chain).delete.mock.calls.length).toBe(0);
  });

  it('a price-book gap aborts the reprice as NO_PRICE_FOR_CURRENCY (409) — header never restamped', async () => {
    queueResult([draft]);
    queueResult([{ id: 'l1', catalogItemId: 'cat1' }]);
    resolvePriceMock.mockRejectedValueOnce(new CatalogServiceError('No price for "Managed endpoint" in EUR', 409, 'NO_PRICE_FOR_CURRENCY'));
    await expect(
      svc.changeContractCurrency('c1', { currencyCode: 'EUR', reprice: true }, actor)
    ).rejects.toMatchObject({ code: 'NO_PRICE_FOR_CURRENCY', status: 409, message: expect.stringContaining('Managed endpoint') });
    expect((db as unknown as Chain).set.mock.calls.length).toBe(0);
  });
});

// #3774 phantom-line race: contract line writers must take the contract row
// lock (SELECT ... FOR UPDATE) as the FIRST statement of a transaction — the
// same lock changeContractCurrency takes — so a restamp can never interleave
// between a writer's read of the contract and its line insert/delete.
describe('contract line writers lock the contract row first (#3774)', () => {
  beforeEach(() => { results.length = 0; vi.clearAllMocks(); });

  type LockChain = Chain & {
    for: { mock: { calls: unknown[][] } };
    transaction: { mock: { calls: unknown[][] } };
    values: { mock: { calls: unknown[][] } };
  };

  it('addContractLineToContract runs in a transaction and takes the contract row FOR UPDATE', async () => {
    queueResult([{ id: 'c1', status: 'draft', orgId: 'org1', partnerId: 'p1', currencyCode: 'USD' }]); // lockContract
    queueResult([{ id: 'l1', contractId: 'c1' }]); // insert returning

    const row = await svc.addContractLineToContract('c1', {
      lineType: 'manual', description: 'Managed services', unitPrice: '500.00',
      taxable: false, manualQuantity: '1',
    } as never, actor);
    expect(row).toMatchObject({ id: 'l1' });

    const chain = db as unknown as LockChain;
    expect(chain.transaction.mock.calls.length).toBe(1);
    expect(chain.for.mock.calls[0]).toEqual(['update']);
    expect(chain.values.mock.calls[0]![0]).toMatchObject({ contractId: 'c1', orgId: 'org1', unitPrice: '500.00' });
  });

  it('addContractLineToContract rejects a cancelled contract off the locked row (INVALID_STATE, no insert)', async () => {
    queueResult([{ id: 'c1', status: 'cancelled', orgId: 'org1', partnerId: 'p1', currencyCode: 'USD' }]); // lockContract
    await expect(
      svc.addContractLineToContract('c1', {
        lineType: 'manual', description: 'X', unitPrice: '1.00', taxable: false, manualQuantity: '1',
      } as never, actor)
    ).rejects.toMatchObject({ code: 'INVALID_STATE', status: 409 });
    expect((db as unknown as LockChain).values.mock.calls.length).toBe(0);
  });

  it('addContractLineToContract denies an out-of-scope actor before writing (ORG_DENIED 403)', async () => {
    queueResult([{ id: 'c1', status: 'draft', orgId: 'org1', partnerId: 'p1', currencyCode: 'USD' }]); // lockContract
    const denied = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['other-org'] };
    await expect(
      svc.addContractLineToContract('c1', {
        lineType: 'manual', description: 'X', unitPrice: '1.00', taxable: false, manualQuantity: '1',
      } as never, denied)
    ).rejects.toMatchObject({ code: 'ORG_DENIED', status: 403 });
    expect((db as unknown as LockChain).values.mock.calls.length).toBe(0);
  });

  it('removeContractLine locks the contract row FOR UPDATE before deleting', async () => {
    queueResult([{ id: 'c1', status: 'active', orgId: 'org1', partnerId: 'p1', currencyCode: 'USD' }]); // lockContract (active is line-editable)
    queueResult([]); // delete (unused result)

    await svc.removeContractLine('c1', 'l1', actor);

    const chain = db as unknown as LockChain;
    expect(chain.transaction.mock.calls.length).toBe(1);
    expect(chain.for.mock.calls[0]).toEqual(['update']);
    expect((db as unknown as Chain).delete.mock.calls.length).toBe(1);
  });
});

describe('catalog contract lines price through the resolver (#3775)', () => {
  beforeEach(() => { results.length = 0; vi.clearAllMocks(); });
  type ValuesChain = { values: { mock: { calls: unknown[][] } } };

  it('addContractLineToContract uses the resolver unitPrice AND taxable, ignoring client-supplied values', async () => {
    resolvePriceMock.mockResolvedValue({
      unitPrice: '77.00', currencyCode: 'EUR', costBasis: null, costCurrency: 'EUR',
      marginAvailable: true, taxable: true, taxCategory: null, source: 'price_book',
    });
    queueResult([{ id: 'c1', status: 'draft', orgId: 'org1', partnerId: 'p1', currencyCode: 'EUR' }]); // lockContract
    queueResult([{ id: 'l1', contractId: 'c1', unitPrice: '77.00', taxable: true }]); // insert returning

    const row = await svc.addContractLineToContract('c1', {
      lineType: 'flat', description: 'Managed endpoint', unitPrice: '1', taxable: false, catalogItemId: 'cat-1',
    } as never, actor);
    expect(row).toMatchObject({ id: 'l1' });
    expect(resolvePrice).toHaveBeenCalledWith(
      'cat-1', 'EUR', 'org1',
      expect.objectContaining({ userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'] }),
      expect.anything()
    );
    expect((db as unknown as ValuesChain).values.mock.calls[0]![0]).toMatchObject({
      contractId: 'c1', orgId: 'org1', catalogItemId: 'cat-1', unitPrice: '77.00', taxable: true,
    });
  });

  it('addContractLineToContract maps a price-book gap to NO_PRICE_FOR_CURRENCY (409) and inserts nothing', async () => {
    resolvePriceMock.mockRejectedValue(new CatalogServiceError('No EUR price', 409, 'NO_PRICE_FOR_CURRENCY'));
    queueResult([{ id: 'c1', status: 'draft', orgId: 'org1', partnerId: 'p1', currencyCode: 'EUR' }]); // lockContract
    await expect(
      svc.addContractLineToContract('c1', {
        lineType: 'flat', description: 'Managed endpoint', taxable: false, catalogItemId: 'cat-1',
      } as never, actor)
    ).rejects.toMatchObject({ code: 'NO_PRICE_FOR_CURRENCY', status: 409 });
    expect((db as unknown as ValuesChain).values.mock.calls.length).toBe(0);
  });

  it('addContractLineToContract non-catalog path still stamps the client unitPrice/taxable verbatim', async () => {
    queueResult([{ id: 'c1', status: 'draft', orgId: 'org1', partnerId: 'p1', currencyCode: 'EUR' }]); // lockContract
    queueResult([{ id: 'l1', contractId: 'c1' }]); // insert returning
    await svc.addContractLineToContract('c1', {
      lineType: 'flat', description: 'Onboarding', unitPrice: '250.00', taxable: true,
    } as never, actor);
    expect(resolvePrice).not.toHaveBeenCalled();
    expect((db as unknown as ValuesChain).values.mock.calls[0]![0]).toMatchObject({ unitPrice: '250.00', taxable: true, catalogItemId: null });
  });
});

describe('generateDueInvoice surfaces price-book gaps (#3775)', () => {
  beforeEach(() => { results.length = 0; vi.clearAllMocks(); });

  const contract = {
    id: 'c1', orgId: 'org1', partnerId: 'p1', status: 'active', currencyCode: 'EUR',
    startDate: '2026-07-01', intervalMonths: 1, billingTiming: 'advance', nextBillingAt: '2026-07-01',
    endDate: null, autoIssue: false, createdBy: 'u1', notes: null, terms: null,
  };
  const asOf = new Date('2026-07-01T06:00:00Z');

  function queueRun(lines: unknown[]) {
    queueResult([contract]);          // contract select
    queueResult(lines);               // contract lines
    queueResult([{ id: 'bp1' }]);     // claim period (won)
    queueResult([]);                  // advance pointer
  }

  it('collects every catalog line billed at the contract snapshot into priceBookGaps', async () => {
    vi.mocked(createManualInvoice).mockResolvedValue({ id: 'inv1' } as never);
    vi.mocked(addContractLine)
      .mockResolvedValueOnce({ line: { id: 'il1' }, pricedFrom: 'contract_snapshot' } as never)
      .mockResolvedValueOnce({ line: { id: 'il2' }, pricedFrom: 'price_book' } as never)
      .mockResolvedValueOnce({ line: { id: 'il3' }, pricedFrom: 'contract_snapshot' } as never);
    queueRun([
      { id: 'cl-1', lineType: 'flat', description: 'Managed endpoint', unitPrice: '80.00', taxable: true, catalogItemId: 'cat-1', manualQuantity: null, siteId: null },
      { id: 'cl-2', lineType: 'flat', description: 'Backup', unitPrice: '20.00', taxable: true, catalogItemId: 'cat-2', manualQuantity: null, siteId: null },
      // Non-catalog lines are always "contract_snapshot" priced — never a gap.
      { id: 'cl-3', lineType: 'flat', description: 'Onboarding', unitPrice: '250.00', taxable: false, catalogItemId: null, manualQuantity: null, siteId: null },
    ]);

    const res = await svc.generateDueInvoice('c1', asOf);
    expect(res.generated).toBe(true);
    expect(res.invoiceId).toBe('inv1');
    expect(res.priceBookGaps).toEqual([
      { contractLineId: 'cl-1', catalogItemId: 'cat-1', itemName: 'Managed endpoint', currencyCode: 'EUR' },
    ]);
    // The catalog line was still billed (fallback, never skipped).
    expect(addContractLine).toHaveBeenCalledTimes(3);
    expect(addContractLine).toHaveBeenNthCalledWith(1, 'inv1', expect.objectContaining({ catalogItemId: 'cat-1', unitPrice: '80.00', sourceId: 'cl-1' }), expect.anything());
  });

  it('returns an empty priceBookGaps array when every catalog line resolved from the price book', async () => {
    vi.mocked(createManualInvoice).mockResolvedValue({ id: 'inv1' } as never);
    vi.mocked(addContractLine).mockResolvedValue({ line: { id: 'il1' }, pricedFrom: 'price_book' } as never);
    queueRun([
      { id: 'cl-1', lineType: 'flat', description: 'Managed endpoint', unitPrice: '80.00', taxable: true, catalogItemId: 'cat-1', manualQuantity: null, siteId: null },
    ]);
    const res = await svc.generateDueInvoice('c1', asOf);
    expect(res.generated).toBe(true);
    expect(res.priceBookGaps).toEqual([]);
  });

  it('a not-due contract reports no gaps (always-present array)', async () => {
    queueResult([{ ...contract, nextBillingAt: '2026-08-01' }]);
    const res = await svc.generateDueInvoice('c1', asOf);
    expect(res).toMatchObject({ generated: false, skipped: 'not_due', priceBookGaps: [] });
  });
});
