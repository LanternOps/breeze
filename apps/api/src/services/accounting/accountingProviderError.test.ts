import { describe, expect, it } from 'vitest';
import {
  ACCOUNTING_REFUSAL_CODES,
  AccountingProviderError, DEFAULT_RATE_LIMIT_DELAY_MS, providerErrorKindOf, providerFaultSuffix,
  providerRateLimitedMessage, providerRateLimitedRetryLaterMessage, providerRateLimitedTryAgainMessage,
  providerTelemetryTags, rateLimitRetryAfterMs, rateLimitSourceOf, refusalCodeOf,
} from './accountingProviderError';
import { qboErrorToProviderError } from './quickbooksFault';

describe('AccountingProviderError', () => {
  it('keeps the original message and exposes httpStatus as status', () => {
    const e = new AccountingProviderError({ kind: 'transient', provider: 'quickbooks', operation: 'QuickBooks invoice push', httpStatus: 500 });
    expect(e.message).toBe('QuickBooks invoice push failed with 500');
    expect(e.status).toBe(500);
  });

  it('providerFaultSuffix reproduces qboFaultSuffix byte-for-byte', () => {
    const e = new AccountingProviderError({ kind: 'validation', provider: 'quickbooks', operation: 'x', httpStatus: 400, providerMessage: 'Business Validation Error' });
    expect(providerFaultSuffix(e)).toBe(' (HTTP 400: Business Validation Error)');
    expect(providerFaultSuffix(Object.assign(new Error('raw'), { status: 500 }))).toBe(' (HTTP 500)');
    expect(providerFaultSuffix(new Error('raw'))).toBe('');
  });

  it('non-provider errors are transient and carry no provider tags', () => {
    expect(providerErrorKindOf(new TypeError('bug'))).toBe('transient');
    expect(providerTelemetryTags(new TypeError('bug'))).toEqual({});
  });
});

describe('qboErrorToProviderError (QBO boundary)', () => {
  const raw = (fields: Record<string, unknown>, message = 'QuickBooks invoice void failed with 400') =>
    Object.assign(new Error(message), fields);

  it.each([
    [raw({ status: 400, qboError: 'invalid_grant' }, 'invalid_grant'), 'reauth'],
    [raw({ status: 400, qboFaultCode: '6000', qboFaultMessage: 'Business Validation Error', qboPaymentLinked: true }), 'payment_linked'],
    [raw({ status: 400, qboFaultCode: '5010', qboFaultMessage: 'Stale Object Error' }), 'stale_version'],
    [raw({ status: 400, qboFaultCode: '610', qboFaultMessage: 'Object Not Found' }), 'not_found'],
    [raw({ status: 400, body: '{"Fault":{"Error":[{"Message":"Duplicate Document Number Error"}]}}' }), 'duplicate_doc_number'],
    [raw({ status: 400, qboFaultCode: '6000', qboFaultMessage: 'Business Validation Error' }), 'validation'],
    // The status-400 gate on the message regex: a 503 that merely mentions
    // invalid_grant must NOT become a forced reauth disconnect.
    [raw({ status: 503 }, 'upstream 503 mentioning invalid_grant'), 'transient'],
    [raw({ status: 400 }, 'invalid_grant: token revoked'), 'reauth'],
    [raw({ status: 429 }), 'rate_limited'],
    [raw({ status: 503 }), 'transient'],
    [new Error('fetch failed'), 'transient'],
  ])('%# classifies', (err, kind) => {
    expect(qboErrorToProviderError(err, 'op').kind).toBe(kind);
  });

  it('keeps message, status, the QBO fields and the qbo_fault_code tag', () => {
    const t = qboErrorToProviderError(raw({ status: 400, body: 'b', qboFaultCode: '6000', qboFaultMessage: 'Business Validation Error' }), 'QuickBooks payment create');
    expect(t.message).toBe('QuickBooks invoice void failed with 400');
    expect(t.status).toBe(400);
    expect(t.providerMessage).toBe('Business Validation Error');
    expect(t.logBody).toBe('b');
    expect(t.telemetryTags).toEqual({ qbo_fault_code: '6000' });
    expect((t as unknown as { qboFaultCode: string }).qboFaultCode).toBe('6000'); // QBO-aware readers unchanged
  });

  it('a 429 carries the Retry-After qboRequest attached, else waits 60s; a non-429 carries none', () => {
    expect(qboErrorToProviderError(raw({ status: 429, retryAfterMs: 30_000 }), 'op').retryAfterMs).toBe(30_000);
    expect(qboErrorToProviderError(raw({ status: 429 }), 'op').retryAfterMs).toBe(60_000);
    expect(qboErrorToProviderError(raw({ status: 503 }), 'op').retryAfterMs).toBeUndefined();
  });

  it('a 429 is rate_limited even when its body parses as a stale/not-found fault; reauth still wins', () => {
    expect(qboErrorToProviderError(raw({ status: 429, qboFaultCode: '5010' }), 'op').kind).toBe('rate_limited');
    expect(qboErrorToProviderError(raw({ status: 429, qboFaultCode: '610' }), 'op').kind).toBe('rate_limited');
    expect(qboErrorToProviderError(raw({ status: 429, qboError: 'invalid_grant' }), 'op').kind).toBe('reauth');
  });

  it('a 429 is a PROVIDER throttle (F1); a non-throttle carries no source', () => {
    expect(qboErrorToProviderError(raw({ status: 429 }), 'op').throttleSource).toBe('provider');
    expect(qboErrorToProviderError(raw({ status: 500 }), 'op').throttleSource).toBeUndefined();
  });

  it('is idempotent on an already-translated error', () => {
    const t = qboErrorToProviderError(raw({ status: 500 }), 'op');
    expect(qboErrorToProviderError(t, 'other')).toBe(t);
  });
});

