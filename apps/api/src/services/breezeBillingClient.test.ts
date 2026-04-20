import { describe, it, expect, vi } from 'vitest';
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
});
