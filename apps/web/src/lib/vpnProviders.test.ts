import { describe, it, expect } from 'vitest';
import type { VpnPresence } from '@breeze/shared';
import {
  getVpnProviderLabel,
  getVpnProviderBadgeClass,
  activeVpnList,
  activeVpnProviders,
  formatVpnTooltip,
} from './vpnProviders';

function vpn(overrides: Partial<VpnPresence>): VpnPresence {
  return {
    provider: 'generic',
    active: true,
    interfaceName: 'utun0',
    detectionSource: 'interface',
    reportedAt: '2026-07-09T00:00:00.000Z',
    ...overrides,
  };
}

describe('getVpnProviderLabel', () => {
  it('maps known providers to display labels', () => {
    expect(getVpnProviderLabel('wireguard')).toBe('WireGuard');
    expect(getVpnProviderLabel('cloudflare-warp')).toBe('Cloudflare WARP');
    expect(getVpnProviderLabel('generic')).toBe('VPN');
  });

  it('falls back to the generic label for unknown providers', () => {
    expect(getVpnProviderLabel('nordvpn')).toBe('VPN');
  });
});

describe('getVpnProviderBadgeClass', () => {
  it('returns a class string for known and unknown providers', () => {
    expect(getVpnProviderBadgeClass('tailscale')).toContain('indigo');
    // unknown -> generic fallback, still a non-empty class string
    expect(getVpnProviderBadgeClass('mystery')).toBe(getVpnProviderBadgeClass('generic'));
  });
});

describe('activeVpnList', () => {
  it('returns [] for null/undefined/empty', () => {
    expect(activeVpnList(null)).toEqual([]);
    expect(activeVpnList(undefined)).toEqual([]);
    expect(activeVpnList([])).toEqual([]);
  });

  it('drops inactive VPNs', () => {
    const list = activeVpnList([
      vpn({ provider: 'wireguard', active: false }),
      vpn({ provider: 'tailscale', active: true }),
    ]);
    expect(list).toHaveLength(1);
    expect(list[0].provider).toBe('tailscale');
  });

  it('dedupes by provider+interface', () => {
    const list = activeVpnList([
      vpn({ provider: 'zerotier', interfaceName: 'zt0' }),
      vpn({ provider: 'zerotier', interfaceName: 'zt0' }),
      vpn({ provider: 'zerotier', interfaceName: 'zt1' }),
    ]);
    expect(list).toHaveLength(2);
  });

  it('sorts by provider label', () => {
    const list = activeVpnList([
      vpn({ provider: 'wireguard', interfaceName: 'wg0' }),
      vpn({ provider: 'openvpn', interfaceName: 'tun0' }),
    ]);
    expect(list.map((v) => v.provider)).toEqual(['openvpn', 'wireguard']);
  });
});

describe('activeVpnProviders', () => {
  it('returns distinct active provider ids', () => {
    const providers = activeVpnProviders([
      vpn({ provider: 'tailscale', interfaceName: 'utun3' }),
      vpn({ provider: 'tailscale', interfaceName: 'utun4' }),
      vpn({ provider: 'wireguard', interfaceName: 'wg0' }),
      vpn({ provider: 'openvpn', active: false }),
    ]);
    expect(providers.sort()).toEqual(['tailscale', 'wireguard']);
  });
});

describe('formatVpnTooltip', () => {
  it('joins provider, interface and available addresses/dns', () => {
    expect(
      formatVpnTooltip(
        vpn({ provider: 'tailscale', interfaceName: 'utun3', ipv4: '100.64.0.1', dnsName: 'host.ts.net' }),
      ),
    ).toBe('Tailscale · utun3 · 100.64.0.1 · host.ts.net');
  });

  it('omits missing optional fields', () => {
    expect(formatVpnTooltip(vpn({ provider: 'wireguard', interfaceName: 'wg0' }))).toBe('WireGuard · wg0');
  });
});
