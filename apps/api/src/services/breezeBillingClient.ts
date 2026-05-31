export interface BreezeBillingClient {
  createSetupIntent(input: {
    partnerId: string;
    returnUrl: string;
  }): Promise<{ setupUrl: string; customerId: string }>;
}

export class BillingError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export function createBreezeBillingClient(opts: {
  baseUrl: string;
  fetch?: typeof fetch;
}): BreezeBillingClient {
  const doFetch = opts.fetch ?? fetch;
  return {
    async createSetupIntent({ partnerId, returnUrl }) {
      // Service-to-service auth to breeze-billing. The boot validator
      // (config/validate.ts) requires BREEZE_BILLING_API_KEY whenever
      // BREEZE_BILLING_URL is set, so in production the key is guaranteed
      // present. Only attach the header when the key exists to avoid sending
      // `Bearer undefined` from dev/test without billing configured.
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      const billingKey = process.env.BREEZE_BILLING_API_KEY;
      if (billingKey) headers['Authorization'] = `Bearer ${billingKey}`;
      const res = await doFetch(`${opts.baseUrl}/setup-intents`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ partner_id: partnerId, return_url: returnUrl }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new BillingError(
          'BILLING_UNAVAILABLE',
          `Billing service returned ${res.status}: ${body.slice(0, 200)}`,
        );
      }
      const json = (await res.json()) as { setup_url: string; customer_id: string };
      return { setupUrl: json.setup_url, customerId: json.customer_id };
    },
  };
}

export function getBreezeBillingClient(): BreezeBillingClient {
  const baseUrl = process.env.BREEZE_BILLING_URL;
  if (!baseUrl) throw new Error('BREEZE_BILLING_URL not configured.');
  return createBreezeBillingClient({ baseUrl });
}
