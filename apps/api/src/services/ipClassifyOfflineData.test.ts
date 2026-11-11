import { describe, expect, it } from 'vitest';

import {
  AsnTableBuilder,
  IP_CLASS_SOURCE_NONE,
  IP_CLASS_SOURCE_OFFLINE,
  IP_CLASS_SOURCE_OFFLINE_PARTIAL,
  classifyWithOfflineData,
  isNonPublicAddress,
  isOfflineBaselineClear,
  lookupAsn,
  normalizeIp,
  parseHostingAsnList,
  parseTorExitList,
} from './ipClassifyOfflineData';

const asnTsv = [
  '198.51.100.0\t198.51.100.255\t64500\tZZ\tEXAMPLE-HOSTING',
  '203.0.113.0\t203.0.113.127\t64501\tZZ\tEXAMPLE-ACCESS',
  '203.0.113.128\t203.0.113.255\t0\tNone\tNot routed',
  '2001:db8::\t2001:db8:0:ffff:ffff:ffff:ffff:ffff\t64502\tZZ\tEXAMPLE-V6',
  'garbage line',
  '',
].join('\n');

function table() {
  const builder = new AsnTableBuilder();
  for (const line of asnTsv.split('\n')) builder.add(line);
  return builder.build();
}

describe('normalizeIp', () => {
  it('canonicalises IPv6 and unwraps IPv4-mapped addresses', () => {
    expect(normalizeIp('2001:DB8::1')).toBe('2001:0db8:0000:0000:0000:0000:0000:0001');
    expect(normalizeIp('::ffff:203.0.113.9')).toBe('203.0.113.9');
    expect(normalizeIp('203.0.113.9')).toBe('203.0.113.9');
    expect(normalizeIp('not-an-ip')).toBeNull();
  });
});

describe('isNonPublicAddress', () => {
  it.each([
    '10.0.0.5', '172.16.4.1', '192.168.1.1', '127.0.0.1', '169.254.1.1', '100.64.0.1',
    '0.0.0.0', '224.0.0.1', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1',
  ])('treats %s as non-public', (ip) => {
    expect(isNonPublicAddress(ip)).toBe(true);
  });

  it.each(['203.0.113.10', '198.51.100.7', '2001:db8::1'])('treats %s as public', (ip) => {
    expect(isNonPublicAddress(ip)).toBe(false);
  });
});

describe('parseTorExitList', () => {
  it('keeps valid addresses and drops comments, blanks and junk', () => {
    const set = parseTorExitList('# header\n203.0.113.5\n\n<html>\n2001:db8::5\n203.0.113.5\n');
    expect([...set].sort()).toEqual(['2001:0db8:0000:0000:0000:0000:0000:0005', '203.0.113.5']);
  });
});

describe('parseHostingAsnList', () => {
  it('reads the first CSV column, skipping the header and quoted names', () => {
    const set = parseHostingAsnList('ASN,Entity\n64500,"Example Hosting, Inc."\nAS64510,Other\nnope,x\n');
    expect([...set].sort()).toEqual([64500, 64510]);
  });
});

describe('lookupAsn', () => {
  it('resolves IPv4 and IPv6 ranges and ignores "not routed" rows', () => {
    const t = table();
    expect(t.ranges).toBe(3);
    expect(lookupAsn(t, '198.51.100.7')).toBe(64500);
    expect(lookupAsn(t, '203.0.113.10')).toBe(64501);
    expect(lookupAsn(t, '203.0.113.200')).toBeNull();
    expect(lookupAsn(t, '192.0.2.1')).toBeNull();
    expect(lookupAsn(t, '2001:db8::1')).toBe(64502);
    expect(lookupAsn(t, '2001:db8:1::1')).toBeNull();
  });

  it('sorts rows that arrive out of order', () => {
    const builder = new AsnTableBuilder();
    builder.add('203.0.113.0\t203.0.113.255\t64501\tZZ\tB');
    builder.add('198.51.100.0\t198.51.100.255\t64500\tZZ\tA');
    const t = builder.build();
    expect(lookupAsn(t, '198.51.100.1')).toBe(64500);
    expect(lookupAsn(t, '203.0.113.1')).toBe(64501);
  });
});

describe('classifyWithOfflineData', () => {
  const tor = parseTorExitList('203.0.113.66\n');
  const hosting = parseHostingAsnList('ASN,Entity\n64500,Example Hosting\n');

  it('flags a Tor exit as tor even without ASN data', () => {
    expect(classifyWithOfflineData('203.0.113.66', { tor, hosting, asn: null })).toEqual({
      ipClass: 'tor', asn: null, provider: IP_CLASS_SOURCE_OFFLINE_PARTIAL,
    });
    expect(classifyWithOfflineData('203.0.113.66', { tor, hosting, asn: table() })).toEqual({
      ipClass: 'tor', asn: 64501, provider: IP_CLASS_SOURCE_OFFLINE,
    });
  });

  it('flags an address in a hosting ASN as hosting', () => {
    expect(classifyWithOfflineData('198.51.100.7', { tor, hosting, asn: table() })).toEqual({
      ipClass: 'hosting', asn: 64500, provider: IP_CLASS_SOURCE_OFFLINE,
    });
  });

  it('returns unknown (never residential) with the offline marker when nothing is found', () => {
    expect(classifyWithOfflineData('203.0.113.10', { tor, hosting, asn: table() })).toEqual({
      ipClass: 'unknown', asn: 64501, provider: IP_CLASS_SOURCE_OFFLINE,
    });
  });

  it('degrades to the partial marker without ASN data or when the address is not routed', () => {
    expect(classifyWithOfflineData('203.0.113.10', { tor, hosting, asn: null })).toEqual({
      ipClass: 'unknown', asn: null, provider: IP_CLASS_SOURCE_OFFLINE_PARTIAL,
    });
    expect(classifyWithOfflineData('192.0.2.1', { tor, hosting, asn: table() })).toEqual({
      ipClass: 'unknown', asn: null, provider: IP_CLASS_SOURCE_OFFLINE_PARTIAL,
    });
  });

  it('degrades to the partial marker when the hosting list is empty', () => {
    expect(classifyWithOfflineData('203.0.113.10', { tor, hosting: new Set(), asn: table() })).toEqual({
      ipClass: 'unknown', asn: 64501, provider: IP_CLASS_SOURCE_OFFLINE_PARTIAL,
    });
  });

  it('keeps private, loopback and invalid addresses unknown with no source', () => {
    for (const ip of ['10.0.0.5', '127.0.0.1', '::1', 'nope']) {
      expect(classifyWithOfflineData(ip, { tor, hosting, asn: table() })).toEqual({
        ipClass: 'unknown', asn: null, provider: IP_CLASS_SOURCE_NONE,
      });
    }
  });
});

describe('isOfflineBaselineClear', () => {
  it('is true only for unknown + offline source while the offline classifier is active', () => {
    expect(isOfflineBaselineClear('unknown', 'offline', 'offline')).toBe(true);
    expect(isOfflineBaselineClear('unknown', 'offline', 'ipinfo')).toBe(false);
    expect(isOfflineBaselineClear('unknown', 'offline-partial', 'offline')).toBe(false);
    expect(isOfflineBaselineClear('unknown', 'none', 'offline')).toBe(false);
    expect(isOfflineBaselineClear('unknown', null, 'offline')).toBe(false);
    expect(isOfflineBaselineClear('hosting', 'offline', 'offline')).toBe(false);
    expect(isOfflineBaselineClear('tor', 'offline', 'offline')).toBe(false);
  });
});
