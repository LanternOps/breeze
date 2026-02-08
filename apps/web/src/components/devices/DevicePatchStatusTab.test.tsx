import { render, screen } from '@testing-library/react';
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
              status: 'pending'
            },
            {
              id: 'p-2',
              title: 'Google Chrome',
              source: 'third_party',
              category: 'application',
              status: 'pending'
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
});
