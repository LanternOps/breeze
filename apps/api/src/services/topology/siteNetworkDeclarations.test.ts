import { describe, expect, it } from 'vitest';
import { foldDeclarations, normalizeDeclaredPrefix } from './siteNetworkDeclarations';

const SITE_A = '00000000-0000-4000-8000-00000000000a';
const SITE_B = '00000000-0000-4000-8000-00000000000b';
const P1 = '10000000-0000-4000-8000-000000000001';
const P2 = '10000000-0000-4000-8000-000000000002';
const B1 = '20000000-0000-4000-8000-000000000001';

describe('normalizeDeclaredPrefix', () => {
  it.each([
    ['10.1.5.0/24', '10.1.5.0/24'],
    ['10.1.5.1/24', '10.1.5.0/24'], // host bits zeroed
    [' 192.168.1.0/24 ', '192.168.1.0/24'],
    ['10.0.0.0/8', '10.0.0.0/8'], // valid declaration; exact matching makes it claim nothing smaller
    ['172.16.4.0/22', '172.16.4.0/22'],
    ['172.16.7.200/22', '172.16.4.0/22'],
    ['255.255.255.252/30', '255.255.255.252/30'], // top of the range: no signed-shift surprises
    ['200.1.2.3/8', '200.0.0.0/8'],
  ])('accepts %s → %s', (input, expected) => expect(normalizeDeclaredPrefix(input)).toBe(expected));
  it.each([
    '10.1.5.0-10.1.5.255', '10.1.5.7', '10.1.5.0/31', '10.1.5.7/32', '10.0.0.0/7',
    'fd00::/64', '2001:db8::/48', 'garbage', '', '10.1.5.0/33', '300.1.1.0/24',
    '10.1.5.0/024', '10.1.5/24', '10.1.5.0/24/1',
  ])('rejects %s', (input) => expect(normalizeDeclaredPrefix(input)).toBeNull());
  it('rejects non-strings without throwing', () => {
    expect(normalizeDeclaredPrefix(null as unknown as string)).toBeNull();
    expect(normalizeDeclaredPrefix(undefined as unknown as string)).toBeNull();
  });
});

describe('foldDeclarations', () => {
  it('merges sources per prefix, never duplicates a source, and counts rejected entries', () => {
    const { bySite, ignored } = foldDeclarations([
      { kind: 'discovery_profile', id: P1, site_id: SITE_A, raw: '10.1.5.1/24' },
      { kind: 'discovery_profile', id: P1, site_id: SITE_A, raw: '10.1.5.0/24' }, // same profile, same normalized prefix
      { kind: 'discovery_profile', id: P2, site_id: SITE_A, raw: '10.1.5.0/24' },
      { kind: 'network_baseline', id: B1, site_id: SITE_A, raw: '10.1.5.0/24' },
      { kind: 'discovery_profile', id: P1, site_id: SITE_A, raw: '10.1.5.0-10.1.5.255' },
      { kind: 'discovery_profile', id: P1, site_id: SITE_A, raw: 'junk' },
      { kind: 'discovery_profile', id: P2, site_id: SITE_B, raw: '10.1.7.0/24' },
    ]);
    expect(ignored).toBe(2);
    expect(bySite.get(SITE_A)?.get('10.1.5.0/24')).toEqual([
      { kind: 'discovery_profile', id: P1 }, { kind: 'discovery_profile', id: P2 }, { kind: 'network_baseline', id: B1 },
    ]);
    expect([...bySite.get(SITE_A)!.keys()]).toEqual(['10.1.5.0/24']);
    expect([...bySite.get(SITE_B)!.keys()]).toEqual(['10.1.7.0/24']);
  });
});
