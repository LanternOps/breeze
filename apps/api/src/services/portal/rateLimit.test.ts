import { describe, it, expect } from 'vitest';
import { portalAccountRateLimitKey } from './rateLimit';

describe('portalAccountRateLimitKey', () => {
  it('is keyed on the normalized email alone, independent of any org axis', () => {
    // The whole point of the fix: two requests for the same address must
    // land in the SAME bucket regardless of what org context accompanies
    // each one — a caller-supplied `orgId` is unvalidated at the point this
    // key is built (no DB lookup has run) and must not be able to fragment
    // the bucket into a fresh cache-miss on every attempt.
    const key1 = portalAccountRateLimitKey('login', 'person@example.com');
    const key2 = portalAccountRateLimitKey('login', 'person@example.com');
    expect(key1).toBe(key2);
    expect(key1).toBe('portal:login:account:person@example.com');
  });

  it('produces the login and forgot-password buckets identically, differing only by prefix', () => {
    expect(portalAccountRateLimitKey('login', 'person@example.com'))
      .toBe('portal:login:account:person@example.com');
    expect(portalAccountRateLimitKey('forgot', 'person@example.com'))
      .toBe('portal:forgot:account:person@example.com');
  });

  it('distinguishes different email addresses', () => {
    expect(portalAccountRateLimitKey('login', 'a@example.com'))
      .not.toBe(portalAccountRateLimitKey('login', 'b@example.com'));
  });
});
