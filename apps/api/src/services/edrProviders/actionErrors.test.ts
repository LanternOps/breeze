import { describe, expect, it } from 'vitest';
import { EdrProviderRequestError, type EdrErrorScope } from './types';
import { classifyVendorActionError, EDR_VENDOR_REASON_MAX, EdrActionError, scrubVendorMessage } from './actionErrors';

const vendorErr = (code: string, o: { reauth?: boolean; scope?: EdrErrorScope; retryAfterMs?: number; message?: string } = {}) =>
  new EdrProviderRequestError(o.message ?? `vendor said ${code}`, {
    code,
    reauth: o.reauth ?? false,
    scope: o.scope ?? 'operation',
    retryAfterMs: o.retryAfterMs,
  });

describe('classifyVendorActionError — the W03 A5 mapping table', () => {
  it('licence → failed/licence 422 and records the tenant denial', () => {
    expect(classifyVendorActionError(vendorErr('licence'))).toMatchObject({
      rowStatus: 'failed', code: 'licence', http: 422, recordTenantDenial: true, markReauth: false,
    });
  });

  it('api_not_enabled (a KEY permission) → failed 422, no tenant denial', () => {
    expect(classifyVendorActionError(vendorErr('api_not_enabled'))).toMatchObject({
      rowStatus: 'failed', code: 'api_not_enabled', http: 422, recordTenantDenial: false, markReauth: false,
    });
  });

  it('connection-scoped reauth → failed/vendor_auth 502 and marks the connection', () => {
    expect(classifyVendorActionError(vendorErr('auth', { reauth: true, scope: 'connection' }))).toMatchObject({
      rowStatus: 'failed', code: 'vendor_auth', http: 502, markReauth: true, recordTenantDenial: false,
    });
  });

  it('a reauth error with any other scope does NOT touch the connection', () => {
    for (const scope of ['tenant', 'operation'] as const) {
      expect(classifyVendorActionError(vendorErr('forbidden', { reauth: true, scope }))).toMatchObject({
        rowStatus: 'failed', code: 'vendor_rejected', markReauth: false,
      });
    }
  });

  it('rate_limited / rate_budget_exhausted → failed 429 with a retry-after (nothing was accepted)', () => {
    expect(classifyVendorActionError(vendorErr('rate_limited', { retryAfterMs: 2500 }))).toMatchObject({
      rowStatus: 'failed', code: 'rate_limited', http: 429, retryAfterSeconds: 3,
    });
    expect(classifyVendorActionError(vendorErr('rate_budget_exhausted'))).toMatchObject({
      rowStatus: 'failed', code: 'rate_limited', http: 429, retryAfterSeconds: 60,
    });
  });

  it.each([
    'not_found', 'invalid_params', 'forbidden', 'vendor_error', 'method_not_found', 'http_error',
    'unsupported_action', 'host_not_allowed', 'malformed_response', 'some_future_code',
  ])('%s → failed/vendor_rejected 502 (a rejection the vendor answered)', (code) => {
    expect(classifyVendorActionError(vendorErr(code))).toMatchObject({
      rowStatus: 'failed', code: 'vendor_rejected', http: 502, recordTenantDenial: false, markReauth: false,
    });
  });

  it('outcome_unknown → stays queued / dispatch_outcome_unknown 202', () => {
    expect(classifyVendorActionError(vendorErr('outcome_unknown'))).toMatchObject({
      rowStatus: 'queued', code: 'dispatch_outcome_unknown', http: 202,
    });
  });

  it("a plain Error('socket hang up') → queued/dispatch_outcome_unknown (the vendor may have acted)", () => {
    expect(classifyVendorActionError(new Error('socket hang up'))).toMatchObject({
      rowStatus: 'queued', code: 'dispatch_outcome_unknown', http: 202,
    });
    expect(classifyVendorActionError('weird')).toMatchObject({ rowStatus: 'queued' });
  });

  it('never yields queued together with a tenant denial or a reauth flip', () => {
    const samples: unknown[] = [
      new Error('x'),
      ...['licence', 'api_not_enabled', 'rate_limited', 'outcome_unknown', 'auth', 'vendor_error'].map((c) =>
        vendorErr(c, { reauth: c === 'auth', scope: c === 'auth' ? 'connection' : 'operation' })),
    ];
    for (const s of samples) {
      const r = classifyVendorActionError(s);
      if (r.rowStatus === 'queued') {
        expect(r.recordTenantDenial).toBe(false);
        expect(r.markReauth).toBe(false);
      }
    }
  });

  it('vendor text is scrubbed of secrets and capped at 500 chars', () => {
    const r = classifyVendorActionError(vendorErr('vendor_error', { message: `bad key SECRETKEY123 ${'x'.repeat(900)}` }), ['SECRETKEY123']);
    expect(r.message).not.toContain('SECRETKEY123');
    expect(r.message.length).toBeLessThanOrEqual(500);
    expect(scrubVendorMessage('abc', ['ab'])).toBe('abc'); // < 4 chars is noise, not a secret
  });

  it('#12789: vendor text becomes plain text: markup, control and bidi characters removed, whitespace collapsed', () => {
    const raw = 'Endpoint <b>not</b> found<script>alert(1)</script>\u0000\u202E\n\t  (id   42)';
    expect(scrubVendorMessage(raw)).toBe('Endpoint not found alert(1) (id 42)');
    expect(scrubVendorMessage('<<<>>>')).toBe('');
  });

  it('#12789 review: zero-width and invisible marks are removed, so hidden text cannot split or disguise a word', () => {
    const raw = 'Iso​lated‌ by‍ ad﻿min؜ now⁠';
    expect(scrubVendorMessage(raw)).toBe('Isolated by admin now');
  });

  it('#12789: the stored vendor reason is capped at EDR_VENDOR_REASON_MAX and never carries the key', () => {
    const r = classifyVendorActionError(
      vendorErr('not_found', { message: `GravityZone incidents.createIsolateEndpointTask failed: SECRETKEY123 ${'y'.repeat(900)}` }),
      ['SECRETKEY123'],
    );
    expect(r.vendorReason).not.toBeNull();
    expect(r.vendorReason!.length).toBeLessThanOrEqual(EDR_VENDOR_REASON_MAX);
    expect(r.vendorReason).not.toContain('SECRETKEY123');
    expect(r.vendorReason).toContain('createIsolateEndpointTask failed');
  });

  it('#12789: only a vendor rejection carries a vendor reason; Breeze-worded outcomes do not', () => {
    expect(classifyVendorActionError(vendorErr('licence')).vendorReason).toBeNull();
    expect(classifyVendorActionError(vendorErr('outcome_unknown')).vendorReason).toBeNull();
    expect(classifyVendorActionError(new Error('socket')).vendorReason).toBeNull();
    expect(classifyVendorActionError(vendorErr('invalid_params', { message: 'Invalid endpoint id' })).vendorReason).toBe('Invalid endpoint id');
  });
});

describe('EdrActionError', () => {
  it('carries code, http status and retry-after', () => {
    const e = new EdrActionError('rate_limited', 429, 'slow down', 12);
    expect(e).toBeInstanceOf(Error);
    expect(e).toMatchObject({ code: 'rate_limited', httpStatus: 429, retryAfterSeconds: 12, message: 'slow down' });
  });
});
