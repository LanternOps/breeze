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
