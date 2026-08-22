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
    const methods = ['select', 'from', 'where', 'limit', 'orderBy', 'insert', 'values', 'returning', 'update', 'set', 'delete', 'for', 'innerJoin', 'leftJoin', 'execute'];
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

import * as svc from './contractService';
import { db } from '../db';

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
