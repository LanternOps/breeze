import { describe, it, expect } from 'vitest';
import type { VpnPresence } from '@breeze/shared';
import {
  getVpnProviderLabel,
  getVpnProviderBadgeClass,
  activeVpnList,
  activeVpnProviders,
  formatVpnTooltip,
  vpnList,
  getVpnBadgeClass,
  INACTIVE_VPN_BADGE_CLASS,
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

  it('active entry with stateLabel omitted is unchanged from before', () => {
    expect(
      formatVpnTooltip(
        vpn({ provider: 'tailscale', interfaceName: 'utun3', ipv4: '100.64.0.1', dnsName: 'host.ts.net' }),
      ),
    ).toBe('Tailscale · utun3 · 100.64.0.1 · host.ts.net');
  });

  it('renders an inactive entry (no interface/IPs) with a stateLabel and no empty middot segment', () => {
    const inactive = vpn({
      provider: 'netbird',
      active: false,
      interfaceName: '',
      ipv4: undefined,
      ipv6: undefined,
      dnsName: undefined,
    });
    expect(formatVpnTooltip(inactive, 'disconnected')).toBe('NetBird · disconnected');
  });
});

describe('vpnList', () => {
  it('returns [] for null/undefined/empty', () => {
    expect(vpnList(null)).toEqual([]);
    expect(vpnList(undefined)).toEqual([]);
    expect(vpnList([])).toEqual([]);
  });

  it('returns active entries before inactive ones', () => {
    const list = vpnList([
      vpn({ provider: 'openvpn', active: false, interfaceName: '' }),
      vpn({ provider: 'tailscale', active: true, interfaceName: 'utun3' }),
    ]);
    expect(list.map((v) => v.provider)).toEqual(['tailscale', 'openvpn']);
    expect(list[0].active).toBe(true);
    expect(list[1].active).toBe(false);
  });

  it('sorts each group by provider label', () => {
    const list = vpnList([
      vpn({ provider: 'wireguard', active: true, interfaceName: 'wg0' }),
      vpn({ provider: 'openvpn', active: true, interfaceName: 'tun0' }),
      vpn({ provider: 'zerotier', active: false, interfaceName: '' }),
      vpn({ provider: 'netbird', active: false, interfaceName: '' }),
    ]);
    // Active group: OpenVPN, WireGuard. Inactive group: NetBird, ZeroTier.
    expect(list.map((v) => v.provider)).toEqual(['openvpn', 'wireguard', 'netbird', 'zerotier']);
  });

  it('dedupes each group by provider+interface', () => {
    const list = vpnList([
      vpn({ provider: 'zerotier', active: true, interfaceName: 'zt0' }),
      vpn({ provider: 'zerotier', active: true, interfaceName: 'zt0' }),
      vpn({ provider: 'zerotier', active: false, interfaceName: '' }),
      vpn({ provider: 'zerotier', active: false, interfaceName: '' }),
    ]);
    expect(list).toHaveLength(2);
    expect(list.filter((v) => v.active)).toHaveLength(1);
    expect(list.filter((v) => !v.active)).toHaveLength(1);
  });
});

describe('getVpnBadgeClass', () => {
  it('returns the provider badge class when active', () => {
    expect(getVpnBadgeClass(vpn({ provider: 'tailscale', active: true }))).toBe(
      getVpnProviderBadgeClass('tailscale'),
    );
  });

  it('returns INACTIVE_VPN_BADGE_CLASS when inactive', () => {
    expect(getVpnBadgeClass(vpn({ provider: 'tailscale', active: false }))).toBe(INACTIVE_VPN_BADGE_CLASS);
  });
});
