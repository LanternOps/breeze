import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor, fireEvent } from '@testing-library/react';

import { OneDriveFleetPage } from './OneDriveFleetPage';
import * as api from '../../lib/api/onedrive';
import type { OneDriveFleetRow, OneDriveFleetStats } from '../../lib/api/onedrive';

vi.mock('../../lib/api/onedrive', () => ({
  fetchOneDriveFleetState: vi.fn(),
}));

// d1: fully protected (all 3 KFM redirected), signed in, no drift.
// d2: KFM gap (Desktop redirected only), signed in, one drift entry.
// d3: not signed in, no KFM, no drift.
const DEVICES: OneDriveFleetRow[] = [
  {
    deviceId: 'd1',
    hostname: 'alpha',
    signedIn: true,
    oneDriveVersion: '24.126.0625.0002',
    filesOnDemandOn: true,
    kfmFolderStates: { Desktop: 'redirected', Documents: 'redirected', Pictures: 'redirected' },
    mountedLibraries: ['C:\\a', 'C:\\b'],
    entitledLibraries: ['x', 'y'],
    driftEntries: [],
    lastReportedAt: '2026-07-09T00:00:00.000Z',
  },
  {
    deviceId: 'd2',
    hostname: 'bravo',
    signedIn: true,
    oneDriveVersion: '24.126.0625.0002',
    filesOnDemandOn: false,
    kfmFolderStates: { Desktop: 'redirected', Documents: 'not_redirected' },
    mountedLibraries: ['C:\\a'],
    entitledLibraries: ['x', 'y'],
    driftEntries: [{ libraryId: 'lib-1', displayName: 'Finance', reason: 'entitled but not mounted' }],
    lastReportedAt: '2026-07-09T00:00:00.000Z',
  },
  {
    deviceId: 'd3',
    hostname: 'charlie',
    signedIn: false,
    oneDriveVersion: null,
    filesOnDemandOn: false,
    kfmFolderStates: {},
    mountedLibraries: [],
    entitledLibraries: [],
    driftEntries: [],
    lastReportedAt: '2026-07-09T00:00:00.000Z',
  },
];

const STATS: OneDriveFleetStats = { total: 3, signedIn: 2, kfmProtected: 1, withDrift: 1 };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.fetchOneDriveFleetState).mockResolvedValue({ devices: DEVICES, stats: STATS });
});

describe('OneDriveFleetPage', () => {
  it('renders the four stat tiles from the mocked fleet stats', async () => {
    render(<OneDriveFleetPage />);

    expect(await screen.findByTestId('onedrive-stat-total')).toHaveTextContent('3');
    expect(screen.getByTestId('onedrive-stat-signed-in')).toHaveTextContent('2');
    expect(screen.getByTestId('onedrive-stat-kfm')).toHaveTextContent('1');
    expect(screen.getByTestId('onedrive-stat-drift')).toHaveTextContent('1');
  });

  it('filters rows when a stat tile is clicked', async () => {
    render(<OneDriveFleetPage />);

    const desktop = await screen.findByTestId('responsive-table-desktop');
    // All three devices visible by default.
    expect(within(desktop).getByTestId('onedrive-fleet-row-d1')).toBeInTheDocument();
    expect(within(desktop).getByTestId('onedrive-fleet-row-d2')).toBeInTheDocument();
    expect(within(desktop).getByTestId('onedrive-fleet-row-d3')).toBeInTheDocument();

    // Drift tile → only the device with drift entries.
    fireEvent.click(screen.getByTestId('onedrive-stat-drift'));
    await waitFor(() => {
      expect(within(desktop).queryByTestId('onedrive-fleet-row-d1')).not.toBeInTheDocument();
    });
    expect(within(desktop).getByTestId('onedrive-fleet-row-d2')).toBeInTheDocument();
    expect(within(desktop).queryByTestId('onedrive-fleet-row-d3')).not.toBeInTheDocument();

    // Signed-in tile → only signed-in devices.
    fireEvent.click(screen.getByTestId('onedrive-stat-signed-in'));
    await waitFor(() => {
      expect(within(desktop).getByTestId('onedrive-fleet-row-d1')).toBeInTheDocument();
    });
    expect(within(desktop).getByTestId('onedrive-fleet-row-d2')).toBeInTheDocument();
    expect(within(desktop).queryByTestId('onedrive-fleet-row-d3')).not.toBeInTheDocument();

    // KFM tile → devices NOT fully protected (kfm-gap).
    fireEvent.click(screen.getByTestId('onedrive-stat-kfm'));
    await waitFor(() => {
      expect(within(desktop).queryByTestId('onedrive-fleet-row-d1')).not.toBeInTheDocument();
    });
    expect(within(desktop).getByTestId('onedrive-fleet-row-d2')).toBeInTheDocument();
    expect(within(desktop).getByTestId('onedrive-fleet-row-d3')).toBeInTheDocument();
  });

  it('renders the drift count in amber for a drifting device', async () => {
    render(<OneDriveFleetPage />);
    const desktop = await screen.findByTestId('responsive-table-desktop');
    const drift = within(desktop).getByTestId('onedrive-fleet-drift-d2');
    expect(drift).toHaveTextContent('1');
    expect(drift.className).toMatch(/amber/);
  });

  it('shows the empty state when no devices are reporting', async () => {
    vi.mocked(api.fetchOneDriveFleetState).mockResolvedValue({
      devices: [],
      stats: { total: 0, signedIn: 0, kfmProtected: 0, withDrift: 0 },
    });
    render(<OneDriveFleetPage />);
    const empty = await screen.findByTestId('onedrive-fleet-empty');
    expect(empty).toHaveTextContent(/OneDrive Helper/i);
  });
});
