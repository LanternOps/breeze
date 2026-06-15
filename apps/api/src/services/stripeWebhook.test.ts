// apps/api/src/services/stripeWebhook.test.ts
import { describe, expect, it, vi } from 'vitest';

const constructEvent = vi.fn();
vi.mock('./stripeClient', () => ({ getStripe: () => ({ webhooks: { constructEvent } }), isStripeConfigured: () => true }));
vi.mock('../config/validate', () => ({ getConfig: () => ({ STRIPE_WEBHOOK_SECRET: 'whsec_x' }) }));

import { verifyStripeEvent } from './stripeWebhook';

describe('verifyStripeEvent', () => {
  it('returns the event when the signature is valid', () => {
    constructEvent.mockReturnValue({ id: 'evt_1', type: 'payment_intent.succeeded', account: 'acct_1' });
    const ev = verifyStripeEvent('raw-body', 'sig-header');
    expect(ev.id).toBe('evt_1');
  });
  it('throws on an invalid signature', () => {
    constructEvent.mockImplementation(() => { throw new Error('bad sig'); });
    expect(() => verifyStripeEvent('raw-body', 'bad')).toThrow();
  });
});
