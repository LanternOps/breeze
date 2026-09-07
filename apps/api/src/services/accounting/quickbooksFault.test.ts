import { describe, it, expect } from 'vitest';
import { parseQboFault, qboFaultOf, qboFaultSuffix } from './quickbooksFault';

describe('parseQboFault', () => {
  it('reads code and Message out of a well-formed fault', () => {
    const fault = parseQboFault(JSON.stringify({
      Fault: { Error: [{ code: '5010', Message: 'Stale Object Error', Detail: 'Object Id 181 ... ' }] },
    }));
    expect(fault).toEqual({ code: '5010', message: 'Stale Object Error' });
  });

  it('never surfaces Detail — that is where Intuit puts the offending values', () => {
    const fault = parseQboFault(JSON.stringify({
      Fault: { Error: [{ code: '6000', Message: 'Business Validation Error', Detail: 'Customer Acme Ltd owes 4200.00' }] },
    }));
    expect(JSON.stringify(fault)).not.toContain('Acme');
    expect(JSON.stringify(fault)).not.toContain('4200');
  });

  it('accepts a numeric code (Intuit is inconsistent about quoting it)', () => {
    expect(parseQboFault(JSON.stringify({ Fault: { Error: [{ code: 610 }] } })).code).toBe('610');
  });

  it('falls back to a regex when the body is not JSON at all', () => {
    // A gateway or WAF can answer with HTML; a classifier that threw here would
    // turn a transient edge failure into an unhandled one.
    const fault = parseQboFault('<html>oops "code":"5010" "Message":"Stale Object Error"</html>');
    expect(fault).toEqual({ code: '5010', message: 'Stale Object Error' });
  });

  it('returns nulls for an empty body rather than throwing', () => {
    expect(parseQboFault('')).toEqual({ code: null, message: null });
  });

  it('caps the message so an over-long fault class cannot flood a tag or a card', () => {
    const fault = parseQboFault(JSON.stringify({ Fault: { Error: [{ Message: 'x'.repeat(400) }] } }));
    expect(fault.message!.length).toBe(120);
  });
});

describe('qboFaultOf / qboFaultSuffix', () => {
  it('reads the fields qboRequest attaches', () => {
    expect(qboFaultOf(Object.assign(new Error('x'), { qboFaultCode: '610', qboFaultMessage: 'Object Not Found' })))
      .toEqual({ code: '610', message: 'Object Not Found' });
  });

  it('is null-safe for an error that never went through the provider', () => {
    expect(qboFaultOf(new Error('boom'))).toEqual({ code: null, message: null });
    expect(qboFaultOf(undefined)).toEqual({ code: null, message: null });
  });

  it('names the fault class beside the status', () => {
    expect(qboFaultSuffix(400, { code: '6000', message: 'Business Validation Error' }))
      .toBe(' (HTTP 400: Business Validation Error)');
    expect(qboFaultSuffix(400, { code: null, message: null })).toBe(' (HTTP 400)');
    expect(qboFaultSuffix(undefined, { code: null, message: null })).toBe('');
  });
});
