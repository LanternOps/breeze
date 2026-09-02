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
vi.mock('./contractQuantities', () => ({
  countContractDevices: vi.fn(), countContractSeats: vi.fn(), snapshotContractDevices: vi.fn(),
}));
// Multi-currency wave 3 (#3775): catalog contract lines price through the
// resolver. Mock only resolvePrice; CatalogServiceError stays real so the
// NO_PRICE_FOR_CURRENCY mapping is exercised against the genuine class.
vi.mock('./catalogService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./catalogService')>();
  return { ...actual, resolvePrice: vi.fn() };
});
// Multi-currency wave 7 (#3779): the MRR rollup prices catalog lines through the
// SAME pure price-book resolver billing uses. Spy on it while calling through —
// the resolution rules themselves stay under catalogPricing.test.ts.
vi.mock('./catalogPricing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./catalogPricing')>();
  return { ...actual, resolvePriceFrom: vi.fn(actual.resolvePriceFrom) };
});

import * as svc from './contractService';
import { db } from '../db';
import { resolvePrice, CatalogServiceError } from './catalogService';
import { resolvePriceFrom } from './catalogPricing';
import { createManualInvoice, addContractLine } from './invoiceService';
import { countContractDevices, countContractSeats, snapshotContractDevices } from './contractQuantities';

const resolvePriceMock = vi.mocked(resolvePrice);

type Chain = { set: { mock: { calls: unknown[][] } }; delete: { mock: { calls: unknown[][] } } };

const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'] };

