import { fireEvent, render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import DeviceList, { type Device } from './DeviceList';
import {
  COLUMN_LABELS,
  DEFAULT_VISIBLE_COLUMNS,
  writeColumnVisibility,
} from './columnVisibility';

// Optional WAN IP / LAN IP columns (#2503). Both render straight from cached
// values already on the Device row — no per-row fetch, no live agent command.

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn(), registerOrgIdProvider: vi.fn() }));
// Fleet view so the fleet-only Organization column stays available (see
// DeviceList isColumnAvailable).
vi.mock('@/stores/orgStore', () => ({
  useOrgStore: (selector: (s: { currentOrgId: string | null; allOrgs: boolean }) => unknown) =>
    selector({ currentOrgId: null, allOrgs: true }),
}));
vi.mock('../remote/ConnectDesktopButton', () => ({ default: () => null }));
vi.mock('@/lib/formatTime', () => ({ formatLastSeen: () => 'just now' }));

function device(id: string, hostname: string, overrides: Partial<Device> = {}): Device {
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
    ...overrides,
  };
}

// Documentation-range addresses only (RFC 5737 / RFC 1918) so no real
// infrastructure is implied by the fixtures.
const bothIps = device('11111111-1111-1111-1111-111111111111', 'ip-box', {
  wanIp: '198.51.100.24',
  lanIp: '192.168.1.10',
});
const noIps = device('22222222-2222-2222-2222-222222222222', 'blank-box', {
  wanIp: null,
  lanIp: null,
});
const networkAsset = device('33333333-3333-3333-3333-333333333333', 'printer-01', {
  deviceClass: 'network',
  assetType: 'printer',
  // wanIp is deliberately NON-null even though the API always sends null for a
  // discovered asset: the dash has to come from the device-class gate, not
  // from an empty value. With `wanIp: null` here both branches of
  // `agentCell(device, device.wanIp || dash)` render a dash and deleting the
  // gate would leave the test green.
  wanIp: '198.51.100.99',
  lanIp: '192.168.1.55',
});

function seedColumns() {
  writeColumnVisibility([...DEFAULT_VISIBLE_COLUMNS, 'wanIp', 'lanIp']);
}

describe('DeviceList — WAN/LAN IP columns (#2503)', () => {
  beforeEach(seedColumns);
  afterEach(() => window.localStorage.clear());

  it('renders both addresses when present', () => {
    render(<DeviceList devices={[bothIps]} pageSize={50} />);

    expect(screen.getByTestId(`device-${bothIps.id}-wan-ip`).textContent).toBe('198.51.100.24');
    expect(screen.getByTestId(`device-${bothIps.id}-lan-ip`).textContent).toBe('192.168.1.10');
  });

  it('renders a dash rather than a blank cell when an address is unknown', () => {
    render(<DeviceList devices={[noIps]} pageSize={50} />);

    expect(screen.getByTestId(`device-${noIps.id}-wan-ip`).textContent).toContain('—');
    expect(screen.getByTestId(`device-${noIps.id}-lan-ip`).textContent).toContain('—');
  });

  it('dashes WAN IP for network-discovered rows but still shows their LAN IP', () => {
    render(<DeviceList devices={[networkAsset]} pageSize={50} />);

    // A printer/switch never authenticates to the control plane, so there is
    // no source address to report — but its discovered IP is a real LAN IP.
    expect(screen.getByTestId(`device-${networkAsset.id}-wan-ip`).textContent).toContain('—');
    expect(screen.getByTestId(`device-${networkAsset.id}-lan-ip`).textContent).toBe('192.168.1.55');
  });

  it('is hidden by default and appears only once opted in', () => {
    window.localStorage.clear();
    const { unmount } = render(<DeviceList devices={[bothIps]} pageSize={50} />);
    expect(screen.queryByTestId(`device-${bothIps.id}-wan-ip`)).toBeNull();
    expect(screen.queryByTestId(`device-${bothIps.id}-lan-ip`)).toBeNull();
    unmount();

    seedColumns();
    render(<DeviceList devices={[bothIps]} pageSize={50} />);
    expect(screen.getByTestId(`device-${bothIps.id}-wan-ip`)).not.toBeNull();
    expect(screen.getByTestId(`device-${bothIps.id}-lan-ip`)).not.toBeNull();
  });

  it('sorts dotted-quads numerically and keeps unknown addresses last in both directions', () => {
    // .9 before .10 is the case a plain lexicographic string sort gets wrong.
    const low = device('44444444-4444-4444-4444-444444444444', 'low', { lanIp: '192.168.1.9' });
    const high = device('55555555-5555-5555-5555-555555555555', 'high', { lanIp: '192.168.1.10' });
    render(<DeviceList devices={[high, noIps, low]} pageSize={50} />);

    const header = screen.getByTitle('Sort by LAN IP');
    const lanIps = () =>
      screen
        .getAllByTestId(/-lan-ip$/)
        .map((cell) => cell.textContent);

    fireEvent.click(header);
    expect(lanIps()).toEqual(['192.168.1.9', '192.168.1.10', '—']);

    fireEvent.click(header);
    expect(lanIps()).toEqual(['192.168.1.10', '192.168.1.9', '—']);
  });

  it('sorts WAN IP too, keeping network rows blanks-last in both directions', () => {
    // Network rows carry no WAN address by construction, so they are the
    // permanent blanks in this column and must never bury the agent rows.
    const low = device('66666666-6666-6666-6666-666666666666', 'low-wan', {
      wanIp: '198.51.100.9',
    });
    const high = device('77777777-7777-7777-7777-777777777777', 'high-wan', {
      wanIp: '198.51.100.10',
    });
    const printer = device('88888888-8888-8888-8888-888888888888', 'printer-02', {
      deviceClass: 'network',
      assetType: 'printer',
      wanIp: null,
    });
    render(<DeviceList devices={[high, printer, low]} pageSize={50} />);

    const header = screen.getByTitle('Sort by WAN IP');
    const wanIps = () => screen.getAllByTestId(/-wan-ip$/).map((cell) => cell.textContent);

    fireEvent.click(header);
    expect(wanIps()).toEqual(['198.51.100.9', '198.51.100.10', '—']);

    fireEvent.click(header);
    expect(wanIps()).toEqual(['198.51.100.10', '198.51.100.9', '—']);
  });

  it('exposes both columns in the picker catalog under their display labels', () => {
    expect(COLUMN_LABELS.wanIp).toBe('WAN IP');
    expect(COLUMN_LABELS.lanIp).toBe('LAN IP');
    expect(DEFAULT_VISIBLE_COLUMNS).not.toContain('wanIp');
    expect(DEFAULT_VISIBLE_COLUMNS).not.toContain('lanIp');
  });
});
