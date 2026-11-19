export interface CancelSubscriptionResult {
  /** false when the partner had no subscription (idempotent no-op). */
  canceled: boolean;
  stripeSubscriptionId?: string;
  immediate: boolean;
}

/**
 * Outcome of asking breeze-billing to close a restricted partner's open
 * checkouts: expire every open Checkout Session for the partner's customer,
 * then cancel any `incomplete` subscription. Sessions first: deleting a
 * subscription is refused while a session for it is still open (seen in the
 * manual abuse sweeps that did this by hand; see #11307).
 *
 * - `closed` — the billing service answered; the lists say what it closed and
 *   are empty when nothing was open (the call is idempotent).
 * - `unavailable` — 404: the billing service does not expose the endpoint
 *   (not deployed yet, or an older billing build). Nothing was closed. The
 *   endpoint's own `unknown_partner` 404 is `failed`, not this.
 * - `failed` — any other error, including a timeout or a malformed body.
 *   Nothing is known to have been closed.
 *
 * The closeOpenCheckouts method never throws: the caller records the outcome
 * on the restriction's audit trail, and a billing problem must never undo or
 * block a restriction.
 */
export type CloseOpenCheckoutsResult =
  | { status: 'closed'; expiredCheckoutSessionIds: string[]; canceledSubscriptionIds: string[] }
  | { status: 'unavailable' | 'failed'; detail: string };

/**
 * Bound on the close-checkouts call. It runs synchronously inside
 * restrictOnHardDeny, whose callers (the trust promote loop, the ip-classify
 * job, the abuse sweep) process partners one at a time, so a hung billing
 * service would otherwise stall a whole batch.
 */
const CLOSE_CHECKOUTS_TIMEOUT_MS = 10_000;

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((v) => typeof v === 'string');

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
/**
 * A row counts as released only on an affirmative, well-formed timestamp.
 * `releasedAt` arrives as untrusted JSON from a separate service, so anything
 * else — `null`, absent, `''`, `0`, `false`, an object — leaves the row OPEN.
 * Defaulting the other way would let a serialization quirk on the billing side
 * silently clear a real hold.
 */
