import { describe, it, expect, vi, beforeEach } from 'vitest';

const rows = vi.hoisted(() => ({ value: [] as unknown[] }));
vi.mock('../db', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where', 'leftJoin']) chain[m] = vi.fn(() => chain);
  chain.limit = vi.fn(async () => rows.value);
  return { db: chain };
});

import { assertInvoiceBillingEnabled, assertInvoiceBillingEnabledById } from './invoiceBillingGate';
import { InvoiceServiceError } from './invoiceTypes';

describe('invoiceBillingGate', () => {
  beforeEach(() => { rows.value = []; });

  it('billing off -> InvoiceServiceError 404 BILLING_DISABLED', async () => {
    rows.value = [{ billingEnabled: false }];
    const err = await assertInvoiceBillingEnabled('org1').catch((e) => e);
    expect(err).toBeInstanceOf(InvoiceServiceError);
    expect(err).toMatchObject({ status: 404, code: 'BILLING_DISABLED', message: 'Not found' });
  });

  it('billing on -> passes', async () => {
    rows.value = [{ billingEnabled: true }];
    await expect(assertInvoiceBillingEnabled('org1')).resolves.toBeUndefined();
  });

  it('by id: unknown invoice passes through; known invoice with billing off throws', async () => {
    rows.value = [];
    await expect(assertInvoiceBillingEnabledById('i1')).resolves.toBeUndefined();
    // first read (invoice org) returns the org, second (partner flag) returns off
    const limit = ((await import('../db')).db as unknown as { limit: ReturnType<typeof vi.fn> }).limit;
    limit.mockResolvedValueOnce([{ orgId: 'org1' }]).mockResolvedValueOnce([{ billingEnabled: false }]);
    await expect(assertInvoiceBillingEnabledById('i1')).rejects.toMatchObject({ code: 'BILLING_DISABLED', status: 404 });
  });
});
