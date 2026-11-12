import { describe, expect, it } from 'vitest';
import {
  parseTunnelDestinationPattern,
  tunnelDestinationMatches,
  tunnelNetworkContains,
  tunnelTargetBlockReason,
  validTunnelPattern,
} from './tunnelPattern';

describe('tunnel destination patterns', () => {
  it.each([
    ['2001:db8::/32:80-443', { network: '2001:db8::/32', min: 80, max: 443 }],
    ['2001:db8::1:443', { network: '2001:db8::1', min: 443, max: 443 }],
    ['2001:db8::/64:*', { network: '2001:db8::/64', min: 1, max: 65535 }],
    ['192.0.2.0/24:443', { network: '192.0.2.0/24', min: 443, max: 443 }],
    ['10.0.0.5:9090', { network: '10.0.0.5', min: 9090, max: 9090 }],
    ['192.168.1.10/24:80', { network: '192.168.1.10/24', min: 80, max: 80 }],
  ])('parses %s', (pattern, expected) => {
    expect(parseTunnelDestinationPattern(pattern)).toEqual(expected);
  });

  it.each([
    ':80', '2001:db8::/129:80', '2001:db8::/32:', '2001:db8::1/32:443', '192.0.2.1:+80',
    '192.0.2.1:0', '192.0.2.1:65536', '192.0.2.1:443-80', 'host.example:443', 'fe80::1%eth0:22',
    ' 192.0.2.1:80', '192.0.2.0/33:80', '192.0.2.1:80-', '::ffff:10.0.0.5/104:443',
  ])('rejects %s', (pattern) => {
    expect(validTunnelPattern('destination', pattern)).toBe(false);
  });

  it('matches IPv6 address and port together', () => {
    expect(tunnelDestinationMatches('2001:db8::/32:80-443', '2001:db8::1', 443)).toBe(true);
    expect(tunnelDestinationMatches('2001:db8::/32:80-443', '2001:db9::1', 443)).toBe(false);
    expect(tunnelDestinationMatches('2001:db8::/32:80-443', '2001:db8::1', 444)).toBe(false);
    expect(tunnelDestinationMatches('2001:db8::1:443', '2001:db8::1', 443)).toBe(true);
    expect(tunnelDestinationMatches('10.0.0.0/8:*', '10.1.2.3', 8080)).toBe(true);
    expect(tunnelDestinationMatches('10.0.0.0/8:*', 'printer.example', 8080)).toBe(false);
  });

  it('keeps IPv4 rules written with host bits matching their whole prefix', () => {
    expect(tunnelDestinationMatches('192.168.1.10/24:80', '192.168.1.200', 80)).toBe(true);
  });
});

describe('tunnel source patterns', () => {
  it('accepts IPv4 and IPv6 networks only', () => {
    expect(validTunnelPattern('source', '198.51.100.0/24')).toBe(true);
    expect(validTunnelPattern('source', '2001:db8::/32')).toBe(true);
    expect(validTunnelPattern('source', '2001:db8::1')).toBe(true);
    expect(validTunnelPattern('source', 'host.example')).toBe(false);
    expect(validTunnelPattern('source', '198.51.100.0/24:80')).toBe(false);
  });

  it('matches IPv6 and IPv4-mapped client addresses', () => {
    expect(tunnelNetworkContains('2001:db8::/32', '2001:db8::5')).toBe(true);
    expect(tunnelNetworkContains('2001:db8::/32', '2001:db9::5')).toBe(false);
    expect(tunnelNetworkContains('198.51.100.0/24', '::ffff:198.51.100.7')).toBe(true);
    expect(tunnelNetworkContains('198.51.100.0/24', '198.51.101.7')).toBe(false);
  });
});

describe('tunnel target deny list', () => {
  it.each([
    '127.0.0.1', '127.8.8.8', '::1', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1',
    '169.254.169.254', '::ffff:169.254.169.254', 'fe80::1', 'fd00:ec2::254', 'fd20:ce::254',
    '0.0.0.0', '::ffff:0.0.0.0', '::',
  ])('blocks %s', (host) => {
    expect(tunnelTargetBlockReason(host, 8080, false)).not.toBeNull();
  });

  it.each(['10.0.0.5', '192.168.1.1', '2001:db8::1', 'fd00::5', 'printer.example'])('does not block %s', (host) => {
    expect(tunnelTargetBlockReason(host, 443, false)).toBeNull();
  });

  it('allows only the local VNC endpoint as a VNC exception', () => {
    expect(tunnelTargetBlockReason('127.0.0.1', 5900, true)).toBeNull();
    expect(tunnelTargetBlockReason('127.0.0.1', 5900, false)).not.toBeNull();
    expect(tunnelTargetBlockReason('127.0.0.1', 22, true)).not.toBeNull();
    expect(tunnelTargetBlockReason('::1', 5900, true)).not.toBeNull();
  });
});
