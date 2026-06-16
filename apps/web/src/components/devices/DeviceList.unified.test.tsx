import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

import DeviceList, { type Device } from './DeviceList';

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
});
