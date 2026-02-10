import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DevicePatchStatusTab from './DevicePatchStatusTab';
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

const deviceId = '11111111-1111-1111-1111-111111111111';

describe('DevicePatchStatusTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders Windows-specific patch sections for Windows devices', async () => {
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse({
        data: {
          compliancePercent: 80,
          pending: [
            {
              id: 'p-1',
              title: '2026-01 Cumulative Update for Windows 11 (KB5050001)',
              source: 'microsoft',
              category: 'security',
              status: 'pending',
              severity: 'important',
              releaseDate: '2026-02-01',
              requiresReboot: true
            },
            {
              id: 'p-2',
              title: 'Google Chrome',
              source: 'third_party',
              category: 'application',
              status: 'pending',
              severity: 'low',
              releaseDate: '2026-01-30'
            }
          ],
          installed: [
            {
              id: 'i-1',
              title: 'Security Intelligence Update for Microsoft Defender',
              source: 'microsoft',
              category: 'definitions',
              status: 'installed',
              installedAt: '2026-02-01T08:30:00.000Z'
            },
            {
              id: 'i-2',
              title: 'Zoom',
              source: 'third_party',
              category: 'application',
              status: 'installed',
              installedAt: '2026-02-02T11:00:00.000Z'
            }
          ]
        }
      })
    );

    render(<DevicePatchStatusTab deviceId={deviceId} osType="windows" />);

    await screen.findByText('Pending Windows Updates');
    expect(screen.queryByText('Installed Windows Updates')).not.toBeNull();
    expect(screen.queryByText('Pending Third-Party Updates')).not.toBeNull();
    expect(screen.queryByText('Important')).not.toBeNull();
    expect(screen.queryByText('KB5050001')).not.toBeNull();
    expect(screen.queryByText('Reboot required')).not.toBeNull();
    expect(screen.queryAllByText(/Released/i).length).toBeGreaterThan(0);
    expect(screen.queryByText('Pending Apple Updates')).toBeNull();
    expect(fetchWithAuthMock).toHaveBeenCalledWith(`/devices/${deviceId}/patches`);
  });

  it('keeps Apple-specific patch sections for macOS devices', async () => {
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse({
        data: {
          compliancePercent: 100,
          pending: [
            {
              id: 'm-1',
              title: 'macOS Sonoma 14.7.1',
              source: 'apple',
              category: 'system',
              status: 'pending'
            }
          ],
          installed: [
            {
              id: 'm-2',
              title: 'XProtectPlistConfigData',
              source: 'apple',
              category: 'security',
              status: 'installed',
              installedAt: '2026-02-01T06:00:00.000Z'
            }
          ]
        }
      })
    );

    render(<DevicePatchStatusTab deviceId={deviceId} osType="macos" />);

    await screen.findByText('Pending Apple Updates');
    expect(screen.queryByText('Installed Apple Updates')).not.toBeNull();
    expect(screen.queryByText('Pending Windows Updates')).toBeNull();
  });

  it('queues OS scan with source for a Windows device', async () => {
    fetchWithAuthMock
      .mockResolvedValueOnce(
        makeJsonResponse({
          data: {
            compliancePercent: 70,
            pending: [],
            installed: []
          }
        })
      )
      .mockResolvedValueOnce(
        makeJsonResponse({
          queuedCommandIds: ['cmd-1'],
          jobId: 'scan-123'
        })
      );

    render(<DevicePatchStatusTab deviceId={deviceId} osType="windows" />);

    const button = await screen.findByRole('button', { name: 'Run OS patch scan' });
    fireEvent.click(button);

    await waitFor(() => {
      expect(fetchWithAuthMock).toHaveBeenNthCalledWith(
        2,
        '/patches/scan',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            deviceIds: [deviceId],
            source: 'microsoft'
          })
        })
      );
    });

    await screen.findByText(/Run Windows patch scan queued/i);
  });

  it('queues install for pending third-party patches', async () => {
    fetchWithAuthMock
      .mockResolvedValueOnce(
        makeJsonResponse({
          data: {
            compliancePercent: 10,
            pending: [
              {
                id: 'f0cfbd5f-6f8d-4682-9f52-bc37f8d6edbf',
                title: 'Google Chrome',
                externalId: 'third_party:Google Chrome:122.0.6261.57',
                description: 'installed: 121.0.6167.184',
                source: 'third_party',
                category: 'application',
                status: 'pending'
              }
            ],
            installed: []
          }
        })
      )
      .mockResolvedValueOnce(
        makeJsonResponse({
          success: true,
          commandId: 'cmd-install-1',
          patchCount: 1
        })
      );

    render(<DevicePatchStatusTab deviceId={deviceId} osType="macos" />);

    await screen.findByText('Installed 121.0.6167.184 -> 122.0.6261.57');
    await screen.findByText('Homebrew');

    const installButton = await screen.findByRole('button', { name: /Install 3rd-party patches \(1\)/i });
    fireEvent.click(installButton);

    await waitFor(() => {
      expect(fetchWithAuthMock).toHaveBeenNthCalledWith(
        2,
        `/devices/${deviceId}/patches/install`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            patchIds: ['f0cfbd5f-6f8d-4682-9f52-bc37f8d6edbf']
          })
        })
      );
    });

    await screen.findByText(/Install pending third-party patches queued/i);
  });

  it('disables install controls when there are no pending patches', async () => {
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse({
        data: {
          compliancePercent: 100,
          pending: [],
          installed: []
        }
      })
    );

    render(<DevicePatchStatusTab deviceId={deviceId} osType="linux" />);

    const installOsButton = await screen.findByRole('button', { name: /Install pending OS patches \(0\)/i });
    const installThirdPartyButton = await screen.findByRole('button', { name: /Install 3rd-party patches \(0\)/i });

    expect((installOsButton as HTMLButtonElement).disabled).toBe(true);
    expect((installThirdPartyButton as HTMLButtonElement).disabled).toBe(true);
  });

  it('excludes missing records from pending install counts', async () => {
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse({
        data: {
          compliancePercent: 100,
          pending: [],
          missing: [
            {
              id: '34d7275b-055d-4ca2-8f42-04c61f8513d1',
              title: 'Old package record',
              source: 'third_party',
              category: 'application',
              status: 'missing'
            }
          ],
          installed: [],
          patches: [
            {
              id: '34d7275b-055d-4ca2-8f42-04c61f8513d1',
              title: 'Old package record',
              source: 'third_party',
              category: 'application',
              status: 'missing'
            }
          ]
        }
      })
    );

    render(<DevicePatchStatusTab deviceId={deviceId} osType="macos" />);

    const installOsButton = await screen.findByRole('button', { name: /Install pending OS patches \(0\)/i });
    const installThirdPartyButton = await screen.findByRole('button', { name: /Install 3rd-party patches \(0\)/i });

    expect((installOsButton as HTMLButtonElement).disabled).toBe(true);
    expect((installThirdPartyButton as HTMLButtonElement).disabled).toBe(true);
    await screen.findByText(/1 stale missing records are excluded from pending install counts\./i);
  });
});
