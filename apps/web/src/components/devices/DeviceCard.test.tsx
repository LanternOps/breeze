import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DeviceCard from './DeviceCard';
import type { Device } from './DeviceList';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn()
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload)
  }) as unknown as Response;

const baseDevice: Device = {
  id: 'device-1',
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

describe('DeviceCard sparkline history', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders CPU/RAM sparklines from metrics API data', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({
        metrics: [
          { timestamp: '2026-02-09T10:00:00.000Z', cpu: 40, ram: 50 },
          { timestamp: '2026-02-09T10:05:00.000Z', cpu: 45, ram: 55 },
          { timestamp: '2026-02-09T10:10:00.000Z', cpu: 52, ram: 63 }
        ]
      })
    );

    render(<DeviceCard device={baseDevice} />);

    await screen.findByTestId('cpu-sparkline-device-1');
    expect(screen.queryByText('Loading trend...')).toBeNull();
    expect(screen.queryByText('No trend data')).toBeNull();

    await screen.findByTestId('ram-sparkline-device-1');

    expect(fetchWithAuthMock).toHaveBeenCalledWith('/devices/device-1/metrics?range=1h');
  });

  it('shows an explicit empty state when no metric history exists', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ metrics: [] }));

    render(<DeviceCard device={baseDevice} />);

    await waitFor(() => {
      expect(screen.getAllByText('No trend data').length).toBe(2);
    });
  });
});

// The sr-only status text previously fell back to a raw Title-Case of the
// enum value ("Decommissioned"), so a screen reader announced a different
// word than every visible "Removed" string on the same card. Assert it goes
// through the same i18n label source as the visible text.
describe('DeviceCard sr-only status text', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ metrics: [] }));
  });

  it('announces "Removed" (not the raw enum) for a decommissioned device', () => {
    render(<DeviceCard device={{ ...baseDevice, status: 'decommissioned' }} />);

    expect(screen.getByText('Removed')).toBeInTheDocument();
    expect(screen.queryByText('Decommissioned')).not.toBeInTheDocument();
  });
});

// #4622 W04: this card had no `deviceClass` handling for 'manual' at all when
// the class was first introduced, so the grid offered the FULL agent kebab
// (Terminal/Run Script/Reboot/Decommission/Permanent Delete) on a manual
// asset's foreign `manual_assets.id` — the same #4014 failure class the
// network arm was already fixed for. Locks in the fix: Edit/Delete only, no
// metrics fetch.
describe('DeviceCard manual asset class (#4622 W04)', () => {
  const manualDevice: Device = {
    ...baseDevice,
    id: 'manual-1',
    hostname: 'spare-laptop',
    deviceClass: 'manual',
    assetType: 'workstation',
    status: 'unknown',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('never fires the agent metrics-history request for a manual row', async () => {
    render(<DeviceCard device={manualDevice} />);
    // Give any accidental effect a tick to fire before asserting its absence.
    await Promise.resolve();
    expect(fetchWithAuthMock).not.toHaveBeenCalled();
  });

  it('offers Edit and Delete, never the agent actions menu, for a manual row', () => {
    const onClick = vi.fn();
    const onAction = vi.fn();
    render(<DeviceCard device={manualDevice} onClick={onClick} onAction={onAction} />);

    expect(screen.getByTestId('device-manual-1-edit-manual')).toBeInTheDocument();
    expect(screen.getByTestId('device-manual-1-delete-manual')).toBeInTheDocument();
    expect(screen.queryByTestId('device-manual-1-actions-menu')).not.toBeInTheDocument();
    expect(screen.queryByTestId('device-manual-1-open-network')).not.toBeInTheDocument();

    screen.getByTestId('device-manual-1-edit-manual').click();
    expect(onClick).toHaveBeenCalledWith(manualDevice);

    screen.getByTestId('device-manual-1-delete-manual').click();
    expect(onAction).toHaveBeenCalledWith('delete-manual', manualDevice);
  });

  it('renders the Unknown status chip, never Offline, and no CPU/RAM reading', () => {
    render(<DeviceCard device={manualDevice} />);
    expect(screen.getByText('Unknown')).toBeInTheDocument();
    expect(screen.queryByText('Offline')).not.toBeInTheDocument();
  });
});
