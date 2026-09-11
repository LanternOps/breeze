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

/**
 * Risk-hold status for a partner, as reported by breeze-billing.
 *
 * - `none` — breeze-billing has records for this partner (or affirmatively has
 *   none at all) and nothing is holding it.
 * - `pass` — an unreleased assessment row explicitly cleared the partner.
 * - `hold` / `review_pending` — an unreleased row is blocking.
 *
 * A `null` return from `getSignupRiskHold` is NOT one of these: it means the
 * status could not be determined and callers must fail closed.
 */
export type SignupRiskHoldStatus = 'none' | 'hold' | 'review_pending' | 'pass';

export interface SignupRiskHold {
  status: SignupRiskHoldStatus;
}

/**
 * The one 404 body that means "breeze-billing answered, and this partner has
 * no signup-risk records" (`routes/signupRiskInternal.ts`). Every other 404 —
 * a missing route, a proxy's HTML error page, a generic `Not Found` — means we
 * did not reach the endpoint and must stay fail-closed.
 */
const NO_RISK_RECORDS_ERROR = 'no signup-risk records for partner';

type SignupRiskHoldRow = { state?: unknown; releasedAt?: unknown };

/**
 * Derives a single status from breeze-billing's hold rows. Only unreleased
 * rows count. An unrecognised state is treated as a hold: a state we do not
 * know the semantics of must never read as "clear".
 */
export function deriveSignupRiskHoldStatus(holds: SignupRiskHoldRow[]): SignupRiskHoldStatus {
  const open = holds.filter((row) => row.releasedAt === null || row.releasedAt === undefined);
  if (open.length === 0) return 'none';
  const states = open.map((row) => (typeof row.state === 'string' ? row.state : ''));
  if (states.some((state) => state === 'hold' || !['review_pending', 'pass', 'released'].includes(state))) {
    return 'hold';
  }
  if (states.includes('review_pending')) return 'review_pending';
  if (states.includes('pass')) return 'pass';
  return 'none';
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
      // breeze-billing mounts this as GET /internal/signup-risk/holds/:partnerId
      // (src/index.ts + routes/signupRiskInternal.ts) — NOT under
      // /internal/partners/:id, so it cannot go through internalGet.
      const headers: Record<string, string> = {};
      const billingKey = process.env.BREEZE_BILLING_API_KEY;
      if (billingKey) headers.Authorization = `Bearer ${billingKey}`;
      const url = `${opts.baseUrl}/internal/signup-risk/holds/${encodeURIComponent(partnerId)}`;
      const unknown = (why: string): null => {
        console.warn(`[breezeBillingClient] signup-risk hold unknown for partner ${partnerId}: ${why}`);
        return null;
      };
      try {
        const res = await doFetch(url, { method: 'GET', headers });
        if (res.status === 404) {
          // Only the exact domain body means "no records". A generic or HTML
          // 404 means the route is missing — stay fail-closed.
          const body = await res.json().catch(() => null) as { error?: unknown } | null;
          if (body && typeof body === 'object' && body.error === NO_RISK_RECORDS_ERROR) {
            return { status: 'none' };
          }
          return unknown('404 without the no-records body');
        }
        if (!res.ok) return unknown(`HTTP ${res.status}`);
        const body = await res.json().catch(() => null) as
          { partnerId?: unknown; holds?: unknown } | null;
        if (!body || typeof body !== 'object') return unknown('malformed body');
        if (!Array.isArray(body.holds)) return unknown('missing holds array');
        if (typeof body.partnerId === 'string' && body.partnerId !== partnerId) {
          return unknown('body is for a different partner');
        }
        return { status: deriveSignupRiskHoldStatus(body.holds as SignupRiskHoldRow[]) };
      } catch (error) {
        console.warn(
          `[breezeBillingClient] signup-risk hold request failed for partner ${partnerId}`,
          error,
        );
        return null;
      }
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
