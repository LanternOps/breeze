import { describe, expect, it } from 'vitest';
import { compareIpAddresses, ipSortKey } from './ipOrder';

describe('ipSortKey', () => {
  it('normalises IPv4 to a fixed-width numeric key', () => {
    expect(ipSortKey('10.1.2.14')).toBe(ipSortKey('10.1.2.014'));
    expect(ipSortKey('10.1.2.256')).toBeNull();
    expect(ipSortKey('10.1.2')).toBeNull();
    expect(ipSortKey('Yealink T54W')).toBeNull();
    expect(ipSortKey(null)).toBeNull();
  });

  it('normalises IPv6 spellings of one address to the same key', () => {
    expect(ipSortKey('fe80::1')).toBe(ipSortKey('FE80:0:0:0:0:0:0:0001'));
    expect(ipSortKey('::ffff:10.1.2.3')).toBe(ipSortKey('0:0:0:0:0:ffff:a01:203'));
    expect(ipSortKey('2001:db8::1%eth0')).toBe(ipSortKey('2001:db8::1'));
    expect(ipSortKey('1::2::3')).toBeNull();
    expect(ipSortKey('1:2:3:4:5:6:7:8:9')).toBeNull();
  });
});

describe('compareIpAddresses', () => {
  it('orders IPv4 numerically, not as strings (10.1.2.14 before 10.1.2.137)', () => {
    const sorted = ['10.1.2.137', '10.1.2.14', '10.1.2.2', '9.255.255.255', '10.1.10.1'].sort(compareIpAddresses);
    expect(sorted).toEqual(['9.255.255.255', '10.1.2.2', '10.1.2.14', '10.1.2.137', '10.1.10.1']);
  });

  it('puts IPv4 before IPv6, and addresses before tiles with no address', () => {
    expect([null, 'fe80::2', 'fe80::10', '10.0.0.1', 'not an ip'].sort(compareIpAddresses)).toEqual(['10.0.0.1', 'fe80::2', 'fe80::10', null, 'not an ip']);
  });
});
