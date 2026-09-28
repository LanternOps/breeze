/**
 * The provider-neutral failure every AccountingProvider throws (spec W01
 * "Neutral error model"). Providers translate their own faults at their
 * boundary; the core branches on `kind` ONLY and never parses a provider body.
 *
 * `providerMessage` is the short fault CLASS ("Business Validation Error") —
 * never a provider `Detail`, which carries customer names and amounts.
 * `logBody` is for the SERVER LOG only (it is never placed on a mapping card
 * or a Sentry tag). `telemetryTags` are chosen by the provider and must be id- and PII-free
 * (QuickBooks keeps its historical `qbo_fault_code` tag this way). Sentry
 * DROPS any tag key not in `ALLOWED_TAG_NAMES` (services/sentry.ts), so a
 * provider that adds a tag must allowlist it there or it never arrives.
 */
import type { AccountingProviderId } from './types';

export type AccountingProviderErrorKind =
  | 'reauth' | 'rate_limited' | 'validation' | 'not_found' | 'stale_version'
  | 'payment_linked' | 'duplicate_doc_number' | 'transient';

/**
 * WHO throttled a `rate_limited` call, so an operator is pointed at the right
 * system:
 * - `provider`: the provider answered 429 (set at the provider's boundary).
 * - `local`: Breeze's own limiter refused the call slot (window, concurrency,
 *   daily budget) before anything was sent.
 * - `limiter_unavailable`: Breeze could not read or write its limiter store
 *   (Redis) and refused the call fail-closed. An infrastructure problem.
 */
export type AccountingThrottleSource = 'provider' | 'local' | 'limiter_unavailable';

export interface AccountingProviderErrorInit {
  kind: AccountingProviderErrorKind;
  provider: AccountingProviderId;
  operation: string;
  message?: string;
  httpStatus?: number;
  providerCode?: string;
  providerMessage?: string;
  retryAfterMs?: number;
  /** `rate_limited` only; absent reads as `provider` (see `rateLimitSourceOf`). */
  throttleSource?: AccountingThrottleSource;
  logBody?: string;
  telemetryTags?: Record<string, string>;
  cause?: unknown;
}

export class AccountingProviderError extends Error {
  readonly kind: AccountingProviderErrorKind;
  readonly provider: AccountingProviderId;
  readonly operation: string;
  readonly httpStatus?: number;
  readonly providerCode?: string;
  readonly providerMessage?: string;
  readonly retryAfterMs?: number;
  readonly throttleSource?: AccountingThrottleSource;
  readonly logBody?: string;
  readonly telemetryTags: Record<string, string>;

  constructor(init: AccountingProviderErrorInit) {
    super(
      init.message ?? (init.httpStatus !== undefined ? `${init.operation} failed with ${init.httpStatus}` : `${init.operation} failed`),
      init.cause === undefined ? undefined : { cause: init.cause },
    );
    this.name = 'AccountingProviderError';
    this.kind = init.kind;
    this.provider = init.provider;
    this.operation = init.operation;
    this.httpStatus = init.httpStatus;
    this.providerCode = init.providerCode;
    this.providerMessage = init.providerMessage;
    this.retryAfterMs = init.retryAfterMs;
    this.throttleSource = init.throttleSource;
    this.logBody = init.logBody;
    this.telemetryTags = init.telemetryTags ?? {};
  }

  /** Mirrors httpStatus so generic `err.status` readers (route error mappers) keep working. */
  get status(): number | undefined {
    return this.httpStatus;
  }
}

export function isAccountingProviderError(err: unknown): err is AccountingProviderError {
  return err instanceof AccountingProviderError;
}

export function providerErrorKindOf(err: unknown): AccountingProviderErrorKind {
  return isAccountingProviderError(err) ? err.kind : 'transient';
}

function statusOf(err: unknown): number | undefined {
  if (isAccountingProviderError(err)) return err.httpStatus;
  const s = err && typeof err === 'object' ? (err as { status?: unknown }).status : undefined;
  return typeof s === 'number' ? s : undefined;
}

/** ` (HTTP 400: Business Validation Error)` — byte-identical to the old
 *  qboFaultSuffix for a translated QuickBooks error. */
export function providerFaultSuffix(err: unknown): string {
  const status = statusOf(err);
  const message = isAccountingProviderError(err) ? err.providerMessage ?? null : null;
  if (status === undefined) return message ? ` (${message})` : '';
  return message ? ` (HTTP ${status}: ${message})` : ` (HTTP ${status})`;
}

export function providerTelemetryTags(err: unknown): Record<string, string> {
  return isAccountingProviderError(err) ? { ...err.telemetryTags } : {};
}

export function providerLogFields(err: unknown): { status: string; faultCode: string; body: string } {
  const status = statusOf(err);
  return {
    status: status === undefined ? 'none' : String(status),
    faultCode: isAccountingProviderError(err) ? err.providerCode ?? 'none' : 'none',
    body: isAccountingProviderError(err) ? err.logBody ?? '' : '',
  };
}

// ---------------------------------------------------------------------------
// Rate limiting (Xero W01 "Rate limiting"): a throttle is a DELAY, not a
// failure. Coordinators re-raise it as their own `rate_limited` error (status
// 429) carrying `retryAfterMs`; workers delay the job without consuming an
// attempt (jobs/accountingJobDelay.ts) and routes answer 429 + Retry-After.
// ---------------------------------------------------------------------------

