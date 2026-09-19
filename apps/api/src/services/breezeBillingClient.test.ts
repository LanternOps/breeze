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

  describe('promotion facts', () => {
    it('GETs and maps a settled card charge', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          chargeId: 'ch_1',
          settledAt: '2026-09-01T00:00:00.000Z',
          paymentMethodType: 'card',
          threeDsAuthenticated: true,
          cardholderName: 'Ada Lovelace',
          disputed: false,
          refunded: false,
        }),
      });
      const client = createBreezeBillingClient({ baseUrl: 'http://billing.local', fetch: fetchMock as any });

      await expect(client.getSettledCardCharge('p/1')).resolves.toMatchObject({
        chargeId: 'ch_1', settledAt: new Date('2026-09-01T00:00:00.000Z'),
      });
      expect(fetchMock).toHaveBeenCalledWith(
        'http://billing.local/internal/partners/p%2F1/settled-card-charge',
        expect.objectContaining({ method: 'GET' }),
      );
    });

    it('returns null and warns once on a 404', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404 });
      const client = createBreezeBillingClient({ baseUrl: 'http://billing.local', fetch: fetchMock as any });

      await expect(client.getSettledCardCharge('p1')).resolves.toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      warn.mockRestore();
    });

    it('returns null and warns once on a network error', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
      const client = createBreezeBillingClient({ baseUrl: 'http://billing.local', fetch: fetchMock as any });

      await expect(client.getSettledCardCharge('p1')).resolves.toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      warn.mockRestore();
    });

    it('returns true for a fraudulent-refund customer match', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ match: true }),
      });
      const client = createBreezeBillingClient({ baseUrl: 'http://billing.local', fetch: fetchMock as any });

      await expect(client.hasFraudulentRefundMatch('p/1')).resolves.toBe(true);
      expect(fetchMock).toHaveBeenCalledWith(
        'http://billing.local/internal/partners/p%2F1/fraudulent-refund-match',
        expect.objectContaining({ method: 'GET' }),
      );
    });

    it('returns false and warns once when fraudulent-refund-match is missing', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404 });
      const client = createBreezeBillingClient({ baseUrl: 'http://billing.local', fetch: fetchMock as any });

      await expect(client.hasFraudulentRefundMatch('p1')).resolves.toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
      warn.mockRestore();
    });

    it('returns false and warns once when fraudulent-refund-match has a network failure', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
      const client = createBreezeBillingClient({ baseUrl: 'http://billing.local', fetch: fetchMock as any });

      await expect(client.hasFraudulentRefundMatch('p1')).resolves.toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
      warn.mockRestore();
    });
  });

  describe('getSignupRiskHold', () => {
    let warn: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined) as never;
    });

    afterEach(() => {
      warn.mockRestore();
    });

    const okResponse = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

    const clientWith = (response: unknown) => {
      const fetchMock = vi.fn().mockResolvedValue(response);
      return {
        fetchMock,
        client: createBreezeBillingClient({ baseUrl: 'http://billing.local', fetch: fetchMock as any }),
      };
    };

    it('GETs the breeze-billing signup-risk holds route with the partner id encoded', async () => {
      const { client, fetchMock } = clientWith(okResponse({ partnerId: 'p/1', holds: [], assessments: [] }));

      await client.getSignupRiskHold('p/1');

      expect(fetchMock).toHaveBeenCalledWith(
        'http://billing.local/internal/signup-risk/holds/p%2F1',
        expect.objectContaining({ method: 'GET' }),
      );
    });

    it('reports none when the partner has no hold rows', async () => {
      const { client } = clientWith(okResponse({ partnerId: 'p1', holds: [], assessments: [] }));
      await expect(client.getSignupRiskHold('p1')).resolves.toEqual({ status: 'none' });
    });

    it('reports hold for an unreleased hold row', async () => {
      const { client } = clientWith(okResponse({
        partnerId: 'p1',
        holds: [{ state: 'hold', releasedAt: null }],
      }));
      await expect(client.getSignupRiskHold('p1')).resolves.toEqual({ status: 'hold' });
    });

    it('reports review_pending for an unreleased review_pending row', async () => {
      const { client } = clientWith(okResponse({
        partnerId: 'p1',
        holds: [{ state: 'review_pending', releasedAt: null }],
      }));
      await expect(client.getSignupRiskHold('p1')).resolves.toEqual({ status: 'review_pending' });
    });

    it('lets an unreleased hold win over an unreleased review_pending regardless of row order', async () => {
      const { client } = clientWith(okResponse({
        partnerId: 'p1',
        holds: [
          { state: 'review_pending', releasedAt: null },
          { state: 'hold', releasedAt: null },
        ],
      }));
      await expect(client.getSignupRiskHold('p1')).resolves.toEqual({ status: 'hold' });
    });

    it('ignores released rows', async () => {
      const { client } = clientWith(okResponse({
        partnerId: 'p1',
        holds: [
          { state: 'hold', releasedAt: '2026-09-01T00:00:00.000Z' },
          { state: 'released', releasedAt: '2026-09-01T00:00:00.000Z' },
        ],
      }));
      await expect(client.getSignupRiskHold('p1')).resolves.toEqual({ status: 'none' });
    });

    it.each([
      ['empty string', ''],
      ['whitespace', '   '],
      ['zero', 0],
      ['false', false],
      ['an object', {}],
    ])('treats a hold row whose releasedAt is %s as still open (fail closed)', async (_name, releasedAt) => {
      const { client } = clientWith(okResponse({
        partnerId: 'p1',
        holds: [{ state: 'hold', releasedAt }],
      }));
      await expect(client.getSignupRiskHold('p1')).resolves.toEqual({ status: 'hold' });
    });

    it('treats an absent releasedAt field as still open', async () => {
      const { client } = clientWith(okResponse({ partnerId: 'p1', holds: [{ state: 'hold' }] }));
      await expect(client.getSignupRiskHold('p1')).resolves.toEqual({ status: 'hold' });
    });

    it('reports pass when the only unreleased row is a pass', async () => {
      const { client } = clientWith(okResponse({
        partnerId: 'p1',
        holds: [{ state: 'pass', releasedAt: null }],
      }));
      await expect(client.getSignupRiskHold('p1')).resolves.toEqual({ status: 'pass' });
    });

    it('treats an unknown unreleased state as a hold (fail closed)', async () => {
      const { client } = clientWith(okResponse({
        partnerId: 'p1',
        holds: [{ state: 'quarantined_pending_manual_thing', releasedAt: null }],
      }));
      await expect(client.getSignupRiskHold('p1')).resolves.toEqual({ status: 'hold' });
    });

    it('maps the exact domain 404 body to status none', async () => {
      const { client } = clientWith({
        ok: false,
        status: 404,
        json: async () => ({ error: 'no signup-risk records for partner' }),
        text: async () => JSON.stringify({ error: 'no signup-risk records for partner' }),
      });
      await expect(client.getSignupRiskHold('p1')).resolves.toEqual({ status: 'none' });
    });

    it('returns null for a generic HTML 404 (route missing, not "no records")', async () => {
      const { client } = clientWith({
        ok: false,
        status: 404,
        json: async () => { throw new SyntaxError('Unexpected token <'); },
        text: async () => '<!DOCTYPE html><title>Cannot GET</title>',
      });
      await expect(client.getSignupRiskHold('p1')).resolves.toBeNull();
    });

    it('returns null for a JSON 404 whose error text is not the domain message', async () => {
      const { client } = clientWith({
        ok: false,
        status: 404,
        json: async () => ({ error: 'Not Found' }),
        text: async () => '{"error":"Not Found"}',
      });
      await expect(client.getSignupRiskHold('p1')).resolves.toBeNull();
    });

    it.each([401, 403, 500, 502])('returns null on %i without throwing', async (status) => {
      const { client } = clientWith({ ok: false, status, json: async () => ({}), text: async () => 'nope' });
      await expect(client.getSignupRiskHold('p1')).resolves.toBeNull();
    });

    it('returns null when the request itself fails', async () => {
      const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
      const client = createBreezeBillingClient({ baseUrl: 'http://billing.local', fetch: fetchMock as any });
      await expect(client.getSignupRiskHold('p1')).resolves.toBeNull();
    });

    it.each([
      ['holds missing', { partnerId: 'p1' }],
      ['holds not an array', { partnerId: 'p1', holds: { state: 'hold' } }],
      ['body not an object', 'ok'],
      ['body null', null],
    ])('returns null on a malformed success body (%s)', async (_name, body) => {
      const { client } = clientWith(okResponse(body));
      await expect(client.getSignupRiskHold('p1')).resolves.toBeNull();
    });

    it('returns null when the body is for a different partner', async () => {
      const { client } = clientWith(okResponse({ partnerId: 'other', holds: [] }));
      await expect(client.getSignupRiskHold('p1')).resolves.toBeNull();
    });
  });
});
