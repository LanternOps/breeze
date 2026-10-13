import { EdrProviderRequestError } from './types';

/**
 * EDR response-action refusals and vendor-error classification (W03, #8167).
 *
 * Two kinds of failure, kept apart on purpose:
 *  - `EdrActionError` — a refusal BEFORE anything was written or sent (kill
 *    switch, reach, gates, capability, rate limit, duplicate). No ledger row.
 *  - `classifyVendorActionError` — what an `adapter.performAction` throw means
 *    for the already-written ledger row. The one rule that matters: if the
 *    request may have reached the vendor and we cannot tell what happened, the
 *    row stays `queued` (`dispatch_outcome_unknown`) for the reconciler, which
 *    reads vendor state and NEVER re-sends.
 */

export type EdrActionErrorCode =
  | 'actions_disabled'
  | 'connection_actions_disabled'
  | 'connection_unavailable'
  | 'unsupported'
  | 'target_not_found'
  | 'target_detached'
  | 'site_denied'
  | 'action_in_progress'
  | 'action_recently_requested'
  | 'rate_limited'
  | 'licence'
  | 'api_not_enabled'
  | 'vendor_auth'
  | 'vendor_rejected'
  | 'dispatch_outcome_unknown'
  | 'approval_required'
  | 'audit_unavailable';

export type EdrActionHttpStatus = 400 | 403 | 404 | 409 | 422 | 429 | 502 | 503;

export class EdrActionError extends Error {
  constructor(
    readonly code: EdrActionErrorCode,
    readonly httpStatus: EdrActionHttpStatus,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'EdrActionError';
  }
}

export interface VendorActionErrorClass {
  /** `queued` ONLY for an unknown outcome — the reconciler settles it. */
  rowStatus: 'failed' | 'queued';
  code: EdrActionErrorCode;
  http: 202 | 422 | 429 | 502;
  /** Breeze-generated or scrubbed+truncated vendor text; safe to store and return. */
  message: string;
  retryAfterSeconds?: number;
  /** Record the action on the tenant's `unsupported_actions` (company licence denial). */
  recordTenantDenial: boolean;
  /** Flip the connection to `reauth_required` (the KEY was rejected). */
  markReauth: boolean;
}

const MAX_VENDOR_MESSAGE = 500;

/** Strip anything that looks like a credential and cap the length. */
export function scrubVendorMessage(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const s of secrets) if (s.length >= 4) out = out.split(s).join('[redacted]');
  return out.slice(0, MAX_VENDOR_MESSAGE);
}

/**
 * Map a `performAction` throw to the ledger outcome. Exact table in the W03
 * plan (Task A5); `actionErrors.test.ts` enumerates it.
 */
export function classifyVendorActionError(e: unknown, secrets: readonly string[] = []): VendorActionErrorClass {
  const base = { recordTenantDenial: false, markReauth: false } as const;
  if (!(e instanceof EdrProviderRequestError)) {
    // Anything that is not a classified vendor answer happened after the call
    // started: the vendor may have acted. Never guess "failed".
    return {
      ...base,
      rowStatus: 'queued',
      code: 'dispatch_outcome_unknown',
      http: 202,
      message: 'The vendor did not confirm the request; Breeze is checking whether it took effect.',
    };
  }
  switch (e.code) {
    case 'outcome_unknown':
      return {
        ...base,
        rowStatus: 'queued',
        code: 'dispatch_outcome_unknown',
        http: 202,
        message: 'The vendor did not confirm the request; Breeze is checking whether it took effect.',
      };
    case 'licence':
      return {
        ...base,
        rowStatus: 'failed',
        code: 'licence',
        http: 422,
        message: "This company's vendor licence does not include this action.",
        recordTenantDenial: true,
      };
    case 'api_not_enabled':
      return {
        ...base,
        rowStatus: 'failed',
        code: 'api_not_enabled',
        http: 422,
        message: 'The vendor API key lacks the API this action needs. Enable it on the key, then re-test the connection.',
      };
    case 'rate_limited':
    case 'rate_budget_exhausted': {
      const retryAfterSeconds = Math.max(1, Math.ceil((e.retryAfterMs ?? 60_000) / 1000));
      return {
        ...base,
        rowStatus: 'failed',
        code: 'rate_limited',
        http: 429,
        message: 'The vendor request budget is exhausted; nothing was sent. Try again shortly.',
        retryAfterSeconds,
      };
    }
    default:
      break;
  }
  if (e.reauth && e.scope === 'connection') {
    return {
      ...base,
      rowStatus: 'failed',
      code: 'vendor_auth',
      http: 502,
      message: 'The vendor rejected the API key; re-enter the connection credentials.',
      markReauth: true,
    };
  }
  // Every other classified code (not_found, invalid_params, forbidden,
  // vendor_error, method_not_found, http_error, unsupported_action,
  // host_not_allowed, a non-connection reauth, and any code added later) is a
  // REJECTION the vendor (or the egress guard, before sending) answered.
  return {
    ...base,
    rowStatus: 'failed',
    code: 'vendor_rejected',
    http: 502,
    message: scrubVendorMessage(e.message || 'The vendor rejected the request.', secrets),
  };
}
