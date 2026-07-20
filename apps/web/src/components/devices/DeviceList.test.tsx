import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import DeviceList, { type Device } from './DeviceList';
import { COLUMN_IDS } from './columnVisibility';
import {
  DECOMMISSION_BLOCKED_BULK_ACTIONS,
  INTENTIONALLY_UNGATED_BULK_ACTIONS,
} from './bulkActionGating';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  registerOrgIdProvider: vi.fn(),
}));
// Fleet view by default so the Organization column (fleet-only) is available
// to the column/sort tests; individual tests flip this to org scope.
const orgScopeState = { currentOrgId: null as string | null, allOrgs: true };
vi.mock('@/stores/orgStore', () => ({
  useOrgStore: (selector: (s: typeof orgScopeState) => unknown) => selector(orgScopeState),
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

describe('DeviceList — OS version display', () => {
  beforeEach(() => {
    window.localStorage?.clear();
  });

  it('shows macOS instead of the Darwin kernel name in the OS Version column', () => {
    const device: Device = {
      ...baseDevice,
      os: 'macos',
      osVersion: 'darwin 26.5.1',
    };

    render(<DeviceList devices={[device]} />);
    fireEvent.click(screen.getByRole('button', { name: /columns/i }));
    fireEvent.click(screen.getByLabelText('OS Version'));

    expect(screen.getByText('macOS 26.5.1')).toBeInTheDocument();
    expect(screen.queryByText('darwin 26.5.1')).toBeNull();
  });

  it('capitalizes Linux distro names in the OS Version column', () => {
    const device: Device = {
      ...baseDevice,
      os: 'linux',
      osVersion: 'raspbian 13.5',
    };

    render(<DeviceList devices={[device]} />);
    fireEvent.click(screen.getByRole('button', { name: /columns/i }));
    fireEvent.click(screen.getByLabelText('OS Version'));

    expect(screen.getByText('Raspbian 13.5')).toBeInTheDocument();
    expect(screen.queryByText('raspbian 13.5')).toBeNull();
  });
});

describe('DeviceList — Power column (#2142)', () => {
  beforeEach(() => {
    window.localStorage?.clear();
  });

  const enablePower = () => {
    fireEvent.click(screen.getByRole('button', { name: /columns/i }));
    fireEvent.click(screen.getByLabelText('Power'));
  };

  it('shows battery percentage for devices with a battery', () => {
    const device: Device = {
      ...baseDevice,
      batteryStatus: { present: true, percent: 85, chargingState: 'discharging', pluggedIn: false, reportedAt: new Date().toISOString() },
    };
    render(<DeviceList devices={[device]} />);
    enablePower();
    expect(screen.getByTestId(`device-${device.id}-power`)).toHaveTextContent('85%');
  });

  it('renders a dash for a no-battery desktop', () => {
    const device: Device = {
      ...baseDevice,
      batteryStatus: { present: false, pluggedIn: true, reportedAt: new Date().toISOString() },
    };
    render(<DeviceList devices={[device]} />);
    enablePower();
    const cell = screen.getByTestId(`device-${device.id}-power`);
    expect(cell).toHaveTextContent('—');
    expect(cell).not.toHaveTextContent('%');
  });

  it('renders a dash when no battery data has been reported', () => {
    render(<DeviceList devices={[baseDevice]} />);
    enablePower();
    expect(screen.getByTestId(`device-${baseDevice.id}-power`)).toHaveTextContent('—');
  });

  it('flags a low, discharging battery with a destructive style and a detail tooltip', () => {
    const device: Device = {
      ...baseDevice,
      batteryStatus: { present: true, percent: 15, chargingState: 'discharging', pluggedIn: false, timeRemainingMinutes: 42, reportedAt: new Date().toISOString() },
    };
    render(<DeviceList devices={[device]} />);
    enablePower();
    const cell = screen.getByTestId(`device-${device.id}-power`);
    expect(cell).toHaveTextContent('15%');
    // Low state is styled destructive.
    expect(cell.querySelector('.text-destructive')).not.toBeNull();
    // Tooltip carries the human-readable detail.
    const title = cell.getAttribute('title') ?? '';
    expect(title).toContain('On battery');
    expect(title).toContain('remaining');
  });

  it('does NOT flag a charging battery as low even at a low charge', () => {
    const device: Device = {
      ...baseDevice,
      batteryStatus: { present: true, percent: 15, chargingState: 'charging', pluggedIn: true, timeToFullMinutes: 90, reportedAt: new Date().toISOString() },
    };
    render(<DeviceList devices={[device]} />);
    enablePower();
    const cell = screen.getByTestId(`device-${device.id}-power`);
    expect(cell).toHaveTextContent('15%');
    // Charging → not a low-battery alert; success accent instead of destructive.
    expect(cell.querySelector('.text-destructive')).toBeNull();
    expect(cell.querySelector('.text-success')).not.toBeNull();
    expect(cell.getAttribute('title') ?? '').toContain('Charging');
  });

  it('falls back to the charging-state label when percent is unavailable', () => {
    const device: Device = {
      ...baseDevice,
      batteryStatus: { present: true, chargingState: 'charging', pluggedIn: true, reportedAt: new Date().toISOString() },
    };
    render(<DeviceList devices={[device]} />);
    enablePower();
    const cell = screen.getByTestId(`device-${device.id}-power`);
    expect(cell).toHaveTextContent('Charging');
    expect(cell).not.toHaveTextContent('%');
  });
});

describe('DeviceList — Device column display names', () => {
  beforeEach(() => {
    window.localStorage?.clear();
  });

  it('shows display name as the primary device label and hostname as secondary text', () => {
    render(<DeviceList devices={[{ ...baseDevice, displayName: 'Reception Laptop' }]} />);

    expect(screen.getByText('Device')).toBeInTheDocument();
    expect(screen.getByText('Reception Laptop')).toBeInTheDocument();
    expect(screen.getByText('host-a')).toBeInTheDocument();
  });

  it('falls back to hostname when display name is not set', () => {
    render(<DeviceList devices={[baseDevice]} />);

    expect(screen.getByText('host-a')).toBeInTheDocument();
  });

  it('matches the quick search against display name as well as hostname', () => {
    const displayNamedDevice: Device = {
      ...baseDevice,
      id: '12121212-1212-1212-1212-121212121212',
      hostname: 'host-alpha',
      displayName: 'Reception Laptop',
    };
    const hostnameOnlyDevice: Device = {
      ...baseDevice,
      id: '34343434-3434-3434-3434-343434343434',
      hostname: 'host-beta',
    };

    const { rerender } = render(
      <DeviceList
        devices={[displayNamedDevice, hostnameOnlyDevice]}
        listFilters={{ search: 'reception' }}
      />
    );

    expect(screen.getByText('Reception Laptop')).toBeInTheDocument();
    expect(screen.queryByText('host-beta')).toBeNull();

    rerender(
      <DeviceList
        devices={[displayNamedDevice, hostnameOnlyDevice]}
        listFilters={{ search: 'host-beta' }}
      />
    );

    expect(screen.getByText('host-beta')).toBeInTheDocument();
    expect(screen.queryByText('Reception Laptop')).toBeNull();
  });
});

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

  // Install a fresh in-memory localStorage per test (same stub shape as
  // columnVisibility.test.ts). The point is isolation: jsdom's storage
  // persists across tests within a file, so a column-visibility write in
  // one test (e.g. the agentVersion opt-in below) would leak into later
  // tests. afterEach restores whatever the environment had, so describe
  // blocks running after this one keep exercising the real fallback path.
  let originalLocalStorage: PropertyDescriptor | undefined;
  beforeEach(() => {
    originalLocalStorage = Object.getOwnPropertyDescriptor(window, 'localStorage');
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

  afterEach(() => {
    if (originalLocalStorage) {
      Object.defineProperty(window, 'localStorage', originalLocalStorage);
    } else {
      Reflect.deleteProperty(window, 'localStorage');
    }
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

  it('hides the Organization column entirely in single-org scope (it would repeat the header org)', () => {
    orgScopeState.currentOrgId = 'org-1';
    orgScopeState.allOrgs = false;
    try {
      render(<DeviceList devices={[baseDevice]} />);
      expect(screen.queryByTitle('Sort by organization')).toBeNull();
      expect(screen.queryByText('Acme')).toBeNull();
    } finally {
      orgScopeState.currentOrgId = null;
      orgScopeState.allOrgs = true;
    }
  });

  it('sorts devices with numeric collation (host-2 before host-10)', () => {
    const devices: Device[] = [
      { ...baseDevice, id: 'b1b1b1b1-0000-0000-0000-000000000001', hostname: 'host-10' },
      { ...baseDevice, id: 'b1b1b1b1-0000-0000-0000-000000000002', hostname: 'host-2' },
    ];

    const { container } = render(<DeviceList devices={devices} />);

    clickHeader('Sort by device');
    expect(rowOrder(container)).toEqual(['host-2', 'host-10']);
  });

  it('sorts status by operational rank, not enum alphabetics, across every co-renderable status', () => {
    // All statuses except decommissioned, which can never co-render with the
    // others (the default "all" filter hides it; selecting it shows only it),
    // so its rank entry is untestable through the rendered table. A dropped
    // statusSortRank entry for any of these six would produce NaN comparisons
    // and scramble this expected order.
    const devices: Device[] = [
      { ...baseDevice, id: 'c1c1c1c1-0000-0000-0000-000000000001', hostname: 'host-off', status: 'offline' },
      { ...baseDevice, id: 'c1c1c1c1-0000-0000-0000-000000000002', hostname: 'host-quar', status: 'quarantined' },
      { ...baseDevice, id: 'c1c1c1c1-0000-0000-0000-000000000003', hostname: 'host-on', status: 'online' },
      { ...baseDevice, id: 'c1c1c1c1-0000-0000-0000-000000000004', hostname: 'host-pend', status: 'pending' },
      { ...baseDevice, id: 'c1c1c1c1-0000-0000-0000-000000000005', hostname: 'host-maint', status: 'maintenance' },
      { ...baseDevice, id: 'c1c1c1c1-0000-0000-0000-000000000006', hostname: 'host-upd', status: 'updating' },
    ];

    const { container } = render(<DeviceList devices={devices} />);

    clickHeader('Sort by status');
    expect(rowOrder(container)).toEqual(['host-on', 'host-upd', 'host-pend', 'host-maint', 'host-quar', 'host-off']);
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

  it('renders every catalog column with a sort hint and pointer cursor when every column is visible', () => {
    // Default visibility shows only a handful of columns, which would let the
    // others silently regress to plain <th> elements. Opt every catalog column
    // in — including the network-only Class/Type columns, which only render
    // when the network arm is enabled (networkDevicesEnabled).
    window.localStorage.setItem(
      'breeze.devices.columns',
      JSON.stringify({ v: 1, columns: COLUMN_IDS.map(id => ({ id, visible: true })) }),
    );

    const { container } = render(<DeviceList devices={[baseDevice]} networkDevicesEnabled />);

    const headers = Array.from(container.querySelectorAll('thead th'));
    // First (checkbox) and last (Actions) are structural; everything between
    // must carry the "Sort by ..." hint and the clickable styling. (The
    // click-actually-reorders behavior is covered by the row-order tests.)
    const dataHeaders = headers.slice(1, -1);
    expect(dataHeaders.length).toBe(COLUMN_IDS.length);
    for (const th of dataHeaders) {
      expect(th.getAttribute('title')).toMatch(/^Sort by /);
      expect(th.className).toContain('cursor-pointer');
    }
  });

  it('reflects sort state via aria-sort on the active header (a11y parity with Patches)', () => {
    const devices: Device[] = [
      { ...baseDevice, id: 'a1a1a1a1-0000-0000-0000-0000000000a1', hostname: 'host-b' },
      { ...baseDevice, id: 'a1a1a1a1-0000-0000-0000-0000000000a2', hostname: 'host-a' },
    ];
    render(<DeviceList devices={devices} />);

    const hostHeader = screen.getByTitle('Sort by device');
    const osHeader = screen.getByTitle('Sort by operating system');
    // Unsorted: every header advertises aria-sort="none".
    expect(hostHeader.getAttribute('aria-sort')).toBe('none');
    expect(osHeader.getAttribute('aria-sort')).toBe('none');

    fireEvent.click(hostHeader);
    expect(hostHeader.getAttribute('aria-sort')).toBe('ascending');
    expect(osHeader.getAttribute('aria-sort')).toBe('none');

    fireEvent.click(hostHeader);
    expect(hostHeader.getAttribute('aria-sort')).toBe('descending');
  });

  // Seeds hostname first (keeps the rowOrder helper's td:nth-child(2) valid)
  // plus the named extra column, so default-hidden columns can be sorted.
  const seedColumns = (...extra: string[]) =>
    window.localStorage.setItem(
      'breeze.devices.columns',
      JSON.stringify({ v: 1, columns: ['hostname', ...extra].map(id => ({ id, visible: true })) }),
    );

  it('renders watchdog version as an opt-in column and shows N/A for missing reports', () => {
    seedColumns('watchdogVersion');
    const devices: Device[] = [
      { ...baseDevice, id: 'e2e2e2e2-0000-0000-0000-000000000001', hostname: 'host-watchdog', watchdogVersion: '0.70.1' },
      { ...baseDevice, id: 'e2e2e2e2-0000-0000-0000-000000000002', hostname: 'host-no-watchdog', watchdogVersion: null },
    ];

    render(<DeviceList devices={devices} />);

    expect(screen.getByText('0.70.1')).toBeInTheDocument();
    expect(screen.getByText('N/A')).toBeInTheDocument();
  });

  it('sorts watchdog versions numerically aware (0.9.0 before 0.10.0) with missing reports last in both directions', () => {
    // Three rows — two real versions plus a null — so the asc/desc assertions
    // actually exercise the direction multiplier (a two-row dataset where one
    // is null only ever proves the nulls-last short-circuit). Mirrors the
    // agentVersion and tags sort tests above.
    seedColumns('watchdogVersion');
    const devices: Device[] = [
      { ...baseDevice, id: 'e2e2e2e2-0000-0000-0000-000000000001', hostname: 'host-ten', watchdogVersion: '0.10.0' },
      { ...baseDevice, id: 'e2e2e2e2-0000-0000-0000-000000000002', hostname: 'host-nine', watchdogVersion: '0.9.0' },
      { ...baseDevice, id: 'e2e2e2e2-0000-0000-0000-000000000003', hostname: 'host-none', watchdogVersion: null },
    ];

    const { container } = render(<DeviceList devices={devices} />);

    clickHeader('Sort by watchdog version');
    expect(rowOrder(container)).toEqual(['host-nine', 'host-ten', 'host-none']);

    clickHeader('Sort by watchdog version');
    expect(rowOrder(container)).toEqual(['host-ten', 'host-nine', 'host-none']);
  });

  it('sorts tags by the joined displayed list with untagged rows last in both directions', () => {
    seedColumns('tags');
    const devices: Device[] = [
      { ...baseDevice, id: 'f1f1f1f1-0000-0000-0000-000000000001', hostname: 'host-zulu', tags: ['zulu'] },
      { ...baseDevice, id: 'f1f1f1f1-0000-0000-0000-000000000002', hostname: 'host-untagged', tags: [] },
      { ...baseDevice, id: 'f1f1f1f1-0000-0000-0000-000000000003', hostname: 'host-alpha', tags: ['alpha', 'beta'] },
    ];

    const { container } = render(<DeviceList devices={devices} />);

    clickHeader('Sort by tags');
    expect(rowOrder(container)).toEqual(['host-alpha', 'host-zulu', 'host-untagged']);

    clickHeader('Sort by tags');
    expect(rowOrder(container)).toEqual(['host-zulu', 'host-alpha', 'host-untagged']);
  });

  it('sorts uptime only for online devices — a non-online device with uptimeSeconds renders a dash and sorts last', () => {
    seedColumns('uptime');
    const devices: Device[] = [
      { ...baseDevice, id: 'a2a2a2a2-0000-0000-0000-000000000001', hostname: 'host-offline-stale', status: 'offline', uptimeSeconds: 999_999 },
      { ...baseDevice, id: 'a2a2a2a2-0000-0000-0000-000000000002', hostname: 'host-long-up', uptimeSeconds: 50_000 },
      { ...baseDevice, id: 'a2a2a2a2-0000-0000-0000-000000000003', hostname: 'host-fresh-boot', uptimeSeconds: 100 },
    ];

    const { container } = render(<DeviceList devices={devices} />);

    clickHeader('Sort by uptime');
    expect(rowOrder(container)).toEqual(['host-fresh-boot', 'host-long-up', 'host-offline-stale']);
  });

  it('treats pendingReboot false/absent as a dash cell: sorts last in both directions, true rows first', () => {
    seedColumns('pendingReboot');
    const devices: Device[] = [
      { ...baseDevice, id: 'b2b2b2b2-0000-0000-0000-000000000001', hostname: 'host-clean', pendingReboot: false },
      { ...baseDevice, id: 'b2b2b2b2-0000-0000-0000-000000000002', hostname: 'host-needs-reboot', pendingReboot: true },
      { ...baseDevice, id: 'b2b2b2b2-0000-0000-0000-000000000003', hostname: 'host-old-agent' },
    ];

    const { container } = render(<DeviceList devices={devices} />);

    clickHeader('Sort by pending reboot');
    expect(rowOrder(container)).toEqual(['host-needs-reboot', 'host-clean', 'host-old-agent']);

    clickHeader('Sort by pending reboot');
    expect(rowOrder(container)).toEqual(['host-needs-reboot', 'host-clean', 'host-old-agent']);
  });

  it('renders the reliability score as an opt-in badge column; devices with no score show a dash (#1720)', () => {
    seedColumns('reliability');
    const devices: Device[] = [
      { ...baseDevice, id: 'c3c3c3c3-0000-0000-0000-000000000001', hostname: 'host-scored', reliabilityScore: 73 },
      { ...baseDevice, id: 'c3c3c3c3-0000-0000-0000-000000000002', hostname: 'host-unscored', reliabilityScore: null },
    ];

    render(<DeviceList devices={devices} />);

    const scored = screen.getByTestId('device-c3c3c3c3-0000-0000-0000-000000000001-reliability');
    expect(scored.textContent).toContain('73');
    const unscored = screen.getByTestId('device-c3c3c3c3-0000-0000-0000-000000000002-reliability');
    // Em-dash dash cell for the missing score — asserted exactly so a future
    // `score ?? 0` regression (which would render a bare "0") fails here.
    expect(unscored.textContent).toBe('—');
  });

  it('does not render a trend glyph for a scored device with no trend (#1720)', () => {
    seedColumns('reliability');
    const device: Device = {
      ...baseDevice,
      id: 'c6c6c6c6-0000-0000-0000-000000000001',
      hostname: 'host-notrend',
      reliabilityScore: 80,
      // reliabilityTrend intentionally absent.
    };

    render(<DeviceList devices={[device]} />);

    const cell = screen.getByTestId('device-c6c6c6c6-0000-0000-0000-000000000001-reliability');
    expect(cell.textContent).toBe('80');
    expect(screen.queryByLabelText('Improving')).toBeNull();
    expect(screen.queryByLabelText('Stable')).toBeNull();
    expect(screen.queryByLabelText('Degrading')).toBeNull();
  });

  // Pins the band-color ladder to DeviceReliabilityPanel.tsx scoreClass
  // (≤50 destructive / ≤70 warning / ≤85 info / else success). The boundary
  // values (50/51, 70/71, 85/86) are the ones a threshold typo would flip.
  it.each([
    [50, 'text-destructive'],
    [51, 'text-warning'],
    [70, 'text-warning'],
    [71, 'text-info'],
    [85, 'text-info'],
    [86, 'text-success'],
  ])('renders the %i reliability score in the %s band', (score, expectedClass) => {
    seedColumns('reliability');
    const device: Device = {
      ...baseDevice,
      id: 'c7c7c7c7-0000-0000-0000-000000000001',
      hostname: 'host-band',
      reliabilityScore: score,
    };

    render(<DeviceList devices={[device]} />);

    const badge = screen
      .getByTestId('device-c7c7c7c7-0000-0000-0000-000000000001-reliability')
      .querySelector('span');
    expect(badge?.className).toContain(expectedClass);
  });

  it('sorts reliability numerically with unscored devices last in both directions (#1720)', () => {
    seedColumns('reliability');
    const devices: Device[] = [
      { ...baseDevice, id: 'c4c4c4c4-0000-0000-0000-000000000001', hostname: 'host-high', reliabilityScore: 95 },
      { ...baseDevice, id: 'c4c4c4c4-0000-0000-0000-000000000002', hostname: 'host-low', reliabilityScore: 40 },
      { ...baseDevice, id: 'c4c4c4c4-0000-0000-0000-000000000003', hostname: 'host-unscored', reliabilityScore: null },
    ];

    const { container } = render(<DeviceList devices={devices} />);

    clickHeader('Sort by reliability score');
    expect(rowOrder(container)).toEqual(['host-low', 'host-high', 'host-unscored']);

    clickHeader('Sort by reliability score');
    expect(rowOrder(container)).toEqual(['host-high', 'host-low', 'host-unscored']);
  });

  it.each([
    ['improving', 'Improving', '↑'],
    ['stable', 'Stable', '→'],
    ['degrading', 'Degrading', '↓'],
  ] as const)('shows the %s trend glyph alongside the score (#1720)', (trend, label, glyph) => {
    seedColumns('reliability');
    const device: Device = {
      ...baseDevice,
      id: 'c5c5c5c5-0000-0000-0000-000000000001',
      hostname: 'host-trend',
      reliabilityScore: 60,
      reliabilityTrend: trend,
    };

    render(<DeviceList devices={[device]} />);

    const cell = screen.getByTestId('device-c5c5c5c5-0000-0000-0000-000000000001-reliability');
    expect(cell.textContent).toContain('60');
    expect(cell.textContent).toContain(glyph);
    expect(screen.getByLabelText(label)).toBeInTheDocument();
  });

  it('renders the Server column with the hostname of agentServerUrl (#2288)', () => {
    seedColumns('serverUrl');
    const device: Device = {
      ...baseDevice,
      id: 'd8d8d8d8-0000-0000-0000-000000000001',
      hostname: 'host-server',
      agentServerUrl: 'https://old.example.com:8443',
    };

    render(<DeviceList devices={[device]} />);

    const cell = screen.getByTestId('device-d8d8d8d8-0000-0000-0000-000000000001-server-url');
    // Hostname only in the cell; the full URL lives in the title tooltip.
    expect(cell).toHaveTextContent('old.example.com');
    expect(cell).toHaveAttribute('title', 'https://old.example.com:8443');
  });

  it('renders a dash in the Server column when agentServerUrl is missing or malformed (#2288)', () => {
    seedColumns('serverUrl');
    const devices: Device[] = [
      { ...baseDevice, id: 'd9d9d9d9-0000-0000-0000-000000000001', hostname: 'host-null', agentServerUrl: null },
      { ...baseDevice, id: 'd9d9d9d9-0000-0000-0000-000000000002', hostname: 'host-bad', agentServerUrl: 'not a url' },
    ];

    render(<DeviceList devices={devices} />);

    // Em-dash dash cell for both the null and the unparseable URL — asserted
    // exactly so the cell never leaks a raw/blank value.
    expect(screen.getByTestId('device-d9d9d9d9-0000-0000-0000-000000000001-server-url').textContent).toBe('—');
    expect(screen.getByTestId('device-d9d9d9d9-0000-0000-0000-000000000002-server-url').textContent).toBe('—');
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
    expect(badge).toHaveAttribute('aria-label', 'Reboot pending');
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

  it('suppresses the dot on an offline device even when pendingReboot is true (stale/unactionable)', () => {
    const device: Device = {
      ...baseDevice,
      id: '55555555-5555-5555-5555-555555555555',
      hostname: 'host-offline-needs-reboot',
      status: 'offline',
      pendingReboot: true,
    };

    render(<DeviceList devices={[device]} />);

    expect(screen.queryByTestId(`device-${device.id}-pending-reboot-badge`)).toBeNull();
  });
});

describe('DeviceList — linked multi-boot profiles (#2138)', () => {
  beforeEach(() => {
    window.localStorage?.clear();
  });

  const winId = '61111111-1111-1111-1111-111111111111';
  const linId = '62222222-2222-2222-2222-222222222222';
  const plainId = '63333333-3333-3333-3333-333333333333';

  const mkLinked = (over: Partial<Device>): Device => ({
    ...baseDevice,
    linkGroupId: 'group-1',
    ...over,
  });

  const winOnline = () =>
    mkLinked({ id: winId, hostname: 'bootbox', status: 'online', os: 'windows' });
  const linOffline = () =>
    mkLinked({
      id: linId,
      hostname: 'bootbox',
      status: 'offline',
      os: 'linux',
      osVersion: 'ubuntu 24.04',
      agentVersion: '0.66.0',
    });

  it('renders the offline sibling as an expected-offline strip beneath the online member', () => {
    render(<DeviceList devices={[winOnline(), linOffline()]} />);

    const strip = screen.getByTestId(`device-${linId}-inactive-strip`);
    expect(strip).toBeInTheDocument();
    expect(strip.textContent).toContain('Expected offline');
    expect(strip.textContent).toContain('inactive');
    expect(strip.textContent).toContain('Agent v0.66.0');
    // The sibling no longer renders as a full row: its checkbox is gone.
    expect(screen.queryByLabelText('Select bootbox')).not.toBeNull();
    // Only the anchor row's checkbox exists (strip rows carry no checkbox).
    expect(screen.getAllByLabelText('Select bootbox')).toHaveLength(1);
  });

  it('navigates to the strip device on click (strips stay clickable)', () => {
    const onSelect = vi.fn();
    render(<DeviceList devices={[winOnline(), linOffline()]} onSelect={onSelect} />);

    fireEvent.click(screen.getByTestId(`device-${linId}-inactive-strip`));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0]![0].id).toBe(linId);
  });

  it('excludes strip devices from select-all (strips are not selectable rows)', () => {
    const onBulkAction = vi.fn();
    render(
      <DeviceList
        devices={[winOnline(), linOffline(), { ...baseDevice, id: plainId, hostname: 'plain' }]}
        onBulkAction={onBulkAction}
      />
    );

    fireEvent.click(screen.getByLabelText('Select all devices on this page'));
    fireEvent.click(screen.getByRole('button', { name: /bulk actions/i }));
    fireEvent.click(screen.getByText('Reboot Selected'));

    expect(onBulkAction).toHaveBeenCalledTimes(1);
    const selected = onBulkAction.mock.calls[0]![1] as Device[];
    expect(selected.map((d) => d.id).sort()).toEqual([winId, plainId].sort());
  });

  it('marks all-offline group members with the left-edge group bar and no strips', () => {
    const winOff = mkLinked({ id: winId, hostname: 'bootbox', status: 'offline' });
    const linOff = linOffline();
    render(<DeviceList devices={[winOff, linOff]} />);

    expect(screen.getByTestId(`device-${winId}-group-bar`)).toBeInTheDocument();
    expect(screen.getByTestId(`device-${linId}-group-bar`)).toBeInTheDocument();
    expect(screen.queryByTestId(`device-${linId}-inactive-strip`)).toBeNull();
  });

  it('renders full rows with no markers when two members are online (no conflict state)', () => {
    const winOn = winOnline();
    const linOn = mkLinked({ id: linId, hostname: 'bootbox', status: 'online', os: 'linux' });
    render(<DeviceList devices={[winOn, linOn]} />);

    expect(screen.queryByTestId(`device-${linId}-inactive-strip`)).toBeNull();
    expect(screen.queryByTestId(`device-${winId}-group-bar`)).toBeNull();
    expect(screen.getAllByLabelText('Select bootbox')).toHaveLength(2);
  });

  it('flattens the list when the "Collapse linked inactive profiles" toggle is turned off', () => {
    render(<DeviceList devices={[winOnline(), linOffline()]} />);

    expect(screen.getByTestId(`device-${linId}-inactive-strip`)).toBeInTheDocument();

    const toggle = screen.getByTestId('collapse-linked-toggle');
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByTestId(`device-${linId}-inactive-strip`)).toBeNull();
    expect(screen.getAllByLabelText('Select bootbox')).toHaveLength(2);
  });

  it('hides the toggle entirely when no device is linked', () => {
    render(<DeviceList devices={[baseDevice]} />);
    expect(screen.queryByTestId('collapse-linked-toggle')).toBeNull();
  });
});

// #2251 — the default view hides decommissioned devices; the "X of Y devices"
// count line (rendered above the table) must say so and offer the existing
// unhide mechanism (the Decommissioned status filter, applied upstream via
// onShowDecommissioned).
describe('DeviceList — hidden-decommissioned hint (#2251)', () => {
  beforeEach(() => {
    window.localStorage?.clear();
  });

  const decomDevice: Device = {
    ...baseDevice,
    id: '99999999-9999-9999-9999-999999999999',
    hostname: 'host-decom',
    status: 'decommissioned',
  };

  it('shows the hidden count and calls onShowDecommissioned when "show" is clicked', () => {
    const onShow = vi.fn();
    render(
      <DeviceList
        devices={[baseDevice, decomDevice]}
        onShowDecommissioned={onShow}
      />
    );

    const hint = screen.getByTestId('decommissioned-hidden-hint');
    expect(hint).toHaveTextContent('1 decommissioned hidden');

    fireEvent.click(screen.getByTestId('decommissioned-hidden-show'));
    expect(onShow).toHaveBeenCalledTimes(1);
  });

  it('keeps the count-line total consistent with the hidden rows (excludes decommissioned)', () => {
    render(
      <DeviceList
        devices={[baseDevice, decomDevice]}
        onShowDecommissioned={vi.fn()}
      />
    );

    // 1 visible of 1 non-decommissioned — the hidden row is called out by the
    // hint instead of silently vanishing from the denominator.
    expect(screen.getByText(/1 of 1 devices/)).toBeInTheDocument();
  });

  it('renders no hint when decommissioned devices are already visible (includeDecommissioned)', () => {
    render(
      <DeviceList
        devices={[baseDevice, decomDevice]}
        includeDecommissioned
        onShowDecommissioned={vi.fn()}
      />
    );

    expect(screen.queryByTestId('decommissioned-hidden-hint')).toBeNull();
    // Denominator includes the now-visible decommissioned row.
    expect(screen.getByText(/2 of 2 devices/)).toBeInTheDocument();
  });

  it('renders no hint when there are no decommissioned devices', () => {
    render(<DeviceList devices={[baseDevice]} onShowDecommissioned={vi.fn()} />);
    expect(screen.queryByTestId('decommissioned-hidden-hint')).toBeNull();
  });

  it('renders no hint when no onShowDecommissioned handler is wired (standalone render)', () => {
    render(<DeviceList devices={[baseDevice, decomDevice]} />);
    expect(screen.queryByTestId('decommissioned-hidden-hint')).toBeNull();
  });
});

describe('DeviceList — vm_host guest nesting (#2308)', () => {
  beforeEach(() => {
    window.localStorage?.clear();
  });

  const hostId = '71111111-1111-1111-1111-111111111111';
  const vm1Id = '72222222-2222-2222-2222-222222222222';
  const vm2Id = '73333333-3333-3333-3333-333333333333';

  const mkVm = (over: Partial<Device>): Device => ({
    ...baseDevice,
    linkGroupId: 'vm-group-1',
    status: 'online',
    ...over,
  });

  const hostDev = () =>
    mkVm({ id: hostId, hostname: 'hv-01', linkGroupRole: 'host' });
  const guest1 = () =>
    mkVm({ id: vm1Id, hostname: 'vm-web', os: 'linux', linkGroupRole: 'guest' });
  const guest2 = () =>
    mkVm({ id: vm2Id, hostname: 'vm-db', os: 'linux', linkGroupRole: 'guest' });

  it('renders guests as full selectable rows nested beneath the host', () => {
    render(<DeviceList devices={[guest1(), hostDev(), guest2()]} />);

    // Guests keep their own checkboxes — fully managed rows, not strips.
    expect(screen.getByLabelText('Select hv-01')).toBeInTheDocument();
    expect(screen.getByLabelText('Select vm-web')).toBeInTheDocument();
    expect(screen.getByLabelText('Select vm-db')).toBeInTheDocument();
    // Nesting affordances: toggle on the host, glyphs on the guests.
    expect(screen.getByTestId(`device-${hostId}-vm-toggle`)).toBeInTheDocument();
    expect(screen.getByTestId(`device-${vm1Id}-vm-guest-glyph`)).toBeInTheDocument();
    expect(screen.getByTestId(`device-${vm2Id}-vm-guest-glyph`)).toBeInTheDocument();
    // No multiboot treatment leaks in.
    expect(screen.queryByTestId(`device-${vm1Id}-inactive-strip`)).toBeNull();
    expect(screen.queryByTestId(`device-${hostId}-group-bar`)).toBeNull();
  });

  it('collapses guests behind a summary strip and expands them again', () => {
    render(<DeviceList devices={[hostDev(), guest1(), guest2()]} />);

    const toggle = screen.getByTestId(`device-${hostId}-vm-toggle`);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(toggle);
    // Guests are hidden; a summary strip stands in.
    expect(screen.queryByLabelText('Select vm-web')).toBeNull();
    expect(screen.queryByLabelText('Select vm-db')).toBeNull();
    const strip = screen.getByTestId(`device-${hostId}-vm-collapsed-strip`);
    expect(strip.textContent).toContain('2 guest VMs hidden');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    // Clicking the strip expands again.
    fireEvent.click(strip);
    expect(screen.getByLabelText('Select vm-web')).toBeInTheDocument();
    expect(screen.queryByTestId(`device-${hostId}-vm-collapsed-strip`)).toBeNull();
  });

  it('excludes collapsed (hidden) guests from select-all', () => {
    const onBulkAction = vi.fn();
    render(<DeviceList devices={[hostDev(), guest1(), guest2()]} onBulkAction={onBulkAction} />);

    fireEvent.click(screen.getByTestId(`device-${hostId}-vm-toggle`));
    fireEvent.click(screen.getByLabelText('Select all devices on this page'));
    fireEvent.click(screen.getByRole('button', { name: /bulk actions/i }));
    fireEvent.click(screen.getByText('Reboot Selected'));

    expect(onBulkAction).toHaveBeenCalledTimes(1);
    const selected = onBulkAction.mock.calls[0]![1] as Device[];
    expect(selected.map((d) => d.id)).toEqual([hostId]);
  });

  it('offers the "Link as VM host + guests" bulk action when 2+ devices are selected', () => {
    const onBulkAction = vi.fn();
    const plain = { ...baseDevice, id: '74444444-4444-4444-4444-444444444444', hostname: 'plain-b' };
    render(<DeviceList devices={[baseDevice, plain]} onBulkAction={onBulkAction} />);

    fireEvent.click(screen.getByLabelText('Select all devices on this page'));
    fireEvent.click(screen.getByRole('button', { name: /bulk actions/i }));
    fireEvent.click(screen.getByTestId('bulk-link-vm-host'));

    expect(onBulkAction).toHaveBeenCalledTimes(1);
    expect(onBulkAction.mock.calls[0]![0]).toBe('link-vm-host');
    expect((onBulkAction.mock.calls[0]![1] as Device[]).map((d) => d.id).sort()).toEqual(
      [baseDevice.id, plain.id].sort(),
    );
  });

  it('renders guests as plain ungrouped rows when the host is not on the page', () => {
    render(<DeviceList devices={[guest1(), guest2()]} />);

    expect(screen.queryByTestId(`device-${vm1Id}-vm-guest-glyph`)).toBeNull();
    expect(screen.queryByTestId(`device-${vm2Id}-vm-guest-glyph`)).toBeNull();
    expect(screen.getByLabelText('Select vm-web')).toBeInTheDocument();
    expect(screen.getByLabelText('Select vm-db')).toBeInTheDocument();
  });
});

describe('DeviceList — row-menu action gating (#2426)', () => {
  beforeEach(() => {
    window.localStorage?.clear();
  });

  const openRowMenu = () => {
    fireEvent.click(screen.getByRole('button', { name: 'Device actions' }));
  };

  const runScriptBtn = () => screen.getByRole('button', { name: /run script/i });

  // The headline bug: a decommissioned device is agent-less and can NEVER claim
  // a queued command. It is the one status the API genuinely rejects
  // (commands.ts, scriptExecution.ts:118). #2315's "show decommissioned" toggle
  // made these rows trivially reachable from the list.
  it('disables Run Script for a decommissioned device, with a tooltip saying why', () => {
    const onAction = vi.fn();
    const device: Device = { ...baseDevice, status: 'decommissioned' };
    render(<DeviceList devices={[device]} onAction={onAction} includeDecommissioned />);
    openRowMenu();

    expect(runScriptBtn()).toBeDisabled();
    expect(runScriptBtn()).toHaveAttribute('title', 'Device is decommissioned');
    fireEvent.click(runScriptBtn());
    expect(onAction).not.toHaveBeenCalled();
  });

  // REGRESSION GUARD. Run Script is a QUEUED command: the API inserts a pending
  // device_commands row and the agent claims it on its next poll, so running a
  // script against an offline machine works — it executes on reconnect. An
  // earlier cut of this fix gated Run Script on `!== "online"` (copying the
  // live-session siblings, on the strength of a code comment that turned out to
  // be false) and would have silently REMOVED that capability. This test fails
  // if anyone re-introduces that gate.
  it('keeps Run Script ENABLED for an offline device — the command queues and runs on reconnect', () => {
    const onAction = vi.fn();
    const device: Device = { ...baseDevice, status: 'offline' };
    render(<DeviceList devices={[device]} onAction={onAction} />);
    openRowMenu();

    expect(runScriptBtn()).toBeEnabled();
    expect(runScriptBtn()).not.toHaveAttribute('title');
    fireEvent.click(runScriptBtn());
    expect(onAction).toHaveBeenCalledWith('run-script', device);
  });

  // Same argument for the other non-online, non-decommissioned states: the agent
  // may be unreachable right now, but the command is still deliverable later.
  it.each(['maintenance', 'quarantined', 'updating', 'pending'] as const)(
    'keeps Run Script enabled for a %s device (queued command, not a live session)',
    (status) => {
      const onAction = vi.fn();
      const device: Device = { ...baseDevice, status };
      render(<DeviceList devices={[device]} onAction={onAction} />);
      openRowMenu();

      expect(runScriptBtn()).toBeEnabled();
      fireEvent.click(runScriptBtn());
      expect(onAction).toHaveBeenCalledWith('run-script', device);
    },
  );

  it('emits run-script for an online device', () => {
    const onAction = vi.fn();
    render(<DeviceList devices={[baseDevice]} onAction={onAction} />);
    openRowMenu();

    expect(runScriptBtn()).toBeEnabled();
    fireEvent.click(runScriptBtn());
    expect(onAction).toHaveBeenCalledWith('run-script', baseDevice);
  });

  // Remote Terminal really IS a live session (terminalWs rejects anything but
  // online), so its `!== "online"` gate is correct and applies to every
  // non-online status.
  //
  // The per-status tooltip map is exercised across ALL six non-online statuses:
  // it maps each to a distinct string, so a transposed entry (quarantined →
  // "Device is updating") would otherwise ship silently.
  it.each([
    ['offline', 'Device is offline'],
    ['maintenance', 'Device is in maintenance mode'],
    ['decommissioned', 'Device is decommissioned'],
    ['quarantined', 'Device is quarantined'],
    ['updating', 'Device is updating'],
    ['pending', 'Device is pending enrollment'],
  ] as const)(
    'disables Remote Terminal for a %s device with the status-accurate tooltip',
    (status, expectedTitle) => {
      render(
        <DeviceList devices={[{ ...baseDevice, status }]} includeDecommissioned />,
      );
      openRowMenu();

      const btn = screen.getByRole('button', { name: /remote terminal/i });
      expect(btn).toBeDisabled();
      expect(btn).toHaveAttribute('title', expectedTitle);
    },
  );

  // #2630: Reboot is a QUEUED command, not a live session — it used to carry
  // Remote Terminal's `!== "online"` gate, which meant the same offline device
  // showed Reboot disabled in list view and enabled in grid view (DeviceCard).
  // Both surfaces now use isCommandQueueable, so decommissioned is the only
  // status that disables it.
  it.each(['offline', 'maintenance', 'quarantined', 'updating', 'pending'] as const)(
    'keeps Reboot enabled for a %s device and dispatches (runs on reconnect)',
    (status) => {
      const onAction = vi.fn();
      const device: Device = { ...baseDevice, status };
      render(<DeviceList devices={[device]} onAction={onAction} />);
      openRowMenu();

      const btn = screen.getByRole('button', { name: /^reboot$/i });
      expect(btn).toBeEnabled();
      expect(btn).not.toHaveAttribute('title');
      fireEvent.click(btn);
      expect(onAction).toHaveBeenCalledWith('reboot', device);
    },
  );

  it('disables Reboot only for a decommissioned device, and it does not dispatch', () => {
    const onAction = vi.fn();
    render(
      <DeviceList
        devices={[{ ...baseDevice, status: 'decommissioned' }]}
        onAction={onAction}
        includeDecommissioned
      />,
    );
    openRowMenu();

    const btn = screen.getByRole('button', { name: /^reboot$/i });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('title', 'Device is decommissioned');
    fireEvent.click(btn);
    expect(onAction).not.toHaveBeenCalled();
  });

  // Guards the other direction for the live-session gate: without this, setting
  // Remote Terminal to permanently disabled passes the whole suite, because the
  // only other assertion about it covers non-online statuses.
  it('keeps Remote Terminal enabled and dispatching for an online device', () => {
    const onAction = vi.fn();
    render(<DeviceList devices={[baseDevice]} onAction={onAction} />);
    openRowMenu();

    const btn = screen.getByRole('button', { name: /remote terminal/i });
    expect(btn).toBeEnabled();
    fireEvent.click(btn);
    expect(onAction).toHaveBeenCalledWith('terminal', baseDevice);
  });

  // #2630 a11y: the disabled reason must be reachable without hover — see the
  // matching suite in DeviceCard.gating.test.tsx for the rationale.
  it('exposes the gate reason as visible text tied to the disabled action', () => {
    render(<DeviceList devices={[{ ...baseDevice, status: 'offline' }]} />);
    openRowMenu();

    const el = screen.getByTestId(`device-${baseDevice.id}-action-gate-hint`);
    expect(el).toHaveTextContent('Device is offline');
    expect(screen.getByRole('button', { name: /remote terminal/i }))
      .toHaveAttribute('aria-describedby', el.id);
    // Reboot is enabled on offline, so it must NOT claim a disabled reason.
    expect(screen.getByRole('button', { name: /^reboot$/i }))
      .not.toHaveAttribute('aria-describedby');
  });

  it('renders no gate hint for an online device', () => {
    render(<DeviceList devices={[baseDevice]} />);
    openRowMenu();
    expect(screen.queryByTestId(`device-${baseDevice.id}-action-gate-hint`)).toBeNull();
  });

  // Wake (Wake-on-LAN) is the deliberate exception — it exists precisely to
  // target an offline device. Guards against a future "gate every row-menu
  // action" sweep killing the one action that's only useful when offline.
  it('leaves Wake enabled on an offline device, and renders it only when offline', () => {
    render(<DeviceList devices={[{ ...baseDevice, status: 'offline' }]} />);
    openRowMenu();
    expect(screen.getByRole('button', { name: /^wake$/i })).toBeEnabled();

    // Wake is offline-only by design — it must not appear on an online row.
    cleanup();
    render(<DeviceList devices={[baseDevice]} />);
    openRowMenu();
    expect(screen.queryByRole('button', { name: /^wake$/i })).toBeNull();
  });
});

// #2465 CONTRACT: the bulk-action status gate lives in DevicesPage, but the
// action strings it gates are emitted from HERE. Nothing else binds the two, so
// a gate that names an action DeviceList no longer emits — or misses one it
// newly does — degrades silently: DECOMMISSIONED devices quietly start receiving
// commands the API refuses outright, and every behavioural test stays green,
// because a gate's only failure mode is doing nothing.
//
// (Offline devices receiving queued commands is the INTENDED behaviour, not the
// regression — they run on reconnect. That distinction is the whole of #2465.)
//
// This test enumerates the REAL bulk bar and forces every action it emits into
// exactly one of the two policy sets. Add a bulk button without classifying it
// and this fails, with the offending string named.
describe('DeviceList — bulk actions are all classified by the status gate (#2465)', () => {
  // Two online devices: the link-* items only render at selectedIds.size >= 2,
  // so a 1-device selection would hide them from the enumeration.
  const bulkDevices = (): Device[] => [
    { ...baseDevice, id: '71111111-1111-1111-1111-111111111111', hostname: 'bulk-a' },
    { ...baseDevice, id: '72222222-2222-2222-2222-222222222222', hostname: 'bulk-b' },
  ];

  const openBulkMenu = () => {
    fireEvent.click(screen.getByLabelText('Select all devices on this page'));
    fireEvent.click(screen.getByRole('button', { name: /bulk actions/i }));
    return screen.getByTestId('bulk-actions-menu');
  };

  /**
   * Clicking an item closes the menu and clears the selection, so each button is
   * driven from a fresh render and identified by index within the live menu.
   */
  function emittedBulkActions(): string[] {
    const probe = render(<DeviceList devices={bulkDevices()} onBulkAction={vi.fn()} />);
    const buttonCount = within(openBulkMenu()).getAllByRole('button').length;
    probe.unmount();
    expect(buttonCount).toBeGreaterThan(0); // menu must actually render items

    const emitted: string[] = [];
    for (let i = 0; i < buttonCount; i++) {
      const onBulkAction = vi.fn();
      const view = render(<DeviceList devices={bulkDevices()} onBulkAction={onBulkAction} />);
      const buttons = within(openBulkMenu()).getAllByRole('button');
      fireEvent.click(buttons[i]!);
      expect(onBulkAction).toHaveBeenCalledTimes(1);
      emitted.push(onBulkAction.mock.calls[0]![0] as string);
      view.unmount();
    }
    return emitted;
  }

  it('classifies every emitted bulk action as either decommission-gated or explicitly exempt', () => {
    const emitted = emittedBulkActions();

    const unclassified = emitted.filter(
      action =>
        !DECOMMISSION_BLOCKED_BULK_ACTIONS.has(action) && !INTENTIONALLY_UNGATED_BULK_ACTIONS.has(action),
    );
    expect(
      unclassified,
      `Unclassified bulk action(s): ${unclassified.join(', ')}. Add each to DECOMMISSION_BLOCKED_BULK_ACTIONS `
        + '(it sends an agent command, which the API refuses for decommissioned devices) or to '
        + 'INTENTIONALLY_UNGATED_BULK_ACTIONS (with a reason) in bulkActionGating.ts.',
    ).toEqual([]);

    // Sanity: the enumeration actually saw the two actions #2465 is about, so a
    // silently-empty menu can't make this test vacuously pass.
    expect(emitted).toContain('reboot');
    expect(emitted).toContain('run-script');
  });

  it('keeps wake on the ungated side of the contract', () => {
    // The exemption that most looks like an oversight to a future reader:
    // Wake targets devices that are not running, by design. Pinned here at the
    // policy level, and behaviourally in DevicesPage.test.tsx.
    expect(emittedBulkActions()).toContain('wake');
    expect(INTENTIONALLY_UNGATED_BULK_ACTIONS.has('wake')).toBe(true);
    expect(DECOMMISSION_BLOCKED_BULK_ACTIONS.has('wake')).toBe(false);
  });

  it('never classifies an action as both gated and exempt', () => {
    const both = [...DECOMMISSION_BLOCKED_BULK_ACTIONS].filter(a =>
      INTENTIONALLY_UNGATED_BULK_ACTIONS.has(a),
    );
    expect(both).toEqual([]);
  });
});
