import { describe, expect, it } from 'vitest';
import {
  AccountingProviderError, providerErrorKindOf, providerFaultSuffix, providerTelemetryTags,
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

  it('is idempotent on an already-translated error', () => {
    const t = qboErrorToProviderError(raw({ status: 500 }), 'op');
    expect(qboErrorToProviderError(t, 'other')).toBe(t);
  });
});
