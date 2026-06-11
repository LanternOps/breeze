import { describe, expect, it } from 'vitest';
import { computeBroadcast, intToIpv4, ipv4ToInt, isApipaIpv4 } from './wakeOnLan';

describe('ipv4ToInt', () => {
  it('converts dotted-quad to 32-bit int', () => {
    expect(ipv4ToInt('0.0.0.0')).toBe(0);
    expect(ipv4ToInt('255.255.255.255')).toBe(0xffffffff);
    expect(ipv4ToInt('192.168.1.42')).toBe(0xc0a8012a);
    expect(ipv4ToInt('10.0.0.1')).toBe(0x0a000001);
  });

  it('rejects malformed input', () => {
    expect(ipv4ToInt('192.168.1')).toBeNull();
    expect(ipv4ToInt('192.168.1.256')).toBeNull();
    expect(ipv4ToInt('192.168.1.-1')).toBeNull();
    expect(ipv4ToInt('not-an-ip')).toBeNull();
    expect(ipv4ToInt('192.168.1.42.5')).toBeNull();
    expect(ipv4ToInt('::1')).toBeNull();
  });
});

describe('intToIpv4', () => {
  it('round-trips with ipv4ToInt', () => {
    const samples = ['0.0.0.0', '255.255.255.255', '192.168.1.42', '10.0.0.1'];
    for (const ip of samples) {
      const n = ipv4ToInt(ip);
      expect(n).not.toBeNull();
      expect(intToIpv4(n!)).toBe(ip);
    }
  });
});

describe('computeBroadcast', () => {
  it('computes /24', () => {
    expect(computeBroadcast('192.168.1.42', '255.255.255.0')).toEqual({
      network: '192.168.1.0',
      broadcast: '192.168.1.255',
    });
  });

  it('computes /16', () => {
    expect(computeBroadcast('10.5.7.42', '255.255.0.0')).toEqual({
      network: '10.5.0.0',
      broadcast: '10.5.255.255',
    });
  });

  it('computes /23', () => {
    expect(computeBroadcast('192.168.0.42', '255.255.254.0')).toEqual({
      network: '192.168.0.0',
      broadcast: '192.168.1.255',
    });
  });

  it('computes /32 (host route)', () => {
    expect(computeBroadcast('192.168.1.42', '255.255.255.255')).toEqual({
      network: '192.168.1.42',
      broadcast: '192.168.1.42',
    });
  });

  it('computes /8', () => {
    expect(computeBroadcast('10.5.7.42', '255.0.0.0')).toEqual({
      network: '10.0.0.0',
      broadcast: '10.255.255.255',
    });
  });

  it('returns null when ip or mask is invalid', () => {
    expect(computeBroadcast('not-an-ip', '255.255.255.0')).toBeNull();
    expect(computeBroadcast('192.168.1.42', 'not-a-mask')).toBeNull();
    expect(computeBroadcast('192.168.1.42', '')).toBeNull();
  });

  it('handles a non-contiguous mask (network is still ip & mask)', () => {
    // Real networks never use this, but the function should still produce
    // a deterministic result rather than crashing.
    const out = computeBroadcast('192.168.1.42', '255.0.255.0');
    expect(out).not.toBeNull();
    expect(out!.network).toBe('192.0.1.0');
  });
});

describe('isApipaIpv4', () => {
  it('returns true for IPs in 169.254.0.0/16', () => {
    expect(isApipaIpv4('169.254.0.0')).toBe(true);
    expect(isApipaIpv4('169.254.1.1')).toBe(true);
    expect(isApipaIpv4('169.254.148.52')).toBe(true);   // Trevor-Legion PdaNet
    expect(isApipaIpv4('169.254.213.223')).toBe(true);  // Trevor-Legion Wi-Fi
    expect(isApipaIpv4('169.254.255.255')).toBe(true);  // upper bound
  });

  it('returns false for adjacent ranges and real LAN IPs', () => {
    // 169.253.0.0 and 169.255.0.0 are just outside the APIPA /16.
    expect(isApipaIpv4('169.253.255.255')).toBe(false);
    expect(isApipaIpv4('169.255.0.0')).toBe(false);
    // Real LAN ranges must never be classified as APIPA.
    expect(isApipaIpv4('10.10.10.50')).toBe(false);
    expect(isApipaIpv4('192.168.1.1')).toBe(false);
    expect(isApipaIpv4('172.19.64.1')).toBe(false);
  });

  it('returns false for invalid input', () => {
    expect(isApipaIpv4('not-an-ip')).toBe(false);
    expect(isApipaIpv4('')).toBe(false);
    expect(isApipaIpv4('::1')).toBe(false);
  });
});
