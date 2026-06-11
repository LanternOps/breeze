import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DeviceSoftwareInventory from './DeviceSoftwareInventory';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

vi.mock('../shared/Toast', () => ({
  showToast: vi.fn(),
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);
const showToastMock = vi.mocked(showToast);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

const deviceId = '11111111-1111-1111-1111-111111111111';

const SOFTWARE_FIXTURE = {
  thirdPartyUpdatesManaged: false,
  data: [
    {
      id: 'sw-chrome',
      name: 'Google Chrome',
      version: '125.0.6422.142',
      publisher: 'Google LLC',
      installDate: '2026-02-01',
      updateAvailable: true,
      availableVersion: '131.0.6778.86',
      updatePackageId: 'Google.Chrome',
      updateSource: 'third_party',
    },
    {
      id: 'sw-safari',
      name: 'Safari',
      version: '17.5',
      publisher: 'Apple Inc.',
      installDate: '2026-01-01',
    },
    {
      // Windows row with no known update — the Update button must be disabled.
      id: 'sw-noupdate',
      name: 'Legacy Tool',
      version: '1.0.0',
      publisher: 'Acme Corp',
      installDate: '2024-05-01',
    },
  ],
};

describe('DeviceSoftwareInventory action buttons', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders Update and Uninstall buttons enabled on Windows', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse(SOFTWARE_FIXTURE));

    render(<DeviceSoftwareInventory deviceId={deviceId} osType="windows" />);

    const updateBtn = await screen.findByTestId('software-update-sw-chrome');
    const uninstallBtn = await screen.findByTestId('software-uninstall-sw-chrome');
    expect(updateBtn).not.toBeDisabled();
    expect(uninstallBtn).not.toBeDisabled();
  });

  it('disables Update + Uninstall for Apple-published rows on macOS', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse(SOFTWARE_FIXTURE));

    render(<DeviceSoftwareInventory deviceId={deviceId} osType="macos" />);

    const updateBtn = await screen.findByTestId('software-update-sw-safari');
    const uninstallBtn = await screen.findByTestId('software-uninstall-sw-safari');
    expect(updateBtn).toBeDisabled();
    expect(uninstallBtn).toBeDisabled();
    expect(updateBtn.getAttribute('title')).toContain('Apple-signed');
  });

  it('queues an update via POST /devices/:id/software/update and shows success toast', async () => {
    fetchWithAuthMock
      .mockResolvedValueOnce(makeJsonResponse(SOFTWARE_FIXTURE))
      .mockResolvedValueOnce(makeJsonResponse({ success: true, commandId: 'cmd-1', action: 'update' }));

    render(<DeviceSoftwareInventory deviceId={deviceId} osType="windows" />);

    const updateBtn = await screen.findByTestId('software-update-sw-chrome');
    fireEvent.click(updateBtn);

    await waitFor(() => {
      expect(fetchWithAuthMock).toHaveBeenCalledWith(
        `/devices/${deviceId}/software/update`,
        expect.objectContaining({
          method: 'POST',
          // Updates send the winget packageId (not a pinned version) so the
          // agent upgrades by --id to the latest available.
          body: JSON.stringify({ name: 'Google Chrome', packageId: 'Google.Chrome' }),
        })
      );
    });

    await waitFor(() => {
      expect(showToastMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'success',
          message: expect.stringContaining('Update to 131.0.6778.86 queued'),
        })
      );
    });
  });

  it('disables Update for a Windows row with no available update', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse(SOFTWARE_FIXTURE));

    render(<DeviceSoftwareInventory deviceId={deviceId} osType="windows" />);

    const updateBtn = await screen.findByTestId('software-update-sw-noupdate');
    const uninstallBtn = await screen.findByTestId('software-uninstall-sw-noupdate');
    // Uninstall stays available; Update is gated on a real available update.
    expect(updateBtn).toBeDisabled();
    expect(uninstallBtn).not.toBeDisabled();
    expect(updateBtn.getAttribute('title')).toContain('No update available');
  });

  it('shows the available version delta and an updates-available banner', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse(SOFTWARE_FIXTURE));

    render(<DeviceSoftwareInventory deviceId={deviceId} osType="windows" />);

    // Banner reflects the single updatable row in the fixture.
    expect(await screen.findByText(/1 update available/i)).toBeTruthy();
    // Not policy-managed → nudge toward enabling third-party patching.
    expect(screen.getByText(/configuration policy/i)).toBeTruthy();
    // The Chrome row shows current → available.
    expect(screen.getByText('131.0.6778.86')).toBeTruthy();
  });

  it('shows confirmation dialog for Uninstall and only POSTs after confirm', async () => {
    fetchWithAuthMock
      .mockResolvedValueOnce(makeJsonResponse(SOFTWARE_FIXTURE))
      .mockResolvedValueOnce(makeJsonResponse({ success: true, commandId: 'cmd-2', action: 'uninstall' }));

    render(<DeviceSoftwareInventory deviceId={deviceId} osType="windows" />);

    const uninstallBtn = await screen.findByTestId('software-uninstall-sw-chrome');
    fireEvent.click(uninstallBtn);

    // Dialog appears
    expect(await screen.findByText('Uninstall Google Chrome?')).toBeTruthy();
    // Still no second fetch yet
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('confirm-uninstall'));

    await waitFor(() => {
      expect(fetchWithAuthMock).toHaveBeenCalledWith(
        `/devices/${deviceId}/software/uninstall`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ name: 'Google Chrome', version: '125.0.6422.142' }),
        })
      );
    });

    await waitFor(() => {
      expect(showToastMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'success', message: expect.stringContaining('Uninstall queued') })
      );
    });
  });

  it('shows an error toast when the API returns a failure for update', async () => {
    fetchWithAuthMock
      .mockResolvedValueOnce(makeJsonResponse(SOFTWARE_FIXTURE))
      .mockResolvedValueOnce(makeJsonResponse({ error: 'Device offline' }, false, 503));

    render(<DeviceSoftwareInventory deviceId={deviceId} osType="windows" />);

    const updateBtn = await screen.findByTestId('software-update-sw-chrome');
    fireEvent.click(updateBtn);

    await waitFor(() => {
      expect(showToastMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error', message: expect.stringContaining('Device offline') })
      );
    });
  });

  it('Cancel closes the confirmation dialog without POSTing', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse(SOFTWARE_FIXTURE));

    render(<DeviceSoftwareInventory deviceId={deviceId} osType="windows" />);

    const uninstallBtn = await screen.findByTestId('software-uninstall-sw-chrome');
    fireEvent.click(uninstallBtn);

    expect(await screen.findByText('Uninstall Google Chrome?')).toBeTruthy();

    fireEvent.click(screen.getByText('Cancel'));

    await waitFor(() => {
      expect(screen.queryByText('Uninstall Google Chrome?')).toBeNull();
    });
    // No second fetch
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(1);
  });
});
