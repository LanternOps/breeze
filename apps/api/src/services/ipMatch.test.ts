import { describe, it, expect } from 'vitest';
import { ipMatchesAny, isValidIpOrCidr } from './ipMatch';

describe('ipMatchesAny — IPv4', () => {
  it('matches an exact IPv4 address', () => {
    expect(ipMatchesAny('203.0.113.10', ['203.0.113.10'])).toBe(true);
    expect(ipMatchesAny('203.0.113.11', ['203.0.113.10'])).toBe(false);
  });

  it('matches inside an IPv4 CIDR range', () => {
    expect(ipMatchesAny('10.0.5.7', ['10.0.0.0/16'])).toBe(true);
    expect(ipMatchesAny('10.1.5.7', ['10.0.0.0/16'])).toBe(false);
  });

  it('treats /0 as matching everything', () => {
    expect(ipMatchesAny('1.2.3.4', ['0.0.0.0/0'])).toBe(true);
  });

  it('returns false for an empty list', () => {
    expect(ipMatchesAny('1.2.3.4', [])).toBe(false);
  });

  it('ignores blank/whitespace entries', () => {
    expect(ipMatchesAny('1.2.3.4', ['  ', '1.2.3.4'])).toBe(true);
  });
});

describe('ipMatchesAny — IPv6', () => {
  it('matches an exact IPv6 address regardless of compression', () => {
    expect(ipMatchesAny('2001:db8::1', ['2001:0db8:0000:0000:0000:0000:0000:0001'])).toBe(true);
  });

  it('matches inside an IPv6 CIDR range', () => {
    expect(ipMatchesAny('2001:db8:0:0:0:0:0:abcd', ['2001:db8::/32'])).toBe(true);
    expect(ipMatchesAny('2001:db9::1', ['2001:db8::/32'])).toBe(false);
  });

  it('does not cross address families', () => {
    expect(ipMatchesAny('203.0.113.10', ['2001:db8::/32'])).toBe(false);
    expect(ipMatchesAny('2001:db8::1', ['10.0.0.0/8'])).toBe(false);
  });
});

describe('isValidIpOrCidr', () => {
  it('accepts valid IPv4, IPv6, and CIDR', () => {
    expect(isValidIpOrCidr('203.0.113.10')).toBe(true);
    expect(isValidIpOrCidr('10.0.0.0/16')).toBe(true);
    expect(isValidIpOrCidr('2001:db8::1')).toBe(true);
    expect(isValidIpOrCidr('2001:db8::/32')).toBe(true);
  });

  it('rejects malformed entries', () => {
    expect(isValidIpOrCidr('999.1.1.1')).toBe(false);
    expect(isValidIpOrCidr('10.0.0.0/33')).toBe(false);
    expect(isValidIpOrCidr('2001:db8::/129')).toBe(false);
    expect(isValidIpOrCidr('not-an-ip')).toBe(false);
    expect(isValidIpOrCidr('')).toBe(false);
  });
});
