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
// d3: not signed in, no KFM (empty folder set), no drift.
// d4: fully protected off a 2-key folder set (mirrors the server's "at least
//     one entry and every value redirected" math, not a hard-coded count of 3).
// d5: signed in but reports zero KFM folder keys — must NOT count as
//     protected (empty set), and the label must render the empty-value style.
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
  {
    deviceId: 'd4',
    hostname: 'delta',
    signedIn: true,
    oneDriveVersion: '24.126.0625.0002',
    filesOnDemandOn: true,
    kfmFolderStates: { Desktop: 'redirected', Documents: 'redirected' },
    mountedLibraries: ['C:\\a'],
    entitledLibraries: ['x'],
    driftEntries: [],
    lastReportedAt: '2026-07-09T00:00:00.000Z',
  },
  {
    deviceId: 'd5',
    hostname: 'echo',
    signedIn: true,
    oneDriveVersion: '24.126.0625.0002',
    filesOnDemandOn: true,
    kfmFolderStates: {},
    mountedLibraries: [],
    entitledLibraries: [],
    driftEntries: [],
    lastReportedAt: '2026-07-09T00:00:00.000Z',
  },
];

const STATS: OneDriveFleetStats = { total: 5, signedIn: 4, kfmProtected: 2, withDrift: 1 };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.fetchOneDriveFleetState).mockResolvedValue({ devices: DEVICES, stats: STATS });
});

describe('OneDriveFleetPage', () => {
  it('renders the four stat tiles from the mocked fleet stats', async () => {
    render(<OneDriveFleetPage />);

    expect(await screen.findByTestId('onedrive-stat-total')).toHaveTextContent('5');
    expect(screen.getByTestId('onedrive-stat-signed-in')).toHaveTextContent('4');
    expect(screen.getByTestId('onedrive-stat-kfm')).toHaveTextContent('2');
    expect(screen.getByTestId('onedrive-stat-drift')).toHaveTextContent('1');
  });

  it('filters rows when a stat tile is clicked', async () => {
    render(<OneDriveFleetPage />);

    const desktop = await screen.findByTestId('responsive-table-desktop');
    // All five devices visible by default.
    expect(within(desktop).getByTestId('onedrive-fleet-row-d1')).toBeInTheDocument();
    expect(within(desktop).getByTestId('onedrive-fleet-row-d2')).toBeInTheDocument();
    expect(within(desktop).getByTestId('onedrive-fleet-row-d3')).toBeInTheDocument();
    expect(within(desktop).getByTestId('onedrive-fleet-row-d4')).toBeInTheDocument();
    expect(within(desktop).getByTestId('onedrive-fleet-row-d5')).toBeInTheDocument();

    // Drift tile → only the device with drift entries.
    fireEvent.click(screen.getByTestId('onedrive-stat-drift'));
    await waitFor(() => {
      expect(within(desktop).queryByTestId('onedrive-fleet-row-d1')).not.toBeInTheDocument();
    });
    expect(within(desktop).getByTestId('onedrive-fleet-row-d2')).toBeInTheDocument();
    expect(within(desktop).queryByTestId('onedrive-fleet-row-d3')).not.toBeInTheDocument();
    expect(within(desktop).queryByTestId('onedrive-fleet-row-d4')).not.toBeInTheDocument();
    expect(within(desktop).queryByTestId('onedrive-fleet-row-d5')).not.toBeInTheDocument();

    // Signed-in tile → only signed-in devices.
    fireEvent.click(screen.getByTestId('onedrive-stat-signed-in'));
    await waitFor(() => {
      expect(within(desktop).getByTestId('onedrive-fleet-row-d1')).toBeInTheDocument();
    });
    expect(within(desktop).getByTestId('onedrive-fleet-row-d2')).toBeInTheDocument();
    expect(within(desktop).queryByTestId('onedrive-fleet-row-d3')).not.toBeInTheDocument();
    expect(within(desktop).getByTestId('onedrive-fleet-row-d4')).toBeInTheDocument();
    expect(within(desktop).getByTestId('onedrive-fleet-row-d5')).toBeInTheDocument();

    // KFM tile → devices NOT fully protected (kfm-gap). d1 (3/3) and d4 (2/2)
    // are fully protected off their reported folder sets and must drop out;
    // d2 (partial), d3 (empty set) and d5 (empty set) remain.
    fireEvent.click(screen.getByTestId('onedrive-stat-kfm'));
    await waitFor(() => {
      expect(within(desktop).queryByTestId('onedrive-fleet-row-d1')).not.toBeInTheDocument();
    });
    expect(within(desktop).queryByTestId('onedrive-fleet-row-d4')).not.toBeInTheDocument();
    const kfmGapHostnames = within(desktop)
      .getAllByTestId(/^onedrive-fleet-row-/)
      .map((row) => row.textContent ?? '');
    expect(kfmGapHostnames).toHaveLength(3);
    expect(kfmGapHostnames.some((t) => t.includes('bravo'))).toBe(true);
    expect(kfmGapHostnames.some((t) => t.includes('charlie'))).toBe(true);
    expect(kfmGapHostnames.some((t) => t.includes('echo'))).toBe(true);
  });

  it('mirrors the server KFM math: a fully redirected 2-folder set counts as protected', async () => {
    render(<OneDriveFleetPage />);
    const desktop = await screen.findByTestId('responsive-table-desktop');

    // d4 reports only 2 KFM folders, both redirected — the label reflects the
    // reported set (2/2), not a hard-coded denominator of 3.
    expect(within(desktop).getByTestId('onedrive-fleet-row-d4')).toHaveTextContent('2/2 redirected');

    // Being fully protected off a 2-key set means it must NOT show up under
    // the kfm-gap filter.
    fireEvent.click(screen.getByTestId('onedrive-stat-kfm'));
    await waitFor(() => {
      expect(within(desktop).queryByTestId('onedrive-fleet-row-d1')).not.toBeInTheDocument();
    });
    expect(within(desktop).queryByTestId('onedrive-fleet-row-d4')).not.toBeInTheDocument();
  });

  it('renders the empty-value style when a device reports zero KFM folder keys', async () => {
    render(<OneDriveFleetPage />);
    const desktop = await screen.findByTestId('responsive-table-desktop');

    // d5 signs in but reports an empty kfmFolderStates — not protected, and
    // the label falls back to the empty-value style rather than "0/0".
    expect(within(desktop).getByTestId('onedrive-fleet-row-d5')).toHaveTextContent('—');
    expect(within(desktop).getByTestId('onedrive-fleet-row-d5')).not.toHaveTextContent('redirected');
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
