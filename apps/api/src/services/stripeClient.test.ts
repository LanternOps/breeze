import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NOTE: the real implementation imports `getConfig` from '../config/validate'
// (the config dir has no index barrel), so the mock targets that exact path.

describe('stripeClient (configured)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock('../config/validate', () => ({ getConfig: () => ({ STRIPE_SECRET_KEY: 'sk_test_x' }) }));
  });
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('../config/validate');
  });

  it('returns a Stripe instance when configured', async () => {
    const { getStripe } = await import('./stripeClient');
    expect(getStripe()).toBeTruthy();
  });

  it('builds connected-account request options', async () => {
    const { getConnectedStripeOptions } = await import('./stripeClient');
    expect(getConnectedStripeOptions('acct_123')).toEqual({ stripeAccount: 'acct_123' });
  });

  it('reports configured', async () => {
    const { isStripeConfigured } = await import('./stripeClient');
    expect(isStripeConfigured()).toBe(true);
  });
});

describe('stripeClient (not configured)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock('../config/validate', () => ({ getConfig: () => ({}) }));
  });
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('../config/validate');
  });

  it('throws StripeNotConfiguredError when STRIPE_SECRET_KEY is absent', async () => {
    const { getStripe, StripeNotConfiguredError } = await import('./stripeClient');
    expect(() => getStripe()).toThrow(StripeNotConfiguredError);
  });

  it('reports not configured', async () => {
    const { isStripeConfigured } = await import('./stripeClient');
    expect(isStripeConfigured()).toBe(false);
  });
});
