import { describe, expect, it } from 'vitest';
import { pickLanIp } from './pickLanIp';

const nic = (o: Partial<{ interfaceName: string; ipAddress: string | null; ipType: string; isPrimary: boolean }>) => ({
  interfaceName: 'eth0',
  ipAddress: '10.0.0.5',
  ipType: 'ipv4',
  isPrimary: false,
  ...o,
});

describe('pickLanIp (mirrors the Devices list LAN IP tiers, routes/devices/core.ts)', () => {
  it('returns null for no rows, non-arrays and rows without an address', () => {
    expect(pickLanIp(undefined)).toBeNull();
    expect(pickLanIp('nope')).toBeNull();
    expect(pickLanIp([])).toBeNull();
    expect(pickLanIp([nic({ ipAddress: null })])).toBeNull();
  });

  it('prefers the primary interface', () => {
    expect(pickLanIp([nic({ interfaceName: 'a', ipAddress: '10.0.0.1' }), nic({ interfaceName: 'b', ipAddress: '10.0.0.2', isPrimary: true })])).toBe('10.0.0.2');
  });

  it('prefers IPv4 over IPv6', () => {
    expect(pickLanIp([nic({ interfaceName: 'a', ipAddress: 'fd00::1', ipType: 'ipv6' }), nic({ interfaceName: 'b', ipAddress: '192.168.1.9' })])).toBe('192.168.1.9');
  });

  it('ranks APIPA, loopback and link-local (any case) below routable addresses', () => {
    expect(pickLanIp([
      nic({ interfaceName: 'a', ipAddress: '169.254.3.3' }),
      nic({ interfaceName: 'b', ipAddress: '127.0.0.1' }),
      nic({ interfaceName: 'c', ipAddress: 'FE80::1', ipType: 'ipv6' }),
      nic({ interfaceName: 'd', ipAddress: '10.1.2.3' }),
    ])).toBe('10.1.2.3');
  });

  it('breaks ties by interface name', () => {
    expect(pickLanIp([nic({ interfaceName: 'wlan0', ipAddress: '10.0.0.9' }), nic({ interfaceName: 'eth0', ipAddress: '10.0.0.8' })])).toBe('10.0.0.8');
  });
});