function isReleased(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

export function deriveSignupRiskHoldStatus(holds: SignupRiskHoldRow[]): SignupRiskHoldStatus {
  const open = holds.filter((row) => !isReleased(row.releasedAt));
  if (open.length === 0) return 'none';
  const states = open.map((row) => (typeof row.state === 'string' ? row.state : ''));
  if (states.some((state) => state === 'hold' || !['review_pending', 'pass', 'released'].includes(state))) {
    return 'hold';
  }
  if (states.includes('review_pending')) return 'review_pending';
  if (states.includes('pass')) return 'pass';
  return 'none';
}

/**
 * A billing fraud flag (breeze-billing `GET /internal/fraud-flags/pending`):
 * billing's verdict that a partner must be restricted. Core does not interpret
 * it; `kind` and `restrictReason` are opaque tokens recorded on the ledger and
 * the trust audit row.
 */
export interface BillingFraudFlag {
  id: string;
  partnerId: string;
  kind: string;
  restrictReason: string;
  stripeObjectId: string;
  stripeChargeId: string | null;
  flaggedAt: Date | null;
}

/** A pending flag core could not parse. It is left pending (never consumed). */
export interface MalformedBillingFraudFlag {
  id: string | null;
  problem: string;
}

export type ConsumeFraudFlagResult = 'consumed' | 'already_consumed';

/** Bound on each fraud-flag feed call: the sweep must never hang its queue. */
const FRAUD_FLAG_TIMEOUT_MS = 10_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FLAG_KIND_RE = /^[a-z][a-z0-9_]{0,63}$/;
const RESTRICT_REASON_RE = /^auto:[a-z0-9_]{1,59}$/;

function billingAuthHeaders(json: boolean): Record<string, string> {
  const headers: Record<string, string> = json ? { 'content-type': 'application/json' } : {};
  const billingKey = process.env.BREEZE_BILLING_API_KEY;
  if (billingKey) headers.Authorization = `Bearer ${billingKey}`;
  return headers;
}

/**
 * Validates one feed entry. Returns the parsed flag, or the first field that
 * failed. Every field is untrusted JSON from another service.
 */
export function parseBillingFraudFlag(raw: unknown): BillingFraudFlag | MalformedBillingFraudFlag {
  if (!raw || typeof raw !== 'object') return { id: null, problem: 'not_an_object' };
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' && UUID_RE.test(r.id) ? r.id.toLowerCase() : null;
  if (!id) return { id: null, problem: 'id' };
  if (typeof r.partnerId !== 'string' || !UUID_RE.test(r.partnerId)) return { id, problem: 'partnerId' };
  if (typeof r.kind !== 'string' || !FLAG_KIND_RE.test(r.kind)) return { id, problem: 'kind' };
  if (typeof r.restrictReason !== 'string' || !RESTRICT_REASON_RE.test(r.restrictReason)) {
    return { id, problem: 'restrictReason' };
  }
  if (typeof r.stripeObjectId !== 'string' || r.stripeObjectId.trim() === '' || r.stripeObjectId.length > 255) {
    return { id, problem: 'stripeObjectId' };
  }
  const chargeId = typeof r.stripeChargeId === 'string' && r.stripeChargeId.length > 0 && r.stripeChargeId.length <= 255
    ? r.stripeChargeId
    : null;
  const flaggedAt = typeof r.flaggedAt === 'string' ? new Date(r.flaggedAt) : null;
  return {
    id,
    partnerId: r.partnerId.toLowerCase(),
    kind: r.kind,
    restrictReason: r.restrictReason,
    stripeObjectId: r.stripeObjectId,
    stripeChargeId: chargeId,
    flaggedAt: flaggedAt && !Number.isNaN(flaggedAt.getTime()) ? flaggedAt : null,
  };
}

function isMalformed(v: BillingFraudFlag | MalformedBillingFraudFlag): v is MalformedBillingFraudFlag {
  return 'problem' in v;
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

  /**
   * Expire a restricted partner's open Checkout Sessions and cancel its
   * `incomplete` subscriptions, via breeze-billing's service-to-service
   * `POST /internal/partners/:partnerId/close-open-checkouts`. Never throws;
   * see CloseOpenCheckoutsResult.
   */
  closeOpenCheckouts(input: { partnerId: string; reason: string }): Promise<CloseOpenCheckoutsResult>;

  /**
   * Unconsumed billing fraud flags, oldest first. THROWS (BillingError
   * BILLING_UNAVAILABLE) on any failure, including a 404 and a body without a
   * `flags` array: an unreadable feed must never read as "nothing to restrict".
   * Entries that fail validation come back in `malformed`, not in `flags`.
   */
  listPendingFraudFlags(limit: number): Promise<{ flags: BillingFraudFlag[]; malformed: MalformedBillingFraudFlag[] }>;

  /**
   * Marks a flag consumed with a terminal outcome. Once-only on the billing
   * side: a second consume answers `already_consumed`. Throws on anything
   * else: FRAUD_FLAG_REJECTED for a 4xx (this flag only), otherwise
   * BILLING_UNAVAILABLE.
   */
  consumeFraudFlag(id: string, outcome: string): Promise<ConsumeFraudFlagResult>;
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

    async closeOpenCheckouts({ partnerId, reason }) {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      const billingKey = process.env.BREEZE_BILLING_API_KEY;
      if (billingKey) headers.Authorization = `Bearer ${billingKey}`;
      const url = `${opts.baseUrl}/internal/partners/${encodeURIComponent(partnerId)}/close-open-checkouts`;
      try {
        const res = await doFetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({ reason }),
          signal: AbortSignal.timeout(CLOSE_CHECKOUTS_TIMEOUT_MS),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          const detail = `Billing service returned ${res.status}: ${body.slice(0, 200)}`;
          // The endpoint's own 404 (`unknown_partner`: billing has no record of
          // this partner) is a fault, not a missing deployment (#11952).
          if (res.status === 404 && !/"error"\s*:\s*"unknown_partner"/.test(body)) {
            console.warn(`[breezeBillingClient] close-open-checkouts unavailable for partner ${partnerId}: 404`);
            return { status: 'unavailable', detail };
          }
          return { status: 'failed', detail };
        }
        const body = await res.json().catch(() => null) as
          { expiredCheckoutSessionIds?: unknown; canceledSubscriptionIds?: unknown } | null;
        if (
          !body || typeof body !== 'object'
          || !isStringArray(body.expiredCheckoutSessionIds)
          || !isStringArray(body.canceledSubscriptionIds)
        ) {
          return { status: 'failed', detail: 'malformed response from billing service' };
        }
        return {
          status: 'closed',
          expiredCheckoutSessionIds: body.expiredCheckoutSessionIds,
          canceledSubscriptionIds: body.canceledSubscriptionIds,
        };
      } catch (error) {
        console.warn(`[breezeBillingClient] close-open-checkouts request failed for partner ${partnerId}`, error);
        return { status: 'failed', detail: error instanceof Error ? error.message : String(error) };
      }
    },

    async listPendingFraudFlags(limit) {
      const url = `${opts.baseUrl}/internal/fraud-flags/pending?limit=${encodeURIComponent(String(limit))}`;
      let res: Response;
      try {
        res = await doFetch(url, {
          method: 'GET',
          headers: billingAuthHeaders(false),
          signal: AbortSignal.timeout(FRAUD_FLAG_TIMEOUT_MS),
        });
      } catch (error) {
        throw new BillingError(
          'BILLING_UNAVAILABLE',
          `fraud-flag feed request failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new BillingError('BILLING_UNAVAILABLE', `Billing service returned ${res.status}: ${body.slice(0, 200)}`);
      }
      const body = await res.json().catch(() => null) as { flags?: unknown } | null;
      if (!body || typeof body !== 'object' || !Array.isArray(body.flags)) {
        throw new BillingError('BILLING_UNAVAILABLE', 'malformed fraud-flag feed from billing service');
      }
      const flags: BillingFraudFlag[] = [];
      const malformed: MalformedBillingFraudFlag[] = [];
      for (const raw of body.flags) {
        const parsed = parseBillingFraudFlag(raw);
        if (isMalformed(parsed)) malformed.push(parsed);
        else flags.push(parsed);
      }
      return { flags, malformed };
    },

    async consumeFraudFlag(id, outcome) {
      const url = `${opts.baseUrl}/internal/fraud-flags/${encodeURIComponent(id)}/consume`;
      let res: Response;
      try {
        res = await doFetch(url, {
          method: 'POST',
          headers: billingAuthHeaders(true),
          body: JSON.stringify({ outcome }),
          signal: AbortSignal.timeout(FRAUD_FLAG_TIMEOUT_MS),
        });
      } catch (error) {
        throw new BillingError(
          'BILLING_UNAVAILABLE',
          `fraud-flag consume request failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        // A 4xx is billing refusing THIS flag (unknown id, bad outcome) while
        // up; the caller skips just this flag. 5xx means billing is down.
        const code = res.status >= 400 && res.status < 500 ? 'FRAUD_FLAG_REJECTED' : 'BILLING_UNAVAILABLE';
        throw new BillingError(code, `Billing service returned ${res.status}: ${body.slice(0, 200)}`);
      }
      const body = await res.json().catch(() => null) as { consumed?: unknown; alreadyConsumed?: unknown } | null;
      if (body?.consumed === true) return 'consumed';
      if (body?.consumed === false && body.alreadyConsumed === true) return 'already_consumed';
      throw new BillingError('BILLING_UNAVAILABLE', 'malformed fraud-flag consume response from billing service');
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
