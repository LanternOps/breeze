import { describe, it, expect } from 'vitest';
import {
  ipv4ToInt,
  intToIpv4,
  parseCidr,
  ipInSubnet,
  parseProfileSubnets,
  groupNodesBySubnet,
  UNGROUPED_LABEL
} from './topologySubnets';

describe('ipv4ToInt / intToIpv4', () => {
  it('round-trips a dotted quad', () => {
    expect(ipv4ToInt('10.0.2.15')).toBe(10 * 16777216 + 0 + 2 * 256 + 15);
    expect(intToIpv4(ipv4ToInt('192.168.1.1')!)).toBe('192.168.1.1');
    expect(intToIpv4(ipv4ToInt('255.255.255.255')!)).toBe('255.255.255.255');
  });

  it('rejects malformed addresses', () => {
    expect(ipv4ToInt('10.0.2')).toBeNull();
    expect(ipv4ToInt('10.0.2.300')).toBeNull();
    expect(ipv4ToInt('10.0.2.x')).toBeNull();
    expect(ipv4ToInt('')).toBeNull();
  });
});

describe('parseCidr', () => {
  it('normalizes the network base by masking host bits', () => {
    const cidr = parseCidr('10.0.2.37/24');
    expect(cidr).not.toBeNull();
    expect(cidr!.label).toBe('10.0.2.0/24');
    expect(cidr!.prefix).toBe(24);
  });

  it('handles non-octet-aligned prefixes (/23, /16, /28)', () => {
    expect(parseCidr('10.0.3.0/23')!.label).toBe('10.0.2.0/23');
    expect(parseCidr('172.16.55.0/16')!.label).toBe('172.16.0.0/16');
    expect(parseCidr('192.168.1.130/28')!.label).toBe('192.168.1.128/28');
  });

  it('treats a bare IP as a /32', () => {
    expect(parseCidr('8.8.8.8')!.label).toBe('8.8.8.8/32');
  });

  it('rejects invalid CIDRs', () => {
    expect(parseCidr('not-a-cidr')).toBeNull();
    expect(parseCidr('10.0.0.0/33')).toBeNull();
    expect(parseCidr('10.0.0.0/abc')).toBeNull();
    expect(parseCidr('')).toBeNull();
  });
});

describe('ipInSubnet', () => {
  it('matches across non-/24 masks', () => {
    const slash23 = parseCidr('10.0.2.0/23')!;
    expect(ipInSubnet('10.0.2.5', slash23)).toBe(true);
    expect(ipInSubnet('10.0.3.250', slash23)).toBe(true); // still inside the /23
    expect(ipInSubnet('10.0.4.1', slash23)).toBe(false);
  });

  it('returns false for invalid IPs', () => {
    expect(ipInSubnet('garbage', parseCidr('10.0.0.0/8')!)).toBe(false);
  });
});

describe('parseProfileSubnets', () => {
  it('parses, dedupes and sorts profile CIDRs', () => {
    const subnets = parseProfileSubnets([
      '192.168.1.0/24',
      '10.0.0.0/8',
      '192.168.1.50/24', // dupe of the first once normalized
      'garbage'
    ]);
    expect(subnets.map((s) => s.label)).toEqual(['10.0.0.0/8', '192.168.1.0/24']);
  });
});

describe('groupNodesBySubnet', () => {
  const node = (id: string, ip?: string) => ({ id, ipAddress: ip });

  it('groups nodes into the profile CIDR that contains them', () => {
    const subnets = parseProfileSubnets(['10.0.2.0/24', '192.168.0.0/16']);
    const groups = groupNodesBySubnet(
      [node('a', '10.0.2.5'), node('b', '10.0.2.9'), node('c', '192.168.4.10')],
      subnets
    );

    const byLabel = Object.fromEntries(groups.map((g) => [g.label, g.nodes.map((n) => n.id)]));
    expect(byLabel['10.0.2.0/24']).toEqual(['a', 'b']);
    expect(byLabel['192.168.0.0/16']).toEqual(['c']);
  });

  it('prefers the most-specific containing subnet (/28 over enclosing /24)', () => {
    const subnets = parseProfileSubnets(['10.0.2.0/24', '10.0.2.0/28']);
    const groups = groupNodesBySubnet([node('a', '10.0.2.3'), node('b', '10.0.2.40')], subnets);
    const byLabel = Object.fromEntries(groups.map((g) => [g.label, g.nodes.map((n) => n.id)]));
    expect(byLabel['10.0.2.0/28']).toEqual(['a']); // .3 is inside the /28
    expect(byLabel['10.0.2.0/24']).toEqual(['b']); // .40 falls outside the /28
  });

  it('falls back to a synthesized /24 when no profile CIDR matches', () => {
    const groups = groupNodesBySubnet([node('a', '172.16.5.9')], []);
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe('172.16.5.0/24');
    expect(groups[0].cidr).toBeNull();
  });

  it('buckets nodes with no/invalid IP under Ungrouped, listed last', () => {
    const subnets = parseProfileSubnets(['10.0.2.0/24']);
    const groups = groupNodesBySubnet(
      [node('a', '10.0.2.1'), node('b'), node('c', 'nonsense')],
      subnets
    );
    expect(groups[groups.length - 1].label).toBe(UNGROUPED_LABEL);
    const ungrouped = groups.find((g) => g.label === UNGROUPED_LABEL)!;
    expect(ungrouped.nodes.map((n) => n.id).sort()).toEqual(['b', 'c']);
  });

  it('orders real CIDR groups before fallback groups before Ungrouped', () => {
    const subnets = parseProfileSubnets(['10.0.2.0/24']);
    const groups = groupNodesBySubnet(
      [node('real', '10.0.2.1'), node('fallback', '203.0.113.5'), node('none')],
      subnets
    );
    expect(groups.map((g) => g.label)).toEqual([
      '10.0.2.0/24',
      '203.0.113.0/24',
      UNGROUPED_LABEL
    ]);
  });
});
