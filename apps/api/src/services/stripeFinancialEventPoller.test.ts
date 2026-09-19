import { describe, expect, it, vi } from 'vitest';
import { normalizeStripeFinancialEvent } from './stripeFinancialEventPoller';

const base = {
  partnerId: '11111111-1111-4111-8111-111111111111',
  stripeAccountId: 'acct_direct',
};

describe('normalizeStripeFinancialEvent', () => {
  it('normalizes cumulative refund state without trusting Event.account for direct-key identity', async () => {
    const stripe = { charges: { retrieve: vi.fn() } } as any;
    const result = await normalizeStripeFinancialEvent({ ...base, stripe, event: {
      id: 'evt_refund', type: 'charge.refunded', account: null, livemode: false, created: 100,
      data: { object: { id: 'ch_1', payment_intent: 'pi_1', amount: 10000, amount_refunded: 4000, currency: 'usd' } },
    } as any });
    expect(result).toMatchObject({
      stripeEventId: 'evt_refund', stripeAccountId: 'acct_direct', paymentIntentId: 'pi_1',
      chargeAmountMinor: 10000, refundedAmountMinor: 4000,
    });
  });

  it('resolves a dispute charge when the event snapshot has no PaymentIntent', async () => {
    const retrieve = vi.fn().mockResolvedValue({ id: 'ch_1', payment_intent: 'pi_1' });
    const result = await normalizeStripeFinancialEvent({ ...base, stripe: { charges: { retrieve } } as any, event: {
      id: 'evt_dispute', type: 'charge.dispute.funds_withdrawn', account: null, livemode: false, created: 101,
      data: { object: { id: 'dp_1', payment_intent: null, charge: 'ch_1', amount: 10000, currency: 'usd', status: 'needs_response' } },
    } as any });
    expect(retrieve).toHaveBeenCalledWith('ch_1');
    expect(result).toMatchObject({ paymentIntentId: 'pi_1', disputeAmountMinor: 10000, disputeFundsWithdrawn: true });
  });

  it('maps funds reinstatement to an explicit reversible state transition', async () => {
    const result = await normalizeStripeFinancialEvent({ ...base, stripe: {} as any, event: {
      id: 'evt_restore', type: 'charge.dispute.funds_reinstated', account: null, livemode: false, created: 102,
      data: { object: { id: 'dp_1', payment_intent: 'pi_1', charge: 'ch_1', amount: 10000, currency: 'usd', status: 'won' } },
    } as any });
    expect(result).toMatchObject({ disputeFundsWithdrawn: false, disputeId: 'dp_1' });
  });

  it('does not treat a dispute-created warning inquiry as withdrawn funds', async () => {
    const result = await normalizeStripeFinancialEvent({ ...base, stripe: {} as any, event: {
      id: 'evt_warning', type: 'charge.dispute.created', account: null, livemode: false, created: 102,
      data: { object: { id: 'dp_warning', payment_intent: 'pi_1', charge: 'ch_1', amount: 10000, currency: 'usd', status: 'warning_needs_response' } },
    } as any });
    expect(result).toMatchObject({ disputeFundsWithdrawn: null, disputeId: 'dp_warning' });
  });

  it('quarantines a refund on a legacy charge with no PaymentIntent instead of throwing', async () => {
    // A throw here happens inside the poller's page loop, before the cursor
    // advance: one such event would wedge the partner's channel forever.
    const result = await normalizeStripeFinancialEvent({ ...base, stripe: {} as any, event: {
      id: 'evt_legacy_refund', type: 'charge.refunded', account: null, livemode: false, created: 104,
      data: { object: { id: 'ch_legacy', payment_intent: null, amount: 10000, amount_refunded: 2500, currency: 'usd' } },
    } as any });
    expect(result).toMatchObject({
      stripeEventId: 'evt_legacy_refund', paymentIntentId: null,
      quarantineReason: expect.stringContaining('no PaymentIntent'),
    });
  });

  it('quarantines a dispute whose charge also has no PaymentIntent binding', async () => {
    const retrieve = vi.fn().mockResolvedValue({ id: 'ch_legacy', payment_intent: null });
    const result = await normalizeStripeFinancialEvent({ ...base, stripe: { charges: { retrieve } } as any, event: {
      id: 'evt_legacy_dispute', type: 'charge.dispute.funds_withdrawn', account: null, livemode: false, created: 105,
      data: { object: { id: 'dp_legacy', payment_intent: null, charge: 'ch_legacy', amount: 10000, currency: 'usd', status: 'lost' } },
    } as any });
    expect(retrieve).toHaveBeenCalledWith('ch_legacy');
    expect(result).toMatchObject({
      stripeEventId: 'evt_legacy_dispute', paymentIntentId: null,
      quarantineReason: expect.stringContaining('no PaymentIntent'),
    });
  });

  it('rejects an event attributed to a different account', async () => {
    await expect(normalizeStripeFinancialEvent({ ...base, stripe: {} as any, event: {
      id: 'evt_wrong', type: 'charge.refunded', account: 'acct_other', livemode: false, created: 103,
      data: { object: { id: 'ch_1', payment_intent: 'pi_1', amount: 10000, amount_refunded: 1000, currency: 'usd' } },
    } as any })).rejects.toThrow(/account/);
  });
});
