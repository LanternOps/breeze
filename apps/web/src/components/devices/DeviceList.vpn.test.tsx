import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import DeviceList, { type Device } from './DeviceList';
import { DEFAULT_VISIBLE_COLUMNS, writeColumnVisibility } from './columnVisibility';
import type { VpnPresence } from '@breeze/shared';

// Optional VPN column + client-side facet (#2139). Rendered purely from the
// cached inventory carried on each Device row — no live command fan-out.

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn(), registerOrgIdProvider: vi.fn() }));
// Fleet view so the fleet-only Organization column stays available to these
// suites (see DeviceList isColumnAvailable).
vi.mock('@/stores/orgStore', () => ({
  useOrgStore: (selector: (s: { currentOrgId: string | null; allOrgs: boolean }) => unknown) =>
    selector({ currentOrgId: null, allOrgs: true }),
}));
vi.mock('../remote/ConnectDesktopButton', () => ({ default: () => null }));
vi.mock('@/lib/formatTime', () => ({ formatLastSeen: () => 'just now' }));

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

function device(id: string, hostname: string, activeVpns: VpnPresence[] | null): Device {
  return {
    id,
    deviceClass: 'agent',
    hostname,
    os: 'linux',
    osVersion: '22.04',
    status: 'online',
    cpuPercent: 1,
    ramPercent: 1,
    lastSeen: new Date().toISOString(),
    orgId: 'org-1',
    orgName: 'Acme',
    siteId: 'site-1',
    siteName: 'HQ',
    agentVersion: '0.70.0',
    tags: [],
    activeVpns,
  };
}

const tailscaleBox = device('11111111-1111-1111-1111-111111111111', 'ts-box', [
  vpn({ provider: 'tailscale', interfaceName: 'tailscale0', ipv4: '100.64.0.1', dnsName: 'ts-box.tailnet.ts.net' }),
]);
const multiVpnBox = device('22222222-2222-2222-2222-222222222222', 'multi-box', [
  vpn({ provider: 'wireguard', interfaceName: 'wg0', ipv4: '10.8.0.2' }),
  vpn({ provider: 'openvpn', interfaceName: 'tun0', ipv4: '10.9.0.2' }),
  vpn({ provider: 'zerotier', interfaceName: 'zt0', ipv4: '10.147.0.2' }),
]);
const noVpnBox = device('33333333-3333-3333-3333-333333333333', 'plain-box', []);

describe('DeviceList — VPN column + facet (#2139)', () => {
  beforeEach(() => {
    writeColumnVisibility([...DEFAULT_VISIBLE_COLUMNS, 'vpn']);
  });
  afterEach(() => window.localStorage.clear());

  it('renders a provider badge for an active VPN and a dash for none', () => {
    render(<DeviceList devices={[tailscaleBox, noVpnBox]} pageSize={50} />);

    const tsCell = screen.getByTestId(`device-${tailscaleBox.id}-vpn`);
    expect(within(tsCell).getByTestId(`device-${tailscaleBox.id}-vpn-badge-tailscale`).textContent).toMatch(/Tailscale/);
    // Tooltip carries interface + IP + DNS.
    expect(tsCell.querySelector('[title]')?.getAttribute('title')).toContain('ts-box.tailnet.ts.net');

    const noneCell = screen.getByTestId(`device-${noVpnBox.id}-vpn`);
    expect(within(noneCell).queryByTestId(`device-${noVpnBox.id}-vpn-badge-tailscale`)).toBeNull();
    expect(noneCell.textContent).toContain('—');
  });

  it('caps badges at 2 and shows a +N overflow indicator', () => {
    render(<DeviceList devices={[multiVpnBox]} pageSize={50} />);

    const cell = screen.getByTestId(`device-${multiVpnBox.id}-vpn`);
    // Sorted by label: OpenVPN, WireGuard shown; ZeroTier overflows.
    expect(within(cell).getByTestId(`device-${multiVpnBox.id}-vpn-badge-openvpn`)).toBeTruthy();
    expect(within(cell).getByTestId(`device-${multiVpnBox.id}-vpn-badge-wireguard`)).toBeTruthy();
    expect(within(cell).queryByTestId(`device-${multiVpnBox.id}-vpn-badge-zerotier`)).toBeNull();
    expect(within(cell).getByTestId(`device-${multiVpnBox.id}-vpn-overflow`).textContent).toBe('+1');
  });

  it('facet "any active VPN" hides devices without a VPN', () => {
    render(<DeviceList devices={[tailscaleBox, noVpnBox]} pageSize={50} />);

    expect(screen.getByText('ts-box')).toBeTruthy();
    expect(screen.getByText('plain-box')).toBeTruthy();

    fireEvent.change(screen.getByTestId('device-vpn-filter'), { target: { value: 'any' } });

    expect(screen.getByText('ts-box')).toBeTruthy();
    expect(screen.queryByText('plain-box')).toBeNull();
  });

  it('facet by-provider shows only devices running that provider', () => {
    render(<DeviceList devices={[tailscaleBox, multiVpnBox, noVpnBox]} pageSize={50} />);

    fireEvent.change(screen.getByTestId('device-vpn-filter'), { target: { value: 'wireguard' } });

    expect(screen.getByText('multi-box')).toBeTruthy();
    expect(screen.queryByText('ts-box')).toBeNull();
    expect(screen.queryByText('plain-box')).toBeNull();
  });
});
