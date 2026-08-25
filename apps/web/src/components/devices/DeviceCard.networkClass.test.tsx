import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DeviceCard from './DeviceCard';
import type { Device } from './DeviceList';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn()
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

const makeJsonResponse = (payload: unknown): Response =>
  ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: vi.fn().mockResolvedValue(payload)
  }) as unknown as Response;

const agentDevice: Device = {
  id: '11111111-1111-1111-1111-111111111111',
  deviceClass: 'agent',
  hostname: 'edge-01',
  os: 'windows',
  osVersion: '11',
  status: 'online',
  cpuPercent: 58,
  ramPercent: 71,
  lastSeen: '2026-02-09T10:00:00.000Z',
  orgId: 'org-1',
  orgName: 'Org One',
  siteId: 'site-1',
  siteName: 'HQ',
  agentVersion: '1.0.0',
  tags: []
};

// Shaped exactly like DevicesPage's `transformedNetworkDevices` mapping: the
// `id` is a `discovered_assets.id`, os/agentVersion are blank, and cpu/ram are
// filled with a placeholder 0 that must never be presented as a reading.
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
  lastSeen: '2026-02-09T10:00:00.000Z',
  orgId: 'org-1',
  orgName: 'Org One',
  siteId: 'site-1',
  siteName: 'HQ',
  agentVersion: '',
  tags: [],
  manufacturer: 'HP',
  model: 'LaserJet',
  monitoringEnabled: true
};

