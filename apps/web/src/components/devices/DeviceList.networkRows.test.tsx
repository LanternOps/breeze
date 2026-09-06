import { fireEvent, render, screen } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import DeviceList, { type Device } from './DeviceList';
import { DEFAULT_VISIBLE_COLUMNS, writeColumnVisibility } from './columnVisibility';

// Fixes from the 2026-09-06 unified-list critique: sort keys must agree with
// the dash the cell renders for network rows, headers must be keyboard
// sortable, the per-row View action must name its device, search must match
// the IP that is a network device's primary identifier, and there must be
// exactly one class facet on the page (the DevicesPage segment), never a
// second one inside the list.

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn(), registerOrgIdProvider: vi.fn() }));
vi.mock('@/stores/orgStore', () => ({
  useOrgStore: (selector: (s: { currentOrgId: string | null; allOrgs: boolean }) => unknown) =>
    selector({ currentOrgId: null, allOrgs: true }),
}));
vi.mock('../remote/ConnectDesktopButton', () => ({ default: () => null }));
vi.mock('@/lib/formatTime', () => ({ formatLastSeen: () => 'just now' }));

const agent = (id: string, hostname: string, extra: Partial<Device> = {}): Device => ({
  id,
  deviceClass: 'agent',
  hostname,
  os: 'windows',
  osVersion: '11',
  status: 'online',
  cpuPercent: 42,
  ramPercent: 55,
  lastSeen: new Date().toISOString(),
  orgId: 'org-1',
  orgName: 'Acme',
  siteId: 'site-1',
  siteName: 'HQ',
  agentVersion: '0.70.0',
  tags: [],
  ...extra,
});

const network = (id: string, hostname: string, extra: Partial<Device> = {}): Device => ({
  id,
  deviceClass: 'network',
  assetType: 'switch',
  hostname,
  os: '' as Device['os'],
  osVersion: '',
  status: 'online',
  cpuPercent: 0,
  ramPercent: 0,
  lastSeen: new Date().toISOString(),
  orgId: 'org-1',
  orgName: 'Acme',
  siteId: 'site-1',
  siteName: 'HQ',
  agentVersion: '',
  tags: [],
  lanIp: '10.20.0.2',
  ...extra,
});

const rowOrder = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('tbody tr td:nth-child(2) span.font-medium')).map((el) => el.textContent);

const A_MAC = agent('a0000000-0000-0000-0000-000000000001', 'mac-box', { os: 'macos', cpuPercent: 10, ramPercent: 20 });
const A_WIN = agent('a0000000-0000-0000-0000-000000000002', 'win-box', { os: 'windows', cpuPercent: 42, ramPercent: 55 });
const N_SW = network('b0000000-0000-0000-0000-000000000001', 'core-sw');
const N_FW = network('b0000000-0000-0000-0000-000000000002', 'fw-edge', { lanIp: '10.20.0.1' });

afterEach(() => {
  writeColumnVisibility(DEFAULT_VISIBLE_COLUMNS);
});

const sortButton = (name: RegExp) => screen.getByRole('button', { name });

describe('DeviceList — network rows sort as blanks (critique P1)', () => {
  it('OS sort puts network rows last in both directions instead of between macOS and Windows', () => {
    const { container } = render(
      <DeviceList devices={[N_SW, A_WIN, N_FW, A_MAC]} pageSize={50} networkDevicesEnabled />,
    );
    fireEvent.click(sortButton(/sort by operating system/i));
    expect(rowOrder(container)).toEqual(['mac-box', 'win-box', 'core-sw', 'fw-edge']);
    fireEvent.click(sortButton(/sort by operating system/i));
    expect(rowOrder(container)).toEqual(['win-box', 'mac-box', 'core-sw', 'fw-edge']);
  });

  it('CPU sort moves agent rows and keeps network rows last, rather than tying everything at zero', () => {
    const { container } = render(
      <DeviceList devices={[N_SW, A_WIN, A_MAC]} pageSize={50} networkDevicesEnabled />,
    );
    fireEvent.click(sortButton(/sort by cpu usage/i));
    expect(rowOrder(container)).toEqual(['mac-box', 'win-box', 'core-sw']);
    fireEvent.click(sortButton(/sort by cpu usage/i));
    expect(rowOrder(container)).toEqual(['win-box', 'mac-box', 'core-sw']);
  });
});

