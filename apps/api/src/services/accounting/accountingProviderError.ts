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

export interface AccountingProviderErrorInit {
  kind: AccountingProviderErrorKind;
  provider: AccountingProviderId;
  operation: string;
  message?: string;
  httpStatus?: number;
  providerCode?: string;
  providerMessage?: string;
  retryAfterMs?: number;
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
