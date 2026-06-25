import { fireEvent, render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import DeviceList, { type Device } from './DeviceList';
import { COLUMN_IDS } from './columnVisibility';

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