describe('DeviceList — keyboard and screen-reader access (critique P2)', () => {
  it('every sortable column header hosts a real button and reports aria-sort on the header cell', () => {
    render(<DeviceList devices={[A_MAC, N_SW]} pageSize={50} networkDevicesEnabled />);
    const osHeader = sortButton(/sort by operating system/i).closest('th');
    expect(osHeader).not.toBeNull();
    expect(osHeader?.getAttribute('scope')).toBe('col');
    expect(osHeader?.getAttribute('aria-sort')).toBe('none');
    fireEvent.click(sortButton(/sort by operating system/i));
    expect(osHeader?.getAttribute('aria-sort')).toBe('ascending');
  });

  it('names the network View action after its device', () => {
    render(<DeviceList devices={[N_SW, N_FW]} pageSize={50} networkDevicesEnabled />);
    expect(screen.getByRole('button', { name: 'View core-sw' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'View fw-edge' })).toBeTruthy();
  });

  it('keeps a visible focus ring on rows instead of only a background tint', () => {
    const { container } = render(<DeviceList devices={[N_SW]} pageSize={50} networkDevicesEnabled />);
    const row = container.querySelector('tbody tr[tabindex="0"]');
    expect(row?.className).toMatch(/focus-visible:ring/);
  });

  it('does not render a second All/Agent/Network facet inside the list (the page segment owns it)', () => {
    render(<DeviceList devices={[A_MAC, N_SW]} pageSize={50} networkDevicesEnabled />);
    expect(screen.queryByTestId('device-class-filter-all')).toBeNull();
    expect(screen.queryByRole('group', { name: /filter by device class/i })).toBeNull();
  });
});

describe('DeviceList — search (critique minor)', () => {
  it('matches a network device by its IP address', () => {
    const { container } = render(
      <DeviceList
        devices={[A_MAC, N_SW, N_FW]}
        pageSize={50}
        networkDevicesEnabled
        listFilters={{ search: '10.20.0.1' }}
      />,
    );
    expect(rowOrder(container)).toEqual(['fw-edge']);
  });
});

describe('DeviceList — class-aware filtering (critique P0)', () => {
  it('keeps network rows that satisfy the active filter even though the server id set cannot contain them', () => {
    const { container } = render(
      <DeviceList
        devices={[A_MAC, A_WIN, N_SW, N_FW]}
        pageSize={50}
        networkDevicesEnabled
        serverFilterIds={new Set([A_MAC.id])}
        advancedFilter={{ operator: 'AND', conditions: [{ field: 'status', operator: 'equals', value: 'online' }] }}
      />,
    );
    expect(rowOrder(container)).toEqual(['core-sw', 'fw-edge', 'mac-box']);
  });
});

describe('DeviceList — bulk bar tells the truth about a mixed selection (critique P0)', () => {
  it('states the class composition and disables agent-only actions when no agent is selected', () => {
    render(<DeviceList devices={[A_MAC, N_SW, N_FW]} pageSize={50} networkDevicesEnabled />);
    fireEvent.click(screen.getByLabelText('Select all devices on this page'));
    expect(screen.getByTestId('bulk-selection-summary').textContent).toMatch(/3 selected/);
    expect(screen.getByTestId('bulk-selection-summary').textContent).toMatch(/1 agent, 2 network/);

    // Deselect the agent → only network rows remain selected.
    fireEvent.click(screen.getByLabelText(`Select ${A_MAC.hostname}`));
    fireEvent.click(screen.getByRole('button', { name: /bulk actions/i }));
    const reboot = screen.getByRole('button', { name: /reboot selected/i });
    expect(reboot).toBeDisabled();
    expect(reboot.getAttribute('title')).toMatch(/agent devices only/i);
    expect(screen.queryByTestId('bulk-compare')).toBeNull();
  });

  it('annotates agent-only actions with the eligible count on a mixed selection', () => {
    render(<DeviceList devices={[A_MAC, A_WIN, N_SW]} pageSize={50} networkDevicesEnabled />);
    fireEvent.click(screen.getByLabelText('Select all devices on this page'));
    fireEvent.click(screen.getByRole('button', { name: /bulk actions/i }));
    const reboot = screen.getByRole('button', { name: /reboot selected/i });
    expect(reboot).not.toBeDisabled();
    expect(reboot.textContent).toMatch(/2 of 3/);
  });

  it('drops selected rows that leave the list so the bar never counts invisible devices', () => {
    const { rerender } = render(<DeviceList devices={[A_MAC, N_SW]} pageSize={50} networkDevicesEnabled />);
    fireEvent.click(screen.getByLabelText('Select all devices on this page'));
    expect(screen.getByTestId('bulk-selection-summary').textContent).toMatch(/2 selected/);
    rerender(<DeviceList devices={[A_MAC]} pageSize={50} networkDevicesEnabled />);
    expect(screen.getByTestId('bulk-selection-summary').textContent).toMatch(/1 selected/);
  });
});