// #4014: DeviceCard had no `deviceClass` handling at all, so the grid offered
// Terminal / Run Script / Reboot / Settings / Remove for network-discovered
// assets. A network row's `id` is a `discovered_assets.id`, NOT a `devices.id`
// (#1322) — every one of those actions posts a foreign id at a /devices/:id
// endpoint. The list row already collapses to a single "View" button
// (DeviceList.tsx), and the grid card must match it.
describe('DeviceCard network-class guard (#4014)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ metrics: [] }));
  });

  it('renders a View button instead of the actions kebab for a network row', () => {
    render(<DeviceCard device={networkPrinter} />);

    expect(screen.getByTestId(`device-${networkPrinter.id}-open-network`)).toBeInTheDocument();
    // The kebab trigger itself must be gone — not merely emptied — so there is
    // no path to the agent menu at all.
    expect(screen.queryByTestId(`device-${networkPrinter.id}-actions-menu`)).toBeNull();
    expect(screen.queryByLabelText(`Actions for ${networkPrinter.hostname}`)).toBeNull();
  });

  it('reuses the list row\'s "View" copy (deviceList.view), not a new string', () => {
    render(<DeviceCard device={networkPrinter} />);

    expect(screen.getByTestId(`device-${networkPrinter.id}-open-network`).textContent?.trim()).toBe('View');
  });

  it('routes the View button to onClick (the network detail page) with the device', () => {
    const onClick = vi.fn();
    render(<DeviceCard device={networkPrinter} onClick={onClick} />);

    fireEvent.click(screen.getByTestId(`device-${networkPrinter.id}-open-network`));

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onClick).toHaveBeenCalledWith(networkPrinter);
  });

  it('exposes exactly one control on a network card, and it is View — never an agent action', () => {
    const onAction = vi.fn();
    render(<DeviceCard device={networkPrinter} onAction={onAction} />);

    // Asserting the *count and identity* of controls (rather than the absence
    // of the menu items) keeps this non-vacuous: before the fix there is also
    // exactly one button, but it is the kebab trigger, not View.
    const controls = screen.getAllByRole('button');
    expect(controls).toHaveLength(1);
    expect(controls[0]).toHaveAttribute('data-testid', `device-${networkPrinter.id}-open-network`);

    // The one control that does exist cannot dispatch an agent action.
    fireEvent.click(controls[0]);
    expect(onAction).not.toHaveBeenCalled();
  });

  it('does not fetch /devices/:id/metrics with a discovered_assets id', async () => {
    render(<DeviceCard device={networkPrinter} />);

    // Give the mount effect a turn to fire before asserting it did not.
    await waitFor(() => {
      expect(screen.getByTestId(`device-${networkPrinter.id}-open-network`)).toBeInTheDocument();
    });
    expect(fetchWithAuthMock).not.toHaveBeenCalled();
  });

  it('renders CPU/RAM as an em-dash for a network row instead of a fabricated 0%', () => {
    render(<DeviceCard device={networkPrinter} />);

    expect(screen.queryByText('0%')).toBeNull();
    expect(screen.getAllByText('—')).toHaveLength(2);
    expect(screen.queryByTestId(`cpu-sparkline-${networkPrinter.id}`)).toBeNull();
    expect(screen.queryByTestId(`ram-sparkline-${networkPrinter.id}`)).toBeNull();
    // No "Loading trend..." limbo either — the fetch never starts.
    expect(screen.queryByText('Loading trend...')).toBeNull();
  });

  it('leaves the agent card untouched: full kebab, no View button, metrics still fetched', async () => {
    render(<DeviceCard device={agentDevice} onAction={vi.fn()} />);

    expect(screen.queryByTestId(`device-${agentDevice.id}-open-network`)).toBeNull();
    fireEvent.click(screen.getByLabelText(`Actions for ${agentDevice.hostname}`));

    expect(screen.getByRole('button', { name: /remote terminal/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /run script/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^reboot/i })).toBeInTheDocument();
    expect(screen.getByTestId(`device-${agentDevice.id}-action-remove`)).toBeInTheDocument();

    await waitFor(() => {
      expect(fetchWithAuthMock).toHaveBeenCalledWith(`/devices/${agentDevice.id}/metrics?range=1h`);
    });
  });

  // Review finding: with the kebab and the metrics gone, nothing on the card
  // said WHY it looked different from its siblings — a printer rendered the
  // generic monitor glyph, a blank OS line and two dashes, which reads as a
  // broken agent. The list answers that with a Class badge; the grid now does
  // too, with the same copy and testid.
  it('explains itself with the list\'s own Network class badge', () => {
    render(<DeviceCard device={networkPrinter} />);

    const badge = screen.getByTestId(`device-${networkPrinter.id}-class-badge`);
    expect(badge.textContent?.trim()).toBe('Network');
    expect(badge).toHaveAttribute('title', 'Network-discovered device');
  });

  it('does not badge an agent card', () => {
    render(<DeviceCard device={agentDevice} />);

    expect(screen.queryByTestId(`device-${agentDevice.id}-class-badge`)).toBeNull();
    // The agent card keeps the OS version line the badge replaces.
    expect(screen.getByText('11')).toBeInTheDocument();
  });

  // The metrics effect gained `isNetwork` in its dependency array. Cards are
  // keyed by device.id so this transition does not happen in the real grid,
  // but dropping the dep would leave the fetch permanently skipped for a
  // component that later becomes an agent — silent and invisible.
  it('starts fetching metrics if the same card instance becomes an agent', async () => {
    const { rerender } = render(<DeviceCard device={networkPrinter} />);
    expect(fetchWithAuthMock).not.toHaveBeenCalled();

    rerender(<DeviceCard device={{ ...networkPrinter, deviceClass: 'agent' }} />);

    await waitFor(() => {
      expect(fetchWithAuthMock).toHaveBeenCalledWith(`/devices/${networkPrinter.id}/metrics?range=1h`);
    });
  });

  it('treats a row with no deviceClass as an agent (default), keeping the kebab', () => {
    const legacy: Device = { ...agentDevice, deviceClass: undefined };
    render(<DeviceCard device={legacy} onAction={vi.fn()} />);

    expect(screen.queryByTestId(`device-${legacy.id}-open-network`)).toBeNull();
    expect(screen.getByTestId(`device-${legacy.id}-actions-menu`)).toBeInTheDocument();
  });
});
