import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { Tx } from './types';
import { assertNoActiveCollection, lockInvoiceForCollection, assertCollectionAmountAvailable } from './reservation';

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
    expect(q.params).not.toContain('requires_action');
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
});