describe('DeviceList — columns adapt to the classes on screen (critique minor)', () => {
  it('drops the agent-only telemetry columns when only network rows are shown, and Class/Type when only agent rows are', () => {
    const { rerender } = render(<DeviceList devices={[N_SW, N_FW]} pageSize={50} networkDevicesEnabled />);
    expect(screen.queryByRole('button', { name: /sort by operating system/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /sort by cpu usage/i })).toBeNull();
    expect(screen.getByRole('button', { name: /sort by class/i })).toBeTruthy();

    rerender(<DeviceList devices={[A_MAC, A_WIN]} pageSize={50} networkDevicesEnabled />);
    expect(screen.getByRole('button', { name: /sort by operating system/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /sort by class/i })).toBeNull();

    rerender(<DeviceList devices={[A_MAC, N_SW]} pageSize={50} networkDevicesEnabled />);
    expect(screen.getByRole('button', { name: /sort by operating system/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /sort by class/i })).toBeTruthy();
  });

  it('uses the same status word as the card view (Online, not Up)', () => {
    render(<DeviceList devices={[A_MAC]} pageSize={50} networkDevicesEnabled />);
    expect(screen.getByText('Online')).toBeTruthy();
    expect(screen.queryByText('Up')).toBeNull();
  });
});

describe('DeviceList — review round fixes', () => {
  it('prunes a selected row that a search hides, even though the devices prop is unchanged', () => {
    const devices = [A_MAC, N_SW];
    const { rerender } = render(<DeviceList devices={devices} pageSize={50} networkDevicesEnabled listFilters={{ search: '', vpn: 'all' }} />);
    fireEvent.click(screen.getByLabelText('Select all devices on this page'));
    expect(screen.getByTestId('bulk-selection-summary').textContent).toMatch(/2 selected/);
    rerender(<DeviceList devices={devices} pageSize={50} networkDevicesEnabled listFilters={{ search: 'core-sw', vpn: 'all' }} />);
    expect(screen.getByTestId('bulk-selection-summary').textContent).toMatch(/1 selected/);
  });

  it('offers Compare for 2 and 4 selected agents but not for 5', () => {
    const agents = [1, 2, 3, 4, 5].map((n) => agent(`a0000000-0000-0000-0000-00000000000${n}`, `box-${n}`));
    render(<DeviceList devices={agents} pageSize={50} networkDevicesEnabled />);
    const check = (n: number) => fireEvent.click(screen.getByLabelText(`Select box-${n}`));
    check(1); check(2);
    fireEvent.click(screen.getByRole('button', { name: /bulk actions/i }));
    expect(screen.getByTestId('bulk-compare')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /bulk actions/i }));
    check(3); check(4);
    fireEvent.click(screen.getByRole('button', { name: /bulk actions/i }));
    expect(screen.getByTestId('bulk-compare')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /bulk actions/i }));
    check(5);
    fireEvent.click(screen.getByRole('button', { name: /bulk actions/i }));
    expect(screen.queryByTestId('bulk-compare')).toBeNull();
  });

  it('hides the VPN facet when only network rows are on screen (it can never match them)', () => {
    writeColumnVisibility([...DEFAULT_VISIBLE_COLUMNS, 'vpn']);
    const { rerender } = render(<DeviceList devices={[A_MAC, N_SW]} pageSize={50} networkDevicesEnabled />);
    expect(screen.getByTestId('device-vpn-filter')).toBeTruthy();
    rerender(<DeviceList devices={[N_SW, N_FW]} pageSize={50} networkDevicesEnabled />);
    expect(screen.queryByTestId('device-vpn-filter')).toBeNull();
  });

  it('lifts the VPN facet into listFilters so the page can count it', () => {
    writeColumnVisibility([...DEFAULT_VISIBLE_COLUMNS, 'vpn']);
    const onChange = vi.fn();
    render(
      <DeviceList
        devices={[A_MAC, N_SW]}
        pageSize={50}
        networkDevicesEnabled
        listFilters={{ search: '', vpn: 'all' }}
        onListFiltersChange={onChange}
      />,
    );
    fireEvent.change(screen.getByTestId('device-vpn-filter'), { target: { value: 'any' } });
    expect(onChange).toHaveBeenCalledWith({ search: '', vpn: 'any' });
  });
});
