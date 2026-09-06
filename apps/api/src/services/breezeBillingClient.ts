export interface CancelSubscriptionResult {
  /** false when the partner had no subscription (idempotent no-op). */
  canceled: boolean;
  stripeSubscriptionId?: string;
  immediate: boolean;
}

export interface SettledCardCharge {
  chargeId: string;
  settledAt: Date;
  paymentMethodType: string;
  threeDsAuthenticated: boolean;
  cardholderName: string;
  disputed: boolean;
  refunded: boolean;
}

export interface SignupRiskHold {
  status: string;
}

export interface BreezeBillingClient {
  createSetupIntent(input: {
    partnerId: string;
    returnUrl: string;
  }): Promise<{ setupUrl: string; customerId: string }>;

  /**
   * Cancel a partner's subscription via breeze-billing's service-to-service
   * endpoint. Defaults to immediate cancellation (used on abuse suspension).
   * Never refunds. Idempotent — returns `canceled: false` when there was no
   * subscription. Throws BillingError on a non-2xx response.
   */
  cancelSubscription(input: {
    partnerId: string;
    immediate?: boolean;
  }): Promise<CancelSubscriptionResult>;

  getSettledCardCharge(partnerId: string): Promise<SettledCardCharge | null>;
  getSignupRiskHold(partnerId: string): Promise<SignupRiskHold | null>;
  hasFraudulentRefundMatch(partnerId: string): Promise<boolean>;
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
  const internalGet = async <T>(partnerId: string, resource: string): Promise<T | null> => {
    const headers: Record<string, string> = {};
    const billingKey = process.env.BREEZE_BILLING_API_KEY;
    if (billingKey) headers.Authorization = `Bearer ${billingKey}`;
    const url = `${opts.baseUrl}/internal/partners/${encodeURIComponent(partnerId)}/${resource}`;
    try {
      const res = await doFetch(url, { method: 'GET', headers });
      if (res.status === 404) {
        console.warn(`[breezeBillingClient] ${resource} unavailable for partner ${partnerId}: 404`);
        return null;
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new BillingError(
          'BILLING_UNAVAILABLE',
          `Billing service returned ${res.status}: ${body.slice(0, 200)}`,
        );
      }
      return (await res.json()) as T;
    } catch (error) {
      if (error instanceof BillingError) throw error;
      console.warn(`[breezeBillingClient] ${resource} request failed for partner ${partnerId}`, error);
      return null;
    }
  };
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

    async cancelSubscription({ partnerId, immediate = true }) {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      const billingKey = process.env.BREEZE_BILLING_API_KEY;
      if (billingKey) headers['Authorization'] = `Bearer ${billingKey}`;
      const res = await doFetch(
        `${opts.baseUrl}/billing/api/internal/partners/${encodeURIComponent(partnerId)}/cancel-subscription`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ immediate }),
        },
      );
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new BillingError(
          'BILLING_UNAVAILABLE',
          `Billing service returned ${res.status}: ${body.slice(0, 200)}`,
        );
      }
      const json = (await res.json()) as {
        canceled: boolean;
        stripeSubscriptionId?: string;
        immediate: boolean;
      };
      return {
        canceled: json.canceled,
        stripeSubscriptionId: json.stripeSubscriptionId,
        immediate: json.immediate,
      };
    },

    async getSettledCardCharge(partnerId) {
      const row = await internalGet<{
        chargeId: string;
        settledAt: string;
        paymentMethodType: string;
        threeDsAuthenticated: boolean;
        cardholderName: string;
        disputed: boolean;
        refunded: boolean;
      }>(partnerId, 'settled-card-charge');
      return row ? { ...row, settledAt: new Date(row.settledAt) } : null;
    },

    async getSignupRiskHold(partnerId) {
      return internalGet<SignupRiskHold>(partnerId, 'signup-risk-hold');
    },

    async hasFraudulentRefundMatch(partnerId) {
      try {
        const row = await internalGet<{ match: boolean }>(partnerId, 'fraudulent-refund-match');
        return row?.match === true;
      } catch (error) {
        // Hard-deny signals must fail open when the optional billing endpoint
        // is unavailable. internalGet already logs 404s and network failures;
        // only HTTP/service errors reach this catch.
        console.warn(
          `[breezeBillingClient] fraudulent-refund-match request failed for partner ${partnerId}`,
          error,
        );
        return false;
      }
    },
  };
}

export function getBreezeBillingClient(): BreezeBillingClient {
  const baseUrl = process.env.BREEZE_BILLING_URL;
  if (!baseUrl) throw new Error('BREEZE_BILLING_URL not configured.');
  return createBreezeBillingClient({ baseUrl });
}