describe('changeContractCurrency (draft currency immutability, #3774)', () => {
  beforeEach(() => { results.length = 0; vi.clearAllMocks(); });

  // 'active' moved to the wave-6 escape-hatch suite below (#3778): an ACTIVE
  // contract is now gated on contracts:manage + confirmActiveChange +
  // eligibility, not on a blanket NOT_A_DRAFT. Every OTHER non-draft status
  // keeps the wave-2 rejection byte-for-byte, which is what this asserts.
  it('rejects a non-draft contract with NOT_A_DRAFT (409)', async () => {
    queueResult([{ id: 'c1', status: 'paused', orgId: 'org1', partnerId: 'p1', currencyCode: 'USD' }]);
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
    ).rejects.toMatchObject({ code: 'CURRENCY_LOCKED', status: 409, message: expect.stringContaining('1 non-catalog line(s) have no price in the new currency — remove all lines first, or keep the current currency') });
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

  // #3205
  it('bills per_device_role from one org snapshot and returns uncoveredDevices', async () => {
    vi.mocked(createManualInvoice).mockResolvedValue({ id: 'inv1' } as never);
    vi.mocked(addContractLine).mockResolvedValue({ line: { id: 'il1' }, pricedFrom: 'contract_snapshot' } as never);
    vi.mocked(snapshotContractDevices).mockResolvedValue([
      { role: 'server', siteId: null, n: 2 },
      { role: 'workstation', siteId: null, n: 5 },
      { role: 'unknown', siteId: null, n: 1 },
    ]);
    queueRun([
      { id: 'cl-1', lineType: 'per_device_role', description: 'Servers', unitPrice: '40.00', taxable: false, catalogItemId: null, manualQuantity: null, siteId: null, deviceRoles: ['server'] },
      { id: 'cl-2', lineType: 'per_device_role', description: 'Workstations', unitPrice: '10.00', taxable: false, catalogItemId: null, manualQuantity: null, siteId: null, deviceRoles: ['workstation'] },
    ]);

    const res = await svc.generateDueInvoice('c1', asOf);
    expect(res.generated).toBe(true);
    expect(vi.mocked(snapshotContractDevices)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(countContractDevices)).not.toHaveBeenCalled();
    expect(vi.mocked(addContractLine).mock.calls[0]![1]).toMatchObject({ description: 'Servers', quantity: '2' });
    expect(vi.mocked(addContractLine).mock.calls[1]![1]).toMatchObject({ description: 'Workstations', quantity: '5' });
    expect(res.uncoveredDevices).toEqual({ total: 1, byRole: { unknown: 1 } });
  });

  it('returns uncoveredDevices: null when no device-counted line exists', async () => {
    vi.mocked(createManualInvoice).mockResolvedValue({ id: 'inv1' } as never);
    vi.mocked(addContractLine).mockResolvedValue({ line: { id: 'il1' }, pricedFrom: 'contract_snapshot' } as never);
    queueRun([{ id: 'cl-1', lineType: 'flat', description: 'Fee', unitPrice: '80.00', taxable: true, catalogItemId: null, manualQuantity: null, siteId: null, deviceRoles: null }]);
    const res = await svc.generateDueInvoice('c1', asOf);
    expect(res.uncoveredDevices).toBeNull();
    expect(vi.mocked(snapshotContractDevices)).not.toHaveBeenCalled();
  });
});

// Wave-6 release gate (W6-G3-1): a contract line is the template every future
// generated invoice snapshots from, so a hand-entered non-catalog price must be
// representable in the CONTRACT's stamped currency before it can propagate.
describe('contractService currency representability guard (W6-G3-1)', () => {
  beforeEach(() => { results.length = 0; vi.clearAllMocks(); });

  const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'] };
  const draft = (currencyCode: string) => ({ id: 'c1', status: 'draft', orgId: 'org1', partnerId: 'p1', currencyCode });

  it('addContractLineToContract rejects a fractional minor unit on a JPY contract (PRICE_NOT_REPRESENTABLE 400)', async () => {
    queueResult([draft('JPY')]); // lockContract
    await expect(
      svc.addContractLineToContract('c1', { lineType: 'flat', description: 'x', unitPrice: '100.50', taxable: false } as never, actor)
    ).rejects.toMatchObject({ code: 'PRICE_NOT_REPRESENTABLE', status: 400 });
    expect((db as unknown as { insert: { mock: { calls: unknown[][] } } }).insert.mock.calls.length).toBe(0);
  });

  it('addContractLineToContract accepts a whole-unit JPY price', async () => {
    queueResult([draft('JPY')]);
    queueResult([{ id: 'l1', unitPrice: '100.00' }]); // insert returning
    await expect(
      svc.addContractLineToContract('c1', { lineType: 'flat', description: 'x', unitPrice: '100.00', taxable: false } as never, actor)
    ).resolves.toMatchObject({ id: 'l1' });
  });

  it('addContractLineToContract leaves a 2-decimal currency unchanged — 100.50 EUR is accepted', async () => {
    queueResult([draft('EUR')]);
    queueResult([{ id: 'l1', unitPrice: '100.50' }]);
    await expect(
      svc.addContractLineToContract('c1', { lineType: 'flat', description: 'x', unitPrice: '100.50', taxable: false } as never, actor)
    ).resolves.toMatchObject({ id: 'l1' });
  });

  it('createContractWithLinesDetailed applies the same guard — the quote→contract path is not a way around it', async () => {
    queueResult([{ id: 'c1', orgId: 'org1', partnerId: 'p1', currencyCode: 'JPY', status: 'draft' }]); // contract insert returning
    await expect(
      svc.createContractWithLinesDetailed({
        partnerId: 'p1', orgId: 'org1', name: 'C', billingTiming: 'advance', intervalMonths: 1,
        startDate: '2026-01-01', currencyCode: 'JPY',
        lines: [{ lineType: 'flat', description: 'x', unitPrice: '100.50', taxable: false }],
      } as never)
    ).rejects.toMatchObject({ code: 'PRICE_NOT_REPRESENTABLE', status: 400 });
  });
});

// ---------------------------------------------------------------------------
// Multi-currency wave 6 (#3778), Task 14 — the owner-approved ACTIVE-contract
// currency restamp. Pre-wave-2 ACTIVE contracts stamped 'USD' under a non-USD
// org would otherwise bill USD forever: wave 2 removed issueInvoice's
// partner-currency overwrite and changeContractCurrency is draft-only, while
// generateDueInvoice faithfully propagates the stale stamp.
// ---------------------------------------------------------------------------
describe('changeContractCurrency — ACTIVE escape hatch (#3778)', () => {
  beforeEach(() => { results.length = 0; vi.clearAllMocks(); });

  /** An actor carrying VERIFIED contracts:manage evidence (route-populated). */
  const manageActor = { ...actor, permissions: new Set(['contracts:read', 'contracts:write', 'contracts:manage']) };
  /** contracts:write only — exactly what the route's own middleware grants. */
  const writeOnlyActor = { ...actor, permissions: new Set(['contracts:read', 'contracts:write']) };

  const activeContract = { id: 'c1', status: 'active', orgId: 'org1', partnerId: 'p1', currencyCode: 'USD' };

  /** Queue the five reads inspectContractCurrencyEligibility performs. */
  function queueEligibility(over: {
    reachable?: unknown[]; direct?: unknown[]; orphanSources?: unknown[]; periods?: unknown[];
  } = {}) {
    queueResult([{ id: 'c1', orgId: 'org1', partnerId: 'p1' }]); // contract re-read inside inspect
    queueResult(over.reachable ?? []);      // period invoices + reissue descendants
    queueResult(over.direct ?? []);         // draft invoices holding source_contract_id lines
    queueResult(over.orphanSources ?? []);  // org-wide unattributable contract-source lines
    queueResult(over.periods ?? []);        // per-period lineage proof
  }

  it('denies an actor without contracts:manage (ACTIVE_CHANGE_FORBIDDEN 403)', async () => {
    queueResult([activeContract]);
    await expect(
      svc.changeContractCurrency('c1', { currencyCode: 'EUR', confirmActiveChange: true }, writeOnlyActor)
    ).rejects.toMatchObject({ code: 'ACTIVE_CHANGE_FORBIDDEN', status: 403 });
    expect((db as unknown as Chain).set.mock.calls.length).toBe(0);
  });

  it('denies an actor carrying NO permission evidence at all (fail-closed by construction)', async () => {
    queueResult([activeContract]);
    // System/background callers (contractWorker, generateDueInvoice) look exactly
    // like this — they can never reach the ACTIVE branch.
    await expect(
      svc.changeContractCurrency('c1', { currencyCode: 'EUR', confirmActiveChange: true }, actor)
    ).rejects.toMatchObject({ code: 'ACTIVE_CHANGE_FORBIDDEN', status: 403 });
  });

  it('requires confirmActiveChange (ACTIVE_CHANGE_CONFIRMATION_REQUIRED 400)', async () => {
    queueResult([activeContract]);
    await expect(
      svc.changeContractCurrency('c1', { currencyCode: 'EUR' }, manageActor)
    ).rejects.toMatchObject({ code: 'ACTIVE_CHANGE_CONFIRMATION_REQUIRED', status: 400 });
    expect((db as unknown as Chain).set.mock.calls.length).toBe(0);
  });

  it('runs the eligibility inspect AFTER the contract FOR UPDATE, never before it', async () => {
    queueResult([activeContract]);
    queueEligibility();
    queueResult([]);                       // no contract lines
    queueResult([{ ...activeContract, currencyCode: 'EUR' }]); // update returning

    await svc.changeContractCurrency('c1', { currencyCode: 'EUR', confirmActiveChange: true }, manageActor);

    const chain = db as unknown as { for: { mock: { calls: unknown[][]; invocationCallOrder: number[] } };
                                     execute: { mock: { invocationCallOrder: number[] } } };
    expect(chain.for.mock.calls[0]).toEqual(['update']);
    // The eligibility SQL (tx.execute) must be strictly after the row lock.
    expect(chain.execute.mock.invocationCallOrder[0]).toBeGreaterThan(chain.for.mock.invocationCallOrder[0]!);
  });

  it('restamps an eligible line-less ACTIVE contract, touching only currency_code + updated_at', async () => {
    queueResult([activeContract]);
    queueEligibility();
    queueResult([]);
    queueResult([{ ...activeContract, currencyCode: 'EUR' }]);

    const updated = await svc.changeContractCurrency('c1', { currencyCode: 'EUR', confirmActiveChange: true }, manageActor);
    expect(updated).toMatchObject({ currencyCode: 'EUR' });
    const patch = (db as unknown as Chain).set.mock.calls[0]![0] as Record<string, unknown>;
    expect(Object.keys(patch).sort()).toEqual(['currencyCode', 'updatedAt']);
  });

  it('rejects with UNBILLED_MONETARY_ROWS carrying the draft invoice ids', async () => {
    queueResult([activeContract]);
    queueEligibility({ reachable: [{ id: 'inv-draft', status: 'draft' }] });
    await expect(
      svc.changeContractCurrency('c1', { currencyCode: 'EUR', confirmActiveChange: true }, manageActor)
    ).rejects.toMatchObject({
      code: 'UNBILLED_MONETARY_ROWS', status: 409, details: { draftInvoiceIds: ['inv-draft'] },
    });
    expect((db as unknown as Chain).set.mock.calls.length).toBe(0);
  });

  it('rejects with ORPHANED_CONTRACT_SOURCE when an unattributable contract line exists in the org', async () => {
    queueResult([activeContract]);
    queueEligibility({ orphanSources: [{ id: 'line-orphan' }] });
    await expect(
      svc.changeContractCurrency('c1', { currencyCode: 'EUR', confirmActiveChange: true }, manageActor)
    ).rejects.toMatchObject({
      code: 'ORPHANED_CONTRACT_SOURCE', status: 409, details: { lineIds: ['line-orphan'] },
    });
  });

  it('rejects with ORPHANED_BILLING_PERIOD when a period row points at nothing', async () => {
    queueResult([activeContract]);
    queueEligibility({ periods: [{ period_id: 'cbp1', invoice_id: null, invoice_exists: false, same_tenant: false, attributable: false, ancestry_ok: false }] });
    await expect(
      svc.changeContractCurrency('c1', { currencyCode: 'EUR', confirmActiveChange: true }, manageActor)
    ).rejects.toMatchObject({
      code: 'ORPHANED_BILLING_PERIOD', status: 409, details: { billingPeriodIds: ['cbp1'] },
    });
  });

  it('rejects with BROKEN_CONTRACT_LINEAGE when a period invoice fails the tenancy/attribution/ancestry proof', async () => {
    queueResult([activeContract]);
    queueEligibility({ periods: [{ period_id: 'cbp1', invoice_id: 'inv-x', invoice_exists: true, same_tenant: false, attributable: true, ancestry_ok: true }] });
    await expect(
      svc.changeContractCurrency('c1', { currencyCode: 'EUR', confirmActiveChange: true }, manageActor)
    ).rejects.toMatchObject({
      code: 'BROKEN_CONTRACT_LINEAGE', status: 409, details: { invoiceIds: ['inv-x'] },
    });
  });

  it('leaves every non-active, non-draft status on the unchanged NOT_A_DRAFT rejection', async () => {
    for (const status of ['paused', 'cancelled', 'expired']) {
      results.length = 0; vi.clearAllMocks();
      queueResult([{ ...activeContract, status }]);
      await expect(
        svc.changeContractCurrency('c1', { currencyCode: 'EUR', confirmActiveChange: true }, manageActor)
      ).rejects.toMatchObject({ code: 'NOT_A_DRAFT', status: 409 });
    }
  });
});

// ---------------------------------------------------------------------------
// Multi-currency wave 7 (#3779): per-currency partner-dashboard MRR.
// ---------------------------------------------------------------------------
describe('summarizeActiveContractMrrByOrg (#3779)', () => {
  beforeEach(() => {
    results.length = 0;
    vi.clearAllMocks();
    vi.mocked(countContractDevices).mockResolvedValue(0);
    vi.mocked(countContractSeats).mockResolvedValue(0);
    vi.mocked(snapshotContractDevices).mockResolvedValue([]);
  });

  /** Every bound parameter value inside a Drizzle SQL/condition tree. */
  function collectParams(node: unknown, out: unknown[] = [], seen = new Set<unknown>()): unknown[] {
    if (node === null || typeof node !== 'object' || seen.has(node)) return out;
    seen.add(node);
    if (Array.isArray(node)) { for (const c of node) collectParams(c, out, seen); return out; }
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'value') {
        if (Array.isArray(child)) out.push(...child.filter((v) => typeof v !== 'object'));
        else if (child !== null && typeof child !== 'object') out.push(child);
      }
      if (child && typeof child === 'object') collectParams(child, out, seen);
    }
    return out;
  }

  const contract = (over: Record<string, unknown> = {}) => ({
    id: 'c1', orgId: 'org1', status: 'active', currencyCode: 'USD', intervalMonths: 1, ...over,
  });
  const line = (over: Record<string, unknown> = {}) => ({
    id: 'l1', contractId: 'c1', lineType: 'flat', unitPrice: '100.00',
    manualQuantity: null, siteId: null, catalogItemId: null, ...over,
  });

  it('returns an empty map without querying when no org ids are given', async () => {
    const out = await svc.summarizeActiveContractMrrByOrg([]);
    expect(out.size).toBe(0);
    expect((db as unknown as { select: { mock: { calls: unknown[][] } } }).select.mock.calls.length).toBe(0);
  });

  it('filters on status=active and the requested org ids in the contract query', async () => {
    queueResult([]);
    await svc.summarizeActiveContractMrrByOrg(['org1', 'org2']);
    const where = (db as unknown as { where: { mock: { calls: unknown[][] } } }).where.mock.calls[0]![0];
    const params = collectParams(where);
    expect(params).toContain('active');
    expect(params).toContain('org1');
    expect(params).toContain('org2');
  });

  // A contract is flipped to 'expired' LAZILY by generateInvoices/renewal at its
  // NEXT billing date — there is no expiry reaper — so `status = 'active'` alone
  // reports an already-ended contract for up to a full billing interval, while
  // billing itself skips it via isExpired. The rollup must apply the same guard.
  it('excludes an ACTIVE contract whose due period already starts on/after endDate', async () => {
    queueResult([contract({
      intervalMonths: 12, billingTiming: 'advance',
      startDate: '2025-09-01', endDate: '2026-07-31', nextBillingAt: '2026-09-01',
    })]);
    queueResult([line({ unitPrice: '1200.00' })]);
    const out = await svc.summarizeActiveContractMrrByOrg(['org1'], new Date('2026-08-23T00:00:00.000Z'));
    expect(out.has('org1')).toBe(false);
  });

  it('still counts an ARREARS contract whose due period started before endDate', async () => {
    queueResult([contract({
      intervalMonths: 12, billingTiming: 'arrears',
      startDate: '2025-09-01', endDate: '2026-09-01', nextBillingAt: '2026-09-01',
    })]);
    queueResult([line({ unitPrice: '1200.00' })]);
    const out = await svc.summarizeActiveContractMrrByOrg(['org1'], new Date('2026-08-23T00:00:00.000Z'));
    expect(out.get('org1')).toEqual([{ currencyCode: 'USD', amount: '100.00' }]);
  });

  it('excludes an ACTIVE contract past its endDate with no nextBillingAt pointer', async () => {
    queueResult([contract({ endDate: '2026-07-31', nextBillingAt: null })]);
    queueResult([line({ unitPrice: '50.00' })]);
    const out = await svc.summarizeActiveContractMrrByOrg(['org1'], new Date('2026-08-23T00:00:00.000Z'));
    expect(out.has('org1')).toBe(false);
  });

  it('keeps an open-ended (endDate null) contract', async () => {
    queueResult([contract({ endDate: null, nextBillingAt: '2026-09-01', billingTiming: 'advance' })]);
    queueResult([line({ unitPrice: '50.00' })]);
    const out = await svc.summarizeActiveContractMrrByOrg(['org1'], new Date('2026-08-23T00:00:00.000Z'));
    expect(out.get('org1')).toEqual([{ currencyCode: 'USD', amount: '50.00' }]);
  });

  it('amortises a 12-month contract of 1200.00 to 100.00 monthly', async () => {
    queueResult([contract({ intervalMonths: 12 })]);
    queueResult([line({ unitPrice: '1200.00' })]);
    const out = await svc.summarizeActiveContractMrrByOrg(['org1']);
    expect(out.get('org1')).toEqual([{ currencyCode: 'USD', amount: '100.00' }]);
  });

  it('amortises a 3-month contract of 300.00 to 100.00 monthly', async () => {
    queueResult([contract({ intervalMonths: 3 })]);
    queueResult([line({ unitPrice: '300.00' })]);
    const out = await svc.summarizeActiveContractMrrByOrg(['org1']);
    expect(out.get('org1')).toEqual([{ currencyCode: 'USD', amount: '100.00' }]);
  });

  it('keeps two currencies under ONE org as two entries, never a sum', async () => {
    queueResult([
      contract({ id: 'c1', currencyCode: 'USD' }),
      contract({ id: 'c2', currencyCode: 'EUR' }),
    ]);
    queueResult([
      line({ id: 'l1', contractId: 'c1', unitPrice: '1230.00' }),
      line({ id: 'l2', contractId: 'c2', unitPrice: '410.00' }),
    ]);
    const out = await svc.summarizeActiveContractMrrByOrg(['org1']);
    expect(out.get('org1')).toEqual([
      { currencyCode: 'EUR', amount: '410.00' },
      { currencyCode: 'USD', amount: '1230.00' },
    ]);
  });

  it('rounds each contract in its OWN currency — a JPY contract never yields a fractional yen', async () => {
    queueResult([contract({ currencyCode: 'JPY', intervalMonths: 2 })]);
    queueResult([line({ unitPrice: '201' })]);
    const out = await svc.summarizeActiveContractMrrByOrg(['org1']);
    // roundToCurrency returns the fixed-2 string the numeric(_,2) columns
    // store; for a zero-decimal currency that is a WHOLE major unit — 101.00,
    // never the 100.50 a naive 201/2 would emit.
    expect(out.get('org1')).toEqual([{ currencyCode: 'JPY', amount: '101.00' }]);
  });

  it('omits an org with no active contracts from the map entirely', async () => {
    queueResult([contract({ orgId: 'org1' })]);
    queueResult([line({ unitPrice: '50.00' })]);
    const out = await svc.summarizeActiveContractMrrByOrg(['org1', 'org2']);
    expect(out.has('org2')).toBe(false);
    expect(out.get('org1')).toEqual([{ currencyCode: 'USD', amount: '50.00' }]);
  });

  it('batches device counts: one snapshot per org across all orgs', async () => {
    vi.mocked(snapshotContractDevices).mockResolvedValue([{ role: 'workstation', siteId: null, n: 2 }]);
    queueResult(['org1', 'org2', 'org3'].map((orgId, i) => contract({ id: `c${i}`, orgId })));
    queueResult(['c0', 'c1', 'c2'].flatMap((contractId) => [
      line({ id: `${contractId}-a`, contractId, lineType: 'per_device', unitPrice: '10.00' }),
      line({ id: `${contractId}-b`, contractId, lineType: 'per_device', unitPrice: '5.00' }),
    ]));
    const out = await svc.summarizeActiveContractMrrByOrg(['org1', 'org2', 'org3']);
    expect(vi.mocked(snapshotContractDevices).mock.calls.length).toBe(3); // one snapshot per org
    expect(out.get('org2')).toEqual([{ currencyCode: 'USD', amount: '30.00' }]);
  });

  it('does not inherit the listContracts page cap — 120 orgs all report', async () => {
    const orgIds = Array.from({ length: 120 }, (_, i) => `org${i}`);
    queueResult(orgIds.map((orgId, i) => contract({ id: `c${i}`, orgId })));
    queueResult(orgIds.map((_, i) => line({ id: `l${i}`, contractId: `c${i}`, unitPrice: '7.00' })));
    const out = await svc.summarizeActiveContractMrrByOrg(orgIds);
    expect(out.size).toBe(120);
    expect((db as unknown as { limit: { mock: { calls: unknown[][] } } }).limit.mock.calls.length).toBe(0);
  });

  it('prices a catalog line through the price book, not the line snapshot', async () => {
    queueResult([contract({ currencyCode: 'USD' })]);
    queueResult([line({ catalogItemId: 'item-1', unitPrice: '10.00' })]);
    queueResult([]);                                   // no org overrides
    queueResult([{ itemId: 'item-1', currencyCode: 'USD', unitPrice: '42.00' }]);
    const out = await svc.summarizeActiveContractMrrByOrg(['org1']);
    expect(vi.mocked(resolvePriceFrom)).toHaveBeenCalled();
    expect(out.get('org1')).toEqual([{ currencyCode: 'USD', amount: '42.00' }]);
  });

  it('prefers an org override stamped in the contract currency over the price book', async () => {
    queueResult([contract({ currencyCode: 'USD' })]);
    queueResult([line({ catalogItemId: 'item-1', unitPrice: '10.00' })]);
    queueResult([{ itemId: 'item-1', orgId: 'org1', currencyCode: 'USD', unitPrice: '33.00' }]);
    queueResult([{ itemId: 'item-1', currencyCode: 'USD', unitPrice: '42.00' }]);
    const out = await svc.summarizeActiveContractMrrByOrg(['org1']);
    expect(out.get('org1')).toEqual([{ currencyCode: 'USD', amount: '33.00' }]);
  });

  it('falls back to the stamped unitPrice on a price-book gap — never another currency price, never converted', async () => {
    queueResult([contract({ currencyCode: 'USD' })]);
    queueResult([line({ catalogItemId: 'item-1', unitPrice: '10.00' })]);
    queueResult([{ itemId: 'item-1', orgId: 'org1', currencyCode: 'EUR', unitPrice: '999.00' }]); // wrong-currency override
    queueResult([]);                                    // no USD book row (the gap)
    const out = await svc.summarizeActiveContractMrrByOrg(['org1']);
    expect(out.get('org1')).toEqual([{ currencyCode: 'USD', amount: '10.00' }]);
  });

  it('never consults the resolver for a non-catalog line', async () => {
    queueResult([contract()]);
    queueResult([line({ catalogItemId: null, unitPrice: '10.00' })]);
    const out = await svc.summarizeActiveContractMrrByOrg(['org1']);
    expect(vi.mocked(resolvePriceFrom)).not.toHaveBeenCalled();
    expect(out.get('org1')).toEqual([{ currencyCode: 'USD', amount: '10.00' }]);
  });
});

