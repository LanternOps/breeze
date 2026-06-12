import { fireEvent, render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import DeviceList, { type Device } from './DeviceList';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));
vi.mock('../remote/ConnectDesktopButton', () => ({
  default: () => null,
}));
vi.mock('@/lib/formatTime', () => ({
  formatLastSeen: () => 'just now',
}));

const baseDevice: Device = {
  id: '11111111-1111-1111-1111-111111111111',
  hostname: 'host-a',
  os: 'windows',
  osVersion: '11',
  status: 'online',
  cpuPercent: 10,
  ramPercent: 20,
  lastSeen: new Date().toISOString(),
  orgId: 'org-1',
  orgName: 'Acme',
  siteId: 'site-1',
  siteName: 'HQ',
  agentVersion: '0.67.0',
  tags: [],
};

describe('DeviceList — agent-silent (watchdog OK) badge (#800 web-UI gap)', () => {
  it('renders the amber badge when mainAgentSilentSince is set AND watchdog is reporting', () => {
    const device: Device = {
      ...baseDevice,
      id: '22222222-2222-2222-2222-222222222222',
      hostname: 'host-silent-but-watchdog-ok',
      mainAgentSilentSince: new Date(Date.now() - 17 * 60_000).toISOString(),
      watchdogStatus: 'connected',
    };

    render(<DeviceList devices={[device]} />);

    const badge = screen.getByTestId(`device-${device.id}-agent-silent-badge`);
    expect(badge.textContent).toMatch(/Agent silent/i);
    // 17 minutes ago should render as "17m" (not "0h" or "1d")
    expect(badge.textContent).toMatch(/17m/);
  });

  it('does NOT render the badge when the watchdog is also offline (we trust device.status=offline instead)', () => {
    const device: Device = {
      ...baseDevice,
      id: '33333333-3333-3333-3333-333333333333',
      hostname: 'host-fully-offline',
      status: 'offline',
      mainAgentSilentSince: new Date(Date.now() - 60 * 60_000).toISOString(),
      watchdogStatus: 'offline',
    };

    render(<DeviceList devices={[device]} />);

    expect(screen.queryByTestId(`device-${device.id}-agent-silent-badge`)).toBeNull();
  });

  it('does NOT render the badge when the agent is heartbeating normally (mainAgentSilentSince null)', () => {
    const device: Device = {
      ...baseDevice,
      id: '44444444-4444-4444-4444-444444444444',
      hostname: 'host-healthy',
      mainAgentSilentSince: null,
      watchdogStatus: 'connected',
    };

    render(<DeviceList devices={[device]} />);

    expect(screen.queryByTestId(`device-${device.id}-agent-silent-badge`)).toBeNull();
  });

  it('still renders when watchdog reports FAILOVER (watchdog has taken over the heartbeat)', () => {
    const device: Device = {
      ...baseDevice,
      id: '55555555-5555-5555-5555-555555555555',
      hostname: 'host-failover',
      mainAgentSilentSince: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
      watchdogStatus: 'failover',
    };

    render(<DeviceList devices={[device]} />);

    const badge = screen.getByTestId(`device-${device.id}-agent-silent-badge`);
    // 2h should render as "2h"
    expect(badge.textContent).toMatch(/2h/);
  });

  it('keeps the badge on a single line so it renders as a pill, not a circle (#1013)', () => {
    const device: Device = {
      ...baseDevice,
      id: '66666666-6666-6666-6666-666666666666',
      hostname: 'host-narrow-column',
      mainAgentSilentSince: new Date(Date.now() - 12 * 24 * 3600 * 1000).toISOString(),
      watchdogStatus: 'connected',
    };

    render(<DeviceList devices={[device]} />);

    const badge = screen.getByTestId(`device-${device.id}-agent-silent-badge`);
    // Without whitespace-nowrap the text wraps to multiple lines and rounded-full
    // renders the box as a circular blob instead of a pill.
    expect(badge.className).toContain('whitespace-nowrap');
  });
});

describe('DeviceList — row action menu (#1013 clipping fix)', () => {
  it('renders the action menu in a portal outside the overflow-x-auto table wrapper so it is not clipped', () => {
    const device: Device = {
      ...baseDevice,
      id: '77777777-7777-7777-7777-777777777777',
      hostname: 'host-menu',
    };

    const { container } = render(<DeviceList devices={[device]} />);

    fireEvent.click(screen.getByLabelText('Device actions'));

    const menuItem = screen.getByText('Remote Terminal');
    // The scroll container that was clipping the dropdown.
    const scrollWrapper = container.querySelector('.overflow-x-auto');
    expect(scrollWrapper).not.toBeNull();
    // The menu must live OUTSIDE that wrapper (portaled to body) so overflow can't clip it.
    expect(scrollWrapper?.contains(menuItem)).toBe(false);
  });
});

