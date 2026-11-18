/**
 * BRZ-8807 acceptance (Q8): with a partner's billing switched off, the renewal
 * sweep keeps renewing terms (end date, event, internal notice) but moves no
 * money: it never reaches invoice creation, issuing, sending or Stripe.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

const { results, moneyMocks } = vi.hoisted(() => ({
  results: [] as unknown[][],
  moneyMocks: {
    createManualInvoice: vi.fn(), issueInvoice: vi.fn(), sendInvoiceEmail: vi.fn(),
    generateDueInvoice: vi.fn(), stripeCharge: vi.fn(),
  },
}));
vi.mock('../db', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where', 'limit', 'innerJoin', 'insert', 'values', 'onConflictDoNothing', 'returning', 'update', 'set']) {
    chain[m] = vi.fn(() => chain);
  }
  (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(results.shift() ?? []).then(resolve);
  return { db: chain };
});

vi.mock('./contractEvents', () => ({ emitContractEvent: vi.fn() }));
vi.mock('./notificationSenders/inAppSender', () => ({ sendInAppNotification: vi.fn() }));
vi.mock('./email', () => ({ getEmailService: () => null }));
vi.mock('./sentry', () => ({ captureException: vi.fn() }));
vi.mock('./invoiceService', () => ({
  createManualInvoice: moneyMocks.createManualInvoice, issueInvoice: moneyMocks.issueInvoice,
}));
vi.mock('./invoicePdf', () => ({ sendInvoiceEmail: moneyMocks.sendInvoiceEmail }));
vi.mock('./contractService', () => ({ generateDueInvoice: moneyMocks.generateDueInvoice }));
vi.mock('stripe', () => ({ default: class { charges = { create: moneyMocks.stripeCharge }; } }));

import { db } from '../db';
import { emitContractEvent } from './contractEvents';
import { runContractRenewalSweep } from './contractRenewal';

const candidate = {
  id: 'c1', orgId: 'o1', partnerId: 'p-off', name: 'Renew', billingTiming: 'advance', intervalMonths: 1,
  endDate: '2027-01-01', nextBillingAt: '2027-01-01', autoRenew: true, renewalTermMonths: 12, renewalNoticeDays: 30,
};

describe('renewal sweep with partner billing off (Q8)', () => {
  beforeEach(() => { vi.clearAllMocks(); results.length = 0; });

  it('extends the term and notes the renewal without touching any money path', async () => {
    // candidates, update…returning, claimNotice(advance), claimNotice(renewed)
    results.push([candidate], [{ id: 'c1' }], [{ id: 'n1' }], [{ id: 'n2' }]);
    const out = await runContractRenewalSweep(new Date('2027-01-01T05:00:00Z'));

    expect(out.renewed).toBe(1);
    expect((db as unknown as { set: Mock }).set).toHaveBeenCalledWith(expect.objectContaining({ endDate: '2028-01-01' }));
    expect(emitContractEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'contract.auto_renewed', contractId: 'c1' }));
    expect((db as unknown as { insert: Mock }).insert).toHaveBeenCalled(); // internal renewal notice
    for (const m of Object.values(moneyMocks)) expect(m).not.toHaveBeenCalled();
  });
});
