import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { createBreezeBillingClient } from './breezeBillingClient';

describe('breezeBillingClient', () => {
  it('creates a Stripe SetupIntent for a partner and returns the hosted URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ setup_url: 'https://stripe.example/setup/abc', customer_id: 'cus_123' }),
    });
    const client = createBreezeBillingClient({ baseUrl: 'http://billing.local', fetch: fetchMock as any });
    const r = await client.createSetupIntent({
      partnerId: 'p1',
      returnUrl: 'https://us.2breeze.app/activate/complete?partner=p1',
    });
    expect(r.setupUrl).toBe('https://stripe.example/setup/abc');
    expect(r.customerId).toBe('cus_123');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://billing.local/setup-intents',
      expect.objectContaining({ method: 'POST' }),
    );
    const call = fetchMock.mock.calls[0];
    if (!call) throw new Error('fetch was not called');
    const init = call[1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({
      partner_id: 'p1',
      return_url: 'https://us.2breeze.app/activate/complete?partner=p1',
    });
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
  });

  it('surfaces billing-service failures clearly', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => 'svc down',
    });
    const client = createBreezeBillingClient({ baseUrl: 'http://billing.local', fetch: fetchMock as any });
    await expect(
      client.createSetupIntent({ partnerId: 'p1', returnUrl: 'x' }),
    ).rejects.toMatchObject({ code: 'BILLING_UNAVAILABLE', message: expect.stringContaining('svc down') });
  });

  describe('breeze-billing S2S auth header (F4)', () => {
    const originalKey = process.env.BREEZE_BILLING_API_KEY;

    beforeEach(() => {
      delete process.env.BREEZE_BILLING_API_KEY;
    });

    afterEach(() => {
      if (originalKey === undefined) {
        delete process.env.BREEZE_BILLING_API_KEY;
      } else {
        process.env.BREEZE_BILLING_API_KEY = originalKey;
      }
    });

    it('attaches Authorization: Bearer <BREEZE_BILLING_API_KEY> on /setup-intents', async () => {
      process.env.BREEZE_BILLING_API_KEY = 's2s-secret-token';
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ setup_url: 'https://stripe.example/setup/abc', customer_id: 'cus_123' }),
      });
      const client = createBreezeBillingClient({ baseUrl: 'http://billing.local', fetch: fetchMock as any });
      await client.createSetupIntent({ partnerId: 'p1', returnUrl: 'https://app.example.com/back' });
      const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
      if (!init) throw new Error('fetch was not called');
      expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer s2s-secret-token');
    });

    it('does NOT attach an Authorization header when BREEZE_BILLING_API_KEY is unset', async () => {
      delete process.env.BREEZE_BILLING_API_KEY;
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ setup_url: 'https://stripe.example/setup/abc', customer_id: 'cus_123' }),
      });
      const client = createBreezeBillingClient({ baseUrl: 'http://billing.local', fetch: fetchMock as any });
      await client.createSetupIntent({ partnerId: 'p1', returnUrl: 'https://app.example.com/back' });
      const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
      if (!init) throw new Error('fetch was not called');
      const headers = init.headers as Record<string, string>;
      expect(headers['Authorization']).toBeUndefined();
      // Guard against the `Bearer undefined` footgun.
      expect(JSON.stringify(headers)).not.toContain('Bearer undefined');
    });
  });

  describe('cancelSubscription', () => {
    const originalKey = process.env.BREEZE_BILLING_API_KEY;
    afterEach(() => {
      if (originalKey === undefined) delete process.env.BREEZE_BILLING_API_KEY;
      else process.env.BREEZE_BILLING_API_KEY = originalKey;
    });

    it('POSTs to the internal cancel endpoint with immediate=true by default and returns the result', async () => {
      process.env.BREEZE_BILLING_API_KEY = 's2s-secret-token';
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, canceled: true, stripeSubscriptionId: 'sub_9', immediate: true }),
      });
      const client = createBreezeBillingClient({ baseUrl: 'http://billing.local', fetch: fetchMock as any });

      const r = await client.cancelSubscription({ partnerId: 'p1' });

      expect(r).toEqual({ canceled: true, stripeSubscriptionId: 'sub_9', immediate: true });
      expect(fetchMock).toHaveBeenCalledWith(
        'http://billing.local/billing/api/internal/partners/p1/cancel-subscription',
        expect.objectContaining({ method: 'POST' }),
      );
      const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
      expect(JSON.parse(init.body as string)).toEqual({ immediate: true });
      expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer s2s-secret-token');
    });

    it('passes immediate=false through when explicitly requested', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, canceled: true, stripeSubscriptionId: 'sub_9', immediate: false }),
      });
      const client = createBreezeBillingClient({ baseUrl: 'http://billing.local', fetch: fetchMock as any });

      await client.cancelSubscription({ partnerId: 'p1', immediate: false });

      const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
      expect(JSON.parse(init.body as string)).toEqual({ immediate: false });
    });

    it('url-encodes the partner id', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, canceled: false, immediate: true }),
      });
      const client = createBreezeBillingClient({ baseUrl: 'http://billing.local', fetch: fetchMock as any });

      await client.cancelSubscription({ partnerId: 'p/1?x' });

      expect(fetchMock.mock.calls[0]?.[0]).toBe(
        'http://billing.local/billing/api/internal/partners/p%2F1%3Fx/cancel-subscription',
      );
    });

    it('throws BILLING_UNAVAILABLE on a non-2xx response', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 502, text: async () => 'bad gateway' });
      const client = createBreezeBillingClient({ baseUrl: 'http://billing.local', fetch: fetchMock as any });

      await expect(client.cancelSubscription({ partnerId: 'p1' })).rejects.toMatchObject({
        code: 'BILLING_UNAVAILABLE',
        message: expect.stringContaining('bad gateway'),
      });
    });
  });
});
