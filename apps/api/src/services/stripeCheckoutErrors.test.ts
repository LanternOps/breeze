import { describe, expect, it } from 'vitest';
import { mapStripeCheckoutError } from './stripeCheckoutErrors';

describe('mapStripeCheckoutError', () => {
  it('maps Stripe currency_not_supported errors to a partner-facing 409', () => {
    const result = mapStripeCheckoutError(
      { type: 'StripeInvalidRequestError', code: 'currency_not_supported' },
      'chf',
    );

    expect(result).toMatchObject({ status: 409, code: 'STRIPE_CURRENCY_UNSUPPORTED' });
    expect(result?.message).toContain('CHF');
  });

  it('maps invalid-request errors whose parameter identifies currency', () => {
    const result = mapStripeCheckoutError(
      { type: 'StripeInvalidRequestError', param: 'line_items[0][price_data][currency]' },
      'usd',
    );

    expect(result).toMatchObject({ status: 409, code: 'STRIPE_CURRENCY_UNSUPPORTED' });
  });

  it('maps invalid-request errors whose message identifies currency', () => {
    const result = mapStripeCheckoutError(
      { type: 'StripeInvalidRequestError', message: 'Invalid currency: xyz' },
      'usd',
    );

    expect(result).toMatchObject({ status: 409, code: 'STRIPE_CURRENCY_UNSUPPORTED' });
  });

  it('leaves Stripe card errors untouched', () => {
    expect(mapStripeCheckoutError({ type: 'StripeCardError' }, 'usd')).toBeNull();
  });

  it('leaves ordinary errors untouched', () => {
    expect(mapStripeCheckoutError(new Error('boom'), 'usd')).toBeNull();
  });
});
