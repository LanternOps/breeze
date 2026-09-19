import { describe, it, expect } from 'vitest';
import { isQboPaymentLinkedRefusal, parseQboFault, qboFaultOf, qboFaultSuffix } from './quickbooksFault';

describe('parseQboFault', () => {
  it('reads code and Message out of a well-formed fault', () => {
    const fault = parseQboFault(JSON.stringify({
      Fault: { Error: [{ code: '5010', Message: 'Stale Object Error', Detail: 'Object Id 181 ... ' }] },
    }));
    expect(fault).toEqual({ code: '5010', message: 'Stale Object Error', paymentLinked: false });
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
    expect(fault).toEqual({ code: '5010', message: 'Stale Object Error', paymentLinked: false });
  });

  it('returns nulls for an empty body rather than throwing', () => {
    expect(parseQboFault('')).toEqual({ code: null, message: null, paymentLinked: false });
  });

  it('caps the message so an over-long fault class cannot flood a tag or a card', () => {
    const fault = parseQboFault(JSON.stringify({ Fault: { Error: [{ Message: 'x'.repeat(400) }] } }));
    expect(fault.message!.length).toBe(120);
  });
});

describe('qboFaultOf / qboFaultSuffix', () => {
  it('reads the fields qboRequest attaches', () => {
    expect(qboFaultOf(Object.assign(new Error('x'), { qboFaultCode: '610', qboFaultMessage: 'Object Not Found' })))
      .toEqual({ code: '610', message: 'Object Not Found', paymentLinked: false });
  });

  it('is null-safe for an error that never went through the provider', () => {
    expect(qboFaultOf(new Error('boom'))).toEqual({ code: null, message: null, paymentLinked: false });
    expect(qboFaultOf(undefined)).toEqual({ code: null, message: null, paymentLinked: false });
  });

  it('names the fault class beside the status', () => {
    expect(qboFaultSuffix(400, { code: '6000', message: 'Business Validation Error' }))
      .toBe(' (HTTP 400: Business Validation Error)');
    expect(qboFaultSuffix(400, { code: null, message: null })).toBe(' (HTTP 400)');
    expect(qboFaultSuffix(undefined, { code: null, message: null })).toBe('');
  });
});

// ---------------------------------------------------------------------------
// #5180 — "QuickBooks will not void an invoice that has a payment applied"
// ---------------------------------------------------------------------------

describe('payment-linked refusal classification (#5180)', () => {
  // The reason lives in `Detail`, which storage truncates at 500 characters —
  // so it is read off the FULL body at parse time, exactly like `code` is.
  const paymentFault = (detail: string): string => JSON.stringify({
    Fault: { Error: [{ code: '6000', Message: 'Business Validation Error', Detail: detail }] },
  });

  it.each([
    'You cannot void this invoice because it has payments applied to it.',
    'The transaction is linked to another transaction and cannot be voided.',
    'Business Validation Error: A payment is applied to this invoice.',
  ])('flags the fault as payment-linked: %s', (detail) => {
    expect(parseQboFault(paymentFault(detail)).paymentLinked).toBe(true);
  });

  it.each([
    'Object Id 181 was changed by another user',
    'Duplicate Document Number Error : You must specify a different number.',
    '<html>502 Bad Gateway</html>',
    // The boundary that matters: faults that MENTION a payment for an entirely
    // different reason. A bare "…has payments…" pattern matched both of these,
    // which would have turned a different (possibly retryable) fault into a
    // terminal one carrying a wrong remedy — so the noun always needs its verb.
    'The transaction has payments totaling 40.00 but the line amounts do not reconcile.',
    'This estimate contains payments that must be removed before conversion.',
    'The Payment service is temporarily unavailable, please try again.',
  ])('does NOT flag an unrelated fault: %s', (detail) => {
    expect(parseQboFault(paymentFault(detail)).paymentLinked).toBe(false);
  });

  it('still never surfaces Detail — the classification is a boolean, not the text', () => {
    const fault = parseQboFault(paymentFault('Payment applied by Acme Ltd for 4200.00'));
    expect(fault.paymentLinked).toBe(true);
    expect(JSON.stringify(fault)).not.toContain('Acme');
    expect(JSON.stringify(fault)).not.toContain('4200');
  });

  it('isQboPaymentLinkedRefusal reads the flag qboRequest attached', () => {
    const err = Object.assign(new Error('QuickBooks invoice void failed with 400'), {
      status: 400, qboFaultCode: '6000', qboFaultMessage: 'Business Validation Error', qboPaymentLinked: true,
    });
    expect(isQboPaymentLinkedRefusal(err)).toBe(true);
  });

  it('falls back to the stored body when no flag was attached (older fault shape)', () => {
    const err = Object.assign(new Error('QuickBooks invoice void failed with 400'), {
      status: 400,
      qboFaultCode: '6000',
      qboFaultMessage: 'Business Validation Error',
      body: paymentFault('You cannot void a transaction that has payments applied to it.'),
    });
    expect(isQboPaymentLinkedRefusal(err)).toBe(true);
  });

  // The two gates that stand in front of the phrase match. Both exist because a
  // false positive costs a real outage its retry ladder AND tells the operator
  // to delete a payment that does not exist.
  it('refuses to classify a non-400 failure, however its body reads', () => {
    const err = Object.assign(new Error('QuickBooks invoice void failed with 503'), {
      status: 503,
      qboFaultCode: '6000',
      qboFaultMessage: 'Business Validation Error',
      qboPaymentLinked: true,
      body: paymentFault('You cannot void this invoice because it has payments applied to it.'),
    });
    expect(isQboPaymentLinkedRefusal(err)).toBe(false);
  });

  it('refuses to classify a 400 that carried no Intuit fault at all (a WAF or gateway page)', () => {
    const err = Object.assign(new Error('QuickBooks invoice void failed with 400'), {
      status: 400,
      body: '<html><body>Request blocked: payments applied to it</body></html>',
    });
    expect(isQboPaymentLinkedRefusal(err)).toBe(false);
  });

  it('does not read the error message Breeze wrote itself', () => {
    // `qboRequest` throws `"<operation> failed with <status>"`. It carries no
    // Intuit text, so it must never be part of the haystack.
    const err = Object.assign(new Error('QuickBooks payments applied void failed with 400'), {
      status: 400, qboFaultCode: '6140', qboFaultMessage: 'Duplicate Document Number Error',
    });
    expect(isQboPaymentLinkedRefusal(err)).toBe(false);
  });

  it('is false for a plain upstream failure — the classification only ever makes a retryable error terminal', () => {
    expect(isQboPaymentLinkedRefusal(new Error('fetch failed'))).toBe(false);
    expect(isQboPaymentLinkedRefusal(Object.assign(new Error('boom'), {
      status: 500, qboFaultCode: '5010', qboFaultMessage: 'Stale Object Error',
    }))).toBe(false);
    expect(isQboPaymentLinkedRefusal(Object.assign(new Error('boom'), {
      status: 400, qboFaultCode: '5010', qboFaultMessage: 'Stale Object Error',
    }))).toBe(false);
    expect(isQboPaymentLinkedRefusal(undefined)).toBe(false);
  });
});
