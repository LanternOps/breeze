import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';

import { DeviceOneDriveTab } from './DeviceOneDriveTab';
import * as api from '../../lib/api/onedrive';
import type { OneDriveDeviceState } from '../../lib/api/onedrive';

vi.mock('../../lib/api/onedrive', () => ({
  fetchDeviceOneDriveState: vi.fn(),
}));

// A signed-in device with: Desktop redirected, Documents not redirected,
// Pictures absent (→ rendered as unknown), one entitled composite whose
// human label is decoded from its webUrl= segment, one mounted path, and one
// drift entry.
const ENTITLED_COMPOSITE =
  'tenantId=abc&siteId={s1}&webId={w1}&listId={l1}' +
  '&webUrl=https%3A%2F%2Fcontoso.sharepoint.com%2Fsites%2FFinance%2FShared%20Documents&version=1';

const STATE: OneDriveDeviceState = {
  deviceId: 'd1',
  signedIn: true,
  oneDriveVersion: '24.126.0625.0002',
  filesOnDemandOn: true,
  kfmFolderStates: { Desktop: 'redirected', Documents: 'not_redirected' },
  mountedLibraries: ['C:\\Users\\bob\\Contoso\\Finance'],
  entitledLibraries: [ENTITLED_COMPOSITE],
  driftEntries: [{ libraryId: 'lib-1', displayName: 'Finance Library', reason: 'entitled but not mounted' }],
  lastReportedAt: '2026-07-09T00:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.fetchDeviceOneDriveState).mockResolvedValue(STATE);
});

describe('DeviceOneDriveTab', () => {
  it('renders status chips, KFM badges, entitled label and drift rows after loading', async () => {
    render(<DeviceOneDriveTab deviceId="d1" />);

    // Header chips
    const header = await screen.findByTestId('device-onedrive-header');
    expect(header).toHaveTextContent(/Signed in/i);
    expect(header).toHaveTextContent(/Files On-Demand/i);
    expect(header).toHaveTextContent('24.126.0625.0002');

    // KFM badges — Pictures is absent from the map and renders as unknown
    expect(screen.getByTestId('onedrive-kfm-Desktop')).toHaveTextContent(/Redirected/i);
    expect(screen.getByTestId('onedrive-kfm-Documents')).toHaveTextContent(/Not redirected/i);
    expect(screen.getByTestId('onedrive-kfm-Pictures')).toHaveTextContent(/Unknown/i);

    // Entitled composite decoded to a human label (host + path tail), full
    // composite retained in the title attribute.
    const entitled = screen.getByTestId('onedrive-entitled-0');
    expect(entitled).toHaveTextContent('contoso.sharepoint.com/sites/Finance/Shared Documents');
    expect(entitled).toHaveAttribute('title', ENTITLED_COMPOSITE);

    // Mounted path listed as-is
    expect(screen.getByTestId('onedrive-mounted-0')).toHaveTextContent('C:\\Users\\bob\\Contoso\\Finance');
  });

  it('renders a drift row with its reason text', async () => {
    render(<DeviceOneDriveTab deviceId="d1" />);
    const drift = await screen.findByTestId('onedrive-drift-0');
    expect(within(drift).getByText(/Finance Library/)).toBeInTheDocument();
    expect(drift).toHaveTextContent('entitled but not mounted');
  });

  it('shows the empty state when no OneDrive state has been reported', async () => {
    vi.mocked(api.fetchDeviceOneDriveState).mockResolvedValue(null);
    render(<DeviceOneDriveTab deviceId="d1" />);
    const empty = await screen.findByTestId('device-onedrive-empty');
    expect(empty).toHaveTextContent(/No OneDrive state reported yet/i);
  });

  it('shows the error state when the fetch rejects', async () => {
    vi.mocked(api.fetchDeviceOneDriveState).mockRejectedValue(new Error('boom'));
    render(<DeviceOneDriveTab deviceId="d1" />);
    const err = await screen.findByTestId('device-onedrive-error');
    expect(err).toHaveTextContent('boom');
  });
});
