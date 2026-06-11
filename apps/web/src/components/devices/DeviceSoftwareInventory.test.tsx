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
  data: [
    {
      id: 'sw-chrome',
      name: 'Google Chrome',
      version: '125.0.6422.142',
      publisher: 'Google LLC',
      installDate: '2026-02-01',
    },
    {
      id: 'sw-safari',
      name: 'Safari',
      version: '17.5',
      publisher: 'Apple Inc.',
      installDate: '2026-01-01',
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
          body: JSON.stringify({ name: 'Google Chrome', version: '125.0.6422.142' }),
        })
      );
    });

    await waitFor(() => {
      expect(showToastMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'success', message: expect.stringContaining('Update queued') })
      );
    });
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