describe('throttle source (F1)', () => {
  const ape = (throttleSource?: 'provider' | 'local' | 'limiter_unavailable') => new AccountingProviderError({
    kind: 'rate_limited', provider: 'quickbooks', operation: 'op', retryAfterMs: 1_000, throttleSource,
  });

  it('reads the source off a provider error, a coordinator error, or the coordinator error\'s cause', () => {
    expect(rateLimitSourceOf(ape('local'))).toBe('local');
    expect(rateLimitSourceOf(ape('limiter_unavailable'))).toBe('limiter_unavailable');
    expect(rateLimitSourceOf(Object.assign(new Error('x'), { code: 'rate_limited', throttleSource: 'local' }))).toBe('local');
    expect(rateLimitSourceOf(new Error('x', { cause: ape('limiter_unavailable') }) as Error & { code?: string })).toBeNull();
    expect(rateLimitSourceOf(Object.assign(new Error('x', { cause: ape('limiter_unavailable') }), { code: 'rate_limited' })))
      .toBe('limiter_unavailable');
  });

  it('an unlabelled throttle is the provider\'s (the historical meaning); a non-throttle has no source', () => {
    expect(rateLimitSourceOf(ape())).toBe('provider');
    expect(rateLimitSourceOf(Object.assign(new Error('x'), { code: 'rate_limited' }))).toBe('provider');
    expect(rateLimitSourceOf(new AccountingProviderError({ kind: 'transient', provider: 'quickbooks', operation: 'op' }))).toBeNull();
    expect(rateLimitSourceOf(new Error('x'))).toBeNull();
  });

  it('the provider wording is byte-identical to before; local and limiter wording never blames the provider', () => {
    expect(providerRateLimitedMessage('QuickBooks')).toBe('QuickBooks is rate limiting requests; retrying automatically');
    expect(providerRateLimitedMessage('QuickBooks', 'provider')).toBe('QuickBooks is rate limiting requests; retrying automatically');
    expect(providerRateLimitedMessage('QuickBooks', 'local')).toBe('Breeze is pacing requests to QuickBooks; retrying automatically');
    expect(providerRateLimitedMessage('QuickBooks', 'limiter_unavailable'))
      .toBe('Breeze could not reach its rate limiter; retrying automatically');
    expect(providerRateLimitedRetryLaterMessage('QuickBooks', 'push'))
      .toBe('QuickBooks is rate limiting requests; push again if this does not clear shortly');
    expect(providerRateLimitedRetryLaterMessage('QuickBooks', 'sync', 'local'))
      .toBe('Breeze is pacing requests to QuickBooks; sync again if this does not clear shortly');
    expect(providerRateLimitedRetryLaterMessage('QuickBooks', 'push', 'limiter_unavailable'))
      .toBe('Breeze could not reach its rate limiter; push again if this does not clear shortly');
    expect(providerRateLimitedTryAgainMessage('QuickBooks')).toBe('QuickBooks is rate limiting requests; try again shortly');
    expect(providerRateLimitedTryAgainMessage('QuickBooks', 'local')).toBe('Breeze is pacing requests to QuickBooks; try again shortly');
    expect(providerRateLimitedTryAgainMessage('QuickBooks', 'limiter_unavailable'))
      .toBe('Breeze could not reach its rate limiter; try again shortly');
  });
});