describe('DeviceList — advanced filter via serverFilterIds prop (uncapped id set)', () => {
  it('renders only devices in the id set and shows the active-filter pill', () => {
    const inFilter: Device = {
      ...baseDevice,
      id: '88888888-8888-8888-8888-888888888888',
      hostname: 'host-in-filter',
    };
    const outOfFilter: Device = {
      ...baseDevice,
      id: '99999999-9999-9999-9999-999999999999',
      hostname: 'host-not-in-filter',
    };

    render(
      <DeviceList
        devices={[inFilter, outOfFilter]}
        serverFilterIds={new Set([inFilter.id])}
      />
    );

    expect(screen.getByText('host-in-filter')).toBeTruthy();
    expect(screen.queryByText('host-not-in-filter')).toBeNull();
    expect(screen.getByText(/Advanced filter active/i)).toBeTruthy();
  });

  it('shows every device (no pill) when serverFilterIds is null — no advanced filter active', () => {
    const a: Device = { ...baseDevice, id: 'aaaaaaa1-0000-0000-0000-000000000000', hostname: 'host-aa' };
    const b: Device = { ...baseDevice, id: 'aaaaaaa2-0000-0000-0000-000000000000', hostname: 'host-bb' };

    render(<DeviceList devices={[a, b]} serverFilterIds={null} />);

    expect(screen.getByText('host-aa')).toBeTruthy();
    expect(screen.getByText('host-bb')).toBeTruthy();
    expect(screen.queryByText(/Advanced filter active/i)).toBeNull();
  });
});

