import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import DeviceList, { type Device } from './DeviceList';
import { DEFAULT_VISIBLE_COLUMNS, writeColumnVisibility } from './columnVisibility';

// Unified Devices list (#1322): network-discovered devices render alongside
// agent endpoints with a class badge, a type badge, an All/Agent/Network
// facet, and blank agent-only columns.

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../remote/ConnectDesktopButton', () => ({ default: () => null }));
vi.mock('@/lib/formatTime', () => ({ formatLastSeen: () => 'just now' }));

const agent: Device = {
  id: '11111111-1111-1111-1111-111111111111',
  deviceClass: 'agent',
  hostname: 'agent-box',
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
};

const networkPrinter: Device = {
  id: '22222222-2222-2222-2222-222222222222',
  deviceClass: 'network',
  assetType: 'printer',
  hostname: 'Lobby Printer',
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
  manufacturer: 'HP',
  model: 'LaserJet',
  monitoringEnabled: true,
};

describe('DeviceList — unified agent + network (#1322)', () => {
  it('renders class badges distinguishing agent and network rows', () => {
    render(<DeviceList devices={[agent, networkPrinter]} pageSize={50} networkDevicesEnabled />);

    const agentBadge = screen.getByTestId(`device-${agent.id}-class-badge`);
    expect(agentBadge.textContent).toMatch(/Agent/i);

    const netBadge = screen.getByTestId(`device-${networkPrinter.id}-class-badge`);
    expect(netBadge.textContent).toMatch(/Network/i);
  });

  it('hides the Class column and the facet entirely when the network arm is disabled', () => {
    render(<DeviceList devices={[agent, networkPrinter]} pageSize={50} />);

    // No class badge cells and no class facet when the feature flag is off.
    expect(screen.queryByTestId(`device-${agent.id}-class-badge`)).toBeNull();
    expect(screen.queryByTestId('device-class-filter-network')).toBeNull();
    // The agent row still renders — it's just the agent-only view.
    expect(screen.getByText('agent-box')).toBeTruthy();
  });

  it('shows the All/Agent/Network facet only when a network device is present', () => {
    const { rerender } = render(<DeviceList devices={[agent]} pageSize={50} networkDevicesEnabled />);
    expect(screen.queryByTestId('device-class-filter-network')).toBeNull();

    rerender(<DeviceList devices={[agent, networkPrinter]} pageSize={50} networkDevicesEnabled />);
    expect(screen.getByTestId('device-class-filter-network')).toBeTruthy();
  });

  it('filters to network-only when the Network facet is selected', () => {
    render(<DeviceList devices={[agent, networkPrinter]} pageSize={50} networkDevicesEnabled />);

    // Both rows visible under "All".
    expect(screen.getByText('agent-box')).toBeTruthy();
    expect(screen.getByText('Lobby Printer')).toBeTruthy();

    fireEvent.click(screen.getByTestId('device-class-filter-network'));

    expect(screen.queryByText('agent-box')).toBeNull();
    expect(screen.getByText('Lobby Printer')).toBeTruthy();
  });

  it('routes a network row to onSelect (Discovery placeholder) via the View button', () => {
    const onSelect = vi.fn();
    render(<DeviceList devices={[networkPrinter]} onSelect={onSelect} pageSize={50} networkDevicesEnabled />);

    fireEvent.click(screen.getByTestId(`device-${networkPrinter.id}-open-network`));
    expect(onSelect).toHaveBeenCalledWith(networkPrinter);
  });

  it('renders agent-only columns blank for a network row (no metric bars)', () => {
    render(<DeviceList devices={[networkPrinter]} pageSize={50} networkDevicesEnabled />);

    // The network row exists.
    const row = screen.getByText('Lobby Printer').closest('tr')!;
    // CPU/RAM are rendered as an em-dash placeholder (—) not a 0% bar; the
    // agent-only cells must not render a progressbar-style metric element.
    expect(within(row).queryByText('0%')).toBeNull();
  });

  // #1386: Role (agent function) and Type (network asset_type) used to collapse
  // to the same deviceRole value+icon on agent rows, reading as a duplicate
  // column. They're now complementary — each populated for exactly one class,
  // a dash for the other — so they never show the same value side by side.
  describe('Role and Type are complementary, never duplicated (#1386)', () => {
    const agentWorkstation: Device = { ...agent, deviceRole: 'workstation' };

    beforeEach(() => {
      // Type is opt-in now (default-off); enable it so this view exercises both
      // columns. writeColumnVisibility persists to localStorage, which the list
      // reads at mount.
      writeColumnVisibility([...DEFAULT_VISIBLE_COLUMNS, 'type']);
    });
    afterEach(() => window.localStorage.clear());

    it('agent row: Role shows the function, Type is a dash (not an echo of Role)', () => {
      render(<DeviceList devices={[agentWorkstation]} pageSize={50} networkDevicesEnabled />);

      // Role is populated for the agent.
      const roleCell = screen.getByTestId(`device-${agentWorkstation.id}-role`);
      expect(within(roleCell).getByLabelText('Workstation')).toBeTruthy();

      // Type renders nothing meaningful for an agent — it has no populated
      // (testid-bearing) cell, just a dash — so it can't duplicate Role.
      expect(screen.queryByTestId(`device-${agentWorkstation.id}-type`)).toBeNull();
    });

    it('network row: Type shows the asset type, Role is a dash', () => {
      render(<DeviceList devices={[networkPrinter]} pageSize={50} networkDevicesEnabled />);

      const typeCell = screen.getByTestId(`device-${networkPrinter.id}-type`);
      expect(typeCell.textContent).toMatch(/printer/i);

      // Role is meaningless for a printer — rendered as a dash, no role badge.
      const roleCell = screen.getByTestId(`device-${networkPrinter.id}-role`);
      expect(roleCell.textContent).toMatch(/—/);
      expect(within(roleCell).queryByLabelText(/workstation|server|printer/i)).toBeNull();
    });
  });
});