describe('rateLimitRetryAfterMs guards (F4)', () => {
  it('a non-finite retryAfterMs falls back to the default (NaN would be an immediate, attempt-free retry loop)', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(rateLimitRetryAfterMs(new AccountingProviderError({ kind: 'rate_limited', provider: 'quickbooks', operation: 'op', retryAfterMs: bad })))
        .toBe(DEFAULT_RATE_LIMIT_DELAY_MS);
      expect(rateLimitRetryAfterMs(Object.assign(new Error('x'), { code: 'rate_limited', retryAfterMs: bad }))).toBe(DEFAULT_RATE_LIMIT_DELAY_MS);
    }
  });
});

describe('refusalCodeOf (Xero W03)', () => {
  const err = (kind: 'validation' | 'not_found' | 'transient' | 'rate_limited', providerCode?: string) =>
    new AccountingProviderError({ kind, provider: 'xero', operation: 'op', providerCode });

  it.each(ACCOUNTING_REFUSAL_CODES)('returns %s for a validation error carrying it', (code) => {
    expect(refusalCodeOf(err('validation', code))).toBe(code);
  });
  it('returns remote_missing for a not_found error carrying it', () => {
    expect(refusalCodeOf(err('not_found', 'remote_missing'))).toBe('remote_missing');
  });
  it('ignores a bare not_found (a QuickBooks 610 carries its own fault code)', () => {
    expect(refusalCodeOf(err('not_found', '610'))).toBeNull();
    expect(refusalCodeOf(err('not_found'))).toBeNull();
  });
  it('ignores a provider fault code that is not a neutral validation code (e.g. a QuickBooks 6240)', () => {
    expect(refusalCodeOf(err('validation', '6240'))).toBeNull();
  });
  it('ignores the code on any non-validation kind (a 429 carries X-Rate-Limit-Problem in providerCode)', () => {
    expect(refusalCodeOf(err('rate_limited', 'minute'))).toBeNull();
    expect(refusalCodeOf(err('transient', 'duplicate_name'))).toBeNull();
  });
  it('returns null for a non-provider error', () => {
    expect(refusalCodeOf(new Error('duplicate_name'))).toBeNull();
    expect(refusalCodeOf(null)).toBeNull();
  });
});

describe('remote_locked refusal code (Xero W04)', () => {
  it('is a neutral refusal code on a validation error', () => {
    expect(ACCOUNTING_REFUSAL_CODES).toContain('remote_locked');
    expect(refusalCodeOf(new AccountingProviderError({ kind: 'validation', provider: 'xero', operation: 'op', providerCode: 'remote_locked' })))
      .toBe('remote_locked');
  });
});