describe('DeviceList — sortable columns (every column sorts on header click)', () => {
  // Hostnames of rendered rows, in DOM order. Each fixture uses a unique
  // hostname so order assertions read naturally.
  const rowOrder = (container: HTMLElement) =>
    Array.from(container.querySelectorAll('tbody tr td:nth-child(2) span')).map(el => el.textContent);

  const clickHeader = (title: string) => fireEvent.click(screen.getByTitle(title));

  // jsdom in this setup exposes no window.localStorage; install the same
  // in-memory stub columnVisibility.test.ts uses so column prefs read/write.
  beforeEach(() => {
    const data = new Map<string, string>();
    Object.defineProperty(window, 'localStorage', {
      value: {
        get length() {
          return data.size;
        },
        clear: () => data.clear(),
        getItem: (key: string) => data.get(key) ?? null,
        setItem: (key: string, value: string) => void data.set(key, String(value)),
        removeItem: (key: string) => void data.delete(key),
        key: (i: number) => Array.from(data.keys())[i] ?? null,
      },
      writable: true,
      configurable: true,
    });
  });

  it('sorts a previously-unsortable column (Organization) alphabetically and toggles direction on second click', () => {
    const devices: Device[] = [
      { ...baseDevice, id: 'a1a1a1a1-0000-0000-0000-000000000001', hostname: 'host-zeta', orgName: 'Zeta Corp' },
      { ...baseDevice, id: 'a1a1a1a1-0000-0000-0000-000000000002', hostname: 'host-acme', orgName: 'Acme' },
      { ...baseDevice, id: 'a1a1a1a1-0000-0000-0000-000000000003', hostname: 'host-mid', orgName: 'Midway' },
    ];

    const { container } = render(<DeviceList devices={devices} />);

    clickHeader('Sort by organization');
    expect(rowOrder(container)).toEqual(['host-acme', 'host-mid', 'host-zeta']);

    clickHeader('Sort by organization');
    expect(rowOrder(container)).toEqual(['host-zeta', 'host-mid', 'host-acme']);
  });

  it('sorts hostnames with numeric collation (host-2 before host-10)', () => {
    const devices: Device[] = [
      { ...baseDevice, id: 'b1b1b1b1-0000-0000-0000-000000000001', hostname: 'host-10' },
      { ...baseDevice, id: 'b1b1b1b1-0000-0000-0000-000000000002', hostname: 'host-2' },
    ];

    const { container } = render(<DeviceList devices={devices} />);

    clickHeader('Sort by hostname');
    expect(rowOrder(container)).toEqual(['host-2', 'host-10']);
  });

  it('sorts status by operational rank (online → maintenance → offline), not enum alphabetics', () => {
    const devices: Device[] = [
      { ...baseDevice, id: 'c1c1c1c1-0000-0000-0000-000000000001', hostname: 'host-off', status: 'offline' },
      { ...baseDevice, id: 'c1c1c1c1-0000-0000-0000-000000000002', hostname: 'host-on', status: 'online' },
      { ...baseDevice, id: 'c1c1c1c1-0000-0000-0000-000000000003', hostname: 'host-maint', status: 'maintenance' },
    ];

    const { container } = render(<DeviceList devices={devices} />);

    clickHeader('Sort by status');
    expect(rowOrder(container)).toEqual(['host-on', 'host-maint', 'host-off']);
  });

  it('keeps dash cells last in BOTH directions (offline device has no CPU reading)', () => {
    const devices: Device[] = [
      { ...baseDevice, id: 'd1d1d1d1-0000-0000-0000-000000000001', hostname: 'host-no-cpu', status: 'offline', cpuPercent: 0 },
      { ...baseDevice, id: 'd1d1d1d1-0000-0000-0000-000000000002', hostname: 'host-busy', cpuPercent: 90 },
      { ...baseDevice, id: 'd1d1d1d1-0000-0000-0000-000000000003', hostname: 'host-idle', cpuPercent: 5 },
    ];

    const { container } = render(<DeviceList devices={devices} />);

    clickHeader('Sort by CPU usage');
    expect(rowOrder(container)).toEqual(['host-idle', 'host-busy', 'host-no-cpu']);

    clickHeader('Sort by CPU usage');
    expect(rowOrder(container)).toEqual(['host-busy', 'host-idle', 'host-no-cpu']);
  });

  it('sorts agent versions numerically aware (0.9.0 before 0.10.0) on an opted-in column', () => {
    // agentVersion is not in DEFAULT_VISIBLE_COLUMNS; opt it in via the same
    // versioned localStorage shape columnVisibility.ts persists.
    window.localStorage.setItem(
      'breeze.devices.columns',
      JSON.stringify({ v: 1, columns: [{ id: 'agentVersion', visible: true }] }),
    );
    const devices: Device[] = [
      { ...baseDevice, id: 'e1e1e1e1-0000-0000-0000-000000000001', hostname: 'host-ten', agentVersion: '0.10.0' },
      { ...baseDevice, id: 'e1e1e1e1-0000-0000-0000-000000000002', hostname: 'host-nine', agentVersion: '0.9.0' },
    ];

    const { container } = render(<DeviceList devices={devices} />);

    clickHeader('Sort by agent version');
    // agentVersion was stored first, so it renders as the first data column.
    const hostCol = Array.from(container.querySelectorAll('tbody tr td:nth-child(3) span')).map(el => el.textContent);
    expect(hostCol).toEqual(['host-nine', 'host-ten']);
  });

  it('renders every rendered column header as sortable (clickable with a sort hint)', () => {
    const { container } = render(<DeviceList devices={[baseDevice]} />);

    const headers = Array.from(container.querySelectorAll('thead th'));
    // First (checkbox) and last (Actions) are structural; everything between
    // must carry a "Sort by ..." hint wired to handleSort.
    const dataHeaders = headers.slice(1, -1);
    expect(dataHeaders.length).toBeGreaterThan(0);
    for (const th of dataHeaders) {
      expect(th.getAttribute('title')).toMatch(/^Sort by /);
      expect(th.className).toContain('cursor-pointer');
    }
  });
});

describe('DeviceList — pending reboot badge', () => {
  it('renders the amber badge when pendingReboot is true', () => {
    const device: Device = {
      ...baseDevice,
      id: '33333333-3333-3333-3333-333333333333',
      hostname: 'host-needs-reboot',
      pendingReboot: true,
    };

    render(<DeviceList devices={[device]} />);

    const badge = screen.getByTestId(`device-${device.id}-pending-reboot-badge`);
    expect(badge.textContent).toMatch(/Reboot pending/i);
  });

  it('renders no badge when pendingReboot is false or absent', () => {
    const explicitFalse: Device = {
      ...baseDevice,
      id: '44444444-4444-4444-4444-444444444444',
      pendingReboot: false,
    };

    render(<DeviceList devices={[explicitFalse, baseDevice]} />);

    expect(screen.queryByTestId(`device-${explicitFalse.id}-pending-reboot-badge`)).toBeNull();
    expect(screen.queryByTestId(`device-${baseDevice.id}-pending-reboot-badge`)).toBeNull();
  });
});
