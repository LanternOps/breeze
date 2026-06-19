import { describe, it, expect } from 'vitest';
import { isQuoteExpired } from './quoteExpiry';

describe('isQuoteExpired', () => {
  // A quote is valid THROUGH the end of its expiry_date (lenient to the customer);
  // it becomes expired only once the (UTC) calendar day has moved past expiry_date.
  const asOf = new Date('2026-06-17T12:00:00Z'); // "today" = 2026-06-17 (UTC)

  it('is not expired when there is no expiry date', () => {
    expect(isQuoteExpired(null, asOf)).toBe(false);
    expect(isQuoteExpired(undefined, asOf)).toBe(false);
  });

  it('is not expired on the expiry date itself (valid through that day)', () => {
    expect(isQuoteExpired('2026-06-17', asOf)).toBe(false);
  });

  it('is not expired before the expiry date', () => {
    expect(isQuoteExpired('2026-06-18', asOf)).toBe(false);
    expect(isQuoteExpired('2027-01-01', asOf)).toBe(false);
  });

  it('is expired the day after the expiry date', () => {
    expect(isQuoteExpired('2026-06-16', asOf)).toBe(true);
    expect(isQuoteExpired('2025-01-01', asOf)).toBe(true);
  });

  it('treats the UTC day boundary leniently — just-past-midnight UTC does not expire that day', () => {
    // 00:00:30 on 2026-06-17 UTC: a quote with expiry 2026-06-17 is still valid.
    const justAfterMidnight = new Date('2026-06-17T00:00:30Z');
    expect(isQuoteExpired('2026-06-17', justAfterMidnight)).toBe(false);
    // ...but one whose expiry was the previous day is expired.
    expect(isQuoteExpired('2026-06-16', justAfterMidnight)).toBe(true);
  });

  it('defaults asOf to now when omitted (a far-past expiry is always expired)', () => {
    expect(isQuoteExpired('2000-01-01')).toBe(true);
  });
});
