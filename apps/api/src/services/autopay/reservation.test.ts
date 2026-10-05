import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { Tx } from './types';
import { assertNoActiveCollection, lockInvoiceForCollection, assertCollectionAmountAvailable, readInFlightCollection } from './reservation';

function executor(rows: unknown[][]) {
  const calls: Array<{ op: string; value?: unknown }> = [];
  const chain: Record<string, unknown> = {};
  for (const op of ['select', 'from', 'where', 'limit', 'for']) {
    chain[op] = vi.fn((value?: unknown) => { calls.push({ op, value }); return chain; });
  }
  chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve(rows.shift() ?? []).then(resolve);
  return { tx: chain as unknown as Tx, calls };
}
const invoice = { id: '11111111-1111-4111-8111-111111111111', currencyCode: 'USD', total: '100.00' };

describe('invoice collection reservation', () => {
  it('locks the invoice before summing only active attempts and returns exact decimals', async () => {
    const { tx, calls } = executor([[invoice], [{ reservedAmount: '60.00', balance: '90.00', unreservedBalance: '30.00' }]]);
    await expect(lockInvoiceForCollection(tx, invoice.id)).resolves.toMatchObject({
      invoice: { balance: '90.00' }, reservedAmount: '60.00', unreservedBalance: '30.00',
    });
    expect(calls.findIndex(c => c.op === 'for')).toBeLessThan(calls.map(c => c.op).lastIndexOf('select'));
    expect(calls.find(c => c.op === 'for')?.value).toBe('update');
    const projection = calls.filter(c => c.op === 'select')[1]!.value as Record<string, SQL>;
    const q = new PgDialect().sqlToQuery(projection.reservedAmount!);
    expect(q.params).toEqual(expect.arrayContaining(['reserved', 'created', 'confirming', 'processing']));
    expect(q.params).toContain('requires_action');
  });
  it('returns a typed 404 for an invisible invoice', async () => {
    const { tx } = executor([[]]);
    await expect(lockInvoiceForCollection(tx, invoice.id)).rejects.toMatchObject({ status: 404, code: 'INVOICE_NOT_FOUND' });
  });
  it('refuses a pay link whenever principal is reserved', async () => {
    const { tx } = executor([[invoice], [{ reservedAmount: '0.01', balance: '100.00', unreservedBalance: '99.99' }]]);
    await expect(assertNoActiveCollection(tx, invoice.id)).rejects.toMatchObject({ status: 409, code: 'COLLECTION_IN_PROGRESS' });
  });
  it.each([
    ['40.00', '60.00', '40.00', null],
    ['40.01', '60.00', '40.00', 'COLLECTION_IN_PROGRESS'],
    ['100.01', '0.00', '100.00', 'OVERPAYMENT'],
  ])('limits amount %s with reserved %s to %s', async (amount, reservedAmount, unreservedBalance, code) => {
    const { tx } = executor([[invoice], [{ reservedAmount, balance: '100.00', unreservedBalance }]]);
    const pending = assertCollectionAmountAvailable(tx, invoice.id, amount);
    if (code) await expect(pending).rejects.toMatchObject({ code });
    else await expect(pending).resolves.toBeUndefined();
  });
  it('allows decreasing an existing import even if the invoice is fully reserved', async () => {
    const { tx } = executor([[invoice], [{ reservedAmount: '50.00', balance: '50.00', unreservedBalance: '0.00' }], [{ amount: '50.00' }]]);
    await expect(assertCollectionAmountAvailable(tx, invoice.id, '40.00', '22222222-2222-4222-8222-222222222222')).resolves.toBeUndefined();
  });
  describe('readInFlightCollection (lock-free read for customer views, #7824)', () => {
    it('reports in-flight with the reserved principal, counting only reserving states', async () => {
      const { tx, calls } = executor([[{ reservedAmount: '50.00', reservedFee: '1.50', paymentMethodId: 'pm' }]]);
      await expect(readInFlightCollection(tx, invoice.id)).resolves.toEqual({ inProgress: true, amount: '50.00', fee: '1.50', paymentMethodId: 'pm', actionRequired: false });
      // V-5: the page names the newest attempt's method.
      const projection = calls.find(c => c.op === 'select')!.value as Record<string, SQL>;
      expect(new PgDialect().sqlToQuery(projection.paymentMethodId!).sql).toContain('order by "invoice_collection_attempts"."created_at" desc))[1]');
      expect(calls.some(c => c.op === 'for')).toBe(false); // never locks
      const q = new PgDialect().sqlToQuery(calls.find(c => c.op === 'where')!.value as SQL);
      expect(q.params).toEqual(expect.arrayContaining([invoice.id, 'reserved', 'created', 'confirming', 'processing', 'requires_action']));
    });
    it.each([[[{ reservedAmount: '0.00' }]], [[]]])('reports not in-flight for %j', async (rows) => {
      const { tx } = executor([rows as unknown[]]);
      await expect(readInFlightCollection(tx, invoice.id)).resolves.toEqual({ inProgress: false, amount: '0.00', fee: '0.00', paymentMethodId: null, actionRequired: false });
    });
    it('flags a reservation that only waits on the customer\'s bank (off-session 3DS)', async () => {
      const { tx, calls } = executor([[{ reservedAmount: '50.00', actionRequired: true }]]);
      await expect(readInFlightCollection(tx, invoice.id)).resolves.toEqual({ inProgress: true, amount: '50.00', fee: '0.00', paymentMethodId: null, actionRequired: true });
      const projection = calls.find(c => c.op === 'select')!.value as Record<string, SQL>;
      const q = new PgDialect().sqlToQuery(projection.actionRequired!);
      expect(q.sql).toContain(`bool_and("invoice_collection_attempts"."state" = 'requires_action')`);
    });
  });
});