// #3205: device-counted lines resolve from ONE org snapshot; per_device_role
// with no roles is an invariant violation, never an unfiltered count.
describe('computeContractEstimate — per_device_role + uncoveredDevices (#3205)', () => {
  beforeEach(() => { results.length = 0; vi.clearAllMocks(); });

  const contract = { id: 'c1', orgId: 'org1', partnerId: 'p1', status: 'draft', currencyCode: 'USD' };
  const lineRow = (p: Record<string, unknown>) => ({
    id: 'l1', contractId: 'c1', orgId: 'org1', description: 'x', unitPrice: '10.00', taxable: false,
    catalogItemId: null, manualQuantity: null, siteId: null, deviceRoles: null, sortOrder: 0, ...p,
  });
  const snapshot = [
    { role: 'workstation', siteId: null, n: 3 },
    { role: 'server', siteId: null, n: 2 },
    { role: 'unknown', siteId: null, n: 1 },
  ];

  it('bills the role set from the snapshot and reports uncovered devices by role', async () => {
    vi.mocked(snapshotContractDevices).mockResolvedValue(snapshot);
    queueResult([contract]); // getOwnedContractOr404
    queueResult([lineRow({ lineType: 'per_device_role', deviceRoles: ['server'], unitPrice: '50.00' })]);
    const out = await svc.computeContractEstimate('c1', actor);
    expect(out.lines).toEqual([{ lineId: 'l1', lineType: 'per_device_role', quantity: 2, value: '100.00', live: true }]);
    expect(out.uncoveredDevices).toEqual({ total: 4, byRole: { workstation: 3, unknown: 1 } });
    expect(vi.mocked(snapshotContractDevices)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(countContractDevices)).not.toHaveBeenCalled();
  });

  it('uncoveredDevices is null when the contract has no device-counted line', async () => {
    queueResult([contract]);
    queueResult([lineRow({ lineType: 'flat' })]);
    const out = await svc.computeContractEstimate('c1', actor);
    expect(out.uncoveredDevices).toBeNull();
    expect(vi.mocked(snapshotContractDevices)).not.toHaveBeenCalled();
  });

  it('throws INVALID_STATE for a per_device_role row with no roles instead of counting every device', async () => {
    vi.mocked(snapshotContractDevices).mockResolvedValue(snapshot);
    queueResult([contract]);
    queueResult([lineRow({ lineType: 'per_device_role', deviceRoles: null })]);
    await expect(svc.computeContractEstimate('c1', actor)).rejects.toMatchObject({ code: 'INVALID_STATE', status: 500 });
  });
});
