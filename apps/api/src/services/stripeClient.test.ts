import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('stripe SDK version pin (#3690)', () => {
  // Every `apiVersion` literal passed to `new Stripe(...)` is typed against the
  // SDK's own `LatestApiVersion`. A caret range lets any lockfile re-resolution
  // move the SDK, and the "fix" for the resulting type error is to edit the
  // literal, which changes the live Stripe API version inside a dependency diff.
  // With an exact pin, the SDK only moves when the manifest itself is edited.
  it('pins the stripe dependency to an exact version', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { dependencies: Record<string, string> };
    expect(manifest.dependencies.stripe).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

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