/** Used when a throttle carries no Retry-After. */
export const DEFAULT_RATE_LIMIT_DELAY_MS = 60_000;

/**
 * The Retry-After of a rate limit, or null when `err` is not one. Recognises a
 * provider's `AccountingProviderError{kind:'rate_limited'}` and any coordinator
 * error with `code: 'rate_limited'` (invoice push, payment push, mapping), so a
 * worker or route can branch on "throttled" without knowing which layer raised it.
 */
export function rateLimitRetryAfterMs(err: unknown): number | null {
  // A non-finite value (NaN from a bad header parse, Infinity) must never
  // reach a delay: NaN becomes a 0 ms delay — an immediate, attempt-free
  // retry loop — so it falls back to the default like a missing one.
  const finiteOrDefault = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : DEFAULT_RATE_LIMIT_DELAY_MS;
  if (isAccountingProviderError(err)) {
    return err.kind === 'rate_limited' ? finiteOrDefault(err.retryAfterMs) : null;
  }
  const e = err && typeof err === 'object' ? err as { code?: unknown; retryAfterMs?: unknown } : null;
  if (e?.code !== 'rate_limited') return null;
  return finiteOrDefault(e.retryAfterMs);
}

const THROTTLE_SOURCES: ReadonlySet<unknown> = new Set<AccountingThrottleSource>(['provider', 'local', 'limiter_unavailable']);

/**
 * Who throttled `err` (see AccountingThrottleSource), or null when it is not a
 * rate limit. Reads the error's own `throttleSource`, then its `cause`'s (a
 * coordinator error wrapping the provider one); a throttle that names no
 * source is the provider's — the only meaning a 429 had before sources existed.
 */
export function rateLimitSourceOf(err: unknown): AccountingThrottleSource | null {
  if (rateLimitRetryAfterMs(err) === null) return null;
  let cursor: unknown = err;
  for (let depth = 0; depth < 3 && cursor && typeof cursor === 'object'; depth++) {
    const source = (cursor as { throttleSource?: unknown }).throttleSource;
    if (THROTTLE_SOURCES.has(source)) return source as AccountingThrottleSource;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return 'provider';
}

/**
 * The first half of every throttle message, by source. The `provider` wording
 * is the pre-source wording, byte for byte; the others never blame the
 * provider for a refusal Breeze made itself or for Breeze's own Redis.
 */
function throttlePrefix(label: string, source: AccountingThrottleSource): string {
  switch (source) {
    case 'local': return `Breeze is pacing requests to ${label}`;
    case 'limiter_unavailable': return 'Breeze could not reach its rate limiter';
    default: return `${label} is rate limiting requests`;
  }
}

/** `last_error` for a throttled PAYMENT row: the outbox (sweep + delayed job)
 *  always retries it, so "retrying automatically" is true on every path. */
export function providerRateLimitedMessage(label: string, source: AccountingThrottleSource = 'provider'): string {
  return `${throttlePrefix(label, source)}; retrying automatically`;
}

/**
 * `last_error` for a throttled invoice-push or mapping row. Those rows are also
 * written by MANUAL route calls that nothing retries, so the marker must read
 * true on both the job path and the manual path (ruling P6b).
 */
export function providerRateLimitedRetryLaterMessage(
  label: string, action: 'push' | 'sync', source: AccountingThrottleSource = 'provider',
): string {
  return `${throttlePrefix(label, source)}; ${action} again if this does not clear shortly`;
}

/** Message for a throttled interactive read, which nothing retries on its own. */
export function providerRateLimitedTryAgainMessage(label: string, source: AccountingThrottleSource = 'provider'): string {
  return `${throttlePrefix(label, source)}; try again shortly`;
}

/**
 * Structured refusals a provider may attach as `providerCode` on a `kind:
 * 'validation'` (or, for remote_missing, `kind: 'not_found'`) error (Xero W03).
 * The core branches on these, never on a provider's own fault numbers or text:
 *  - duplicate_name     — the remote system refuses a second record with this name
 *                         (Xero: unique contact names). Surfaced; never auto-retried.
 *  - duplicate_key      — the provider's adoption key is already taken. The provider
 *                         answers it with an adoption lookup; it should not reach core.
 *  - remote_archived    — the record Breeze would adopt, or is mapped to, is archived.
 *  - remote_missing     — the MAPPED remote record no longer exists (kind not_found).
 *                         A bare not_found without this code keeps its old meaning.
 *  - insufficient_scope — the grant does not cover this call; reconnecting (or a
 *                         scope change) is the only fix. Surfaced; never retried.
 */
export const ACCOUNTING_REFUSAL_CODES = ['duplicate_name', 'duplicate_key', 'remote_archived', 'remote_missing', 'insufficient_scope'] as const;
export type AccountingRefusalCode = typeof ACCOUNTING_REFUSAL_CODES[number];

/** The code when `err` is a provider error of kind `validation` or `not_found` carrying one; else null. */
export function refusalCodeOf(err: unknown): AccountingRefusalCode | null {
  if (!isAccountingProviderError(err) || (err.kind !== 'validation' && err.kind !== 'not_found')) return null;
  const code = err.providerCode;
  return (ACCOUNTING_REFUSAL_CODES as readonly string[]).includes(code ?? '') ? (code as AccountingRefusalCode) : null;
}
