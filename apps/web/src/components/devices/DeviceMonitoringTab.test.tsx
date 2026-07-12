import '@/lib/i18n';

import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DeviceMonitoringTab from './DeviceMonitoringTab';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  registerOrgIdProvider: vi.fn(),
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

describe('DeviceMonitoringTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches the per-device summary and renders watch rows', async () => {
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse({
        data: [
          {
            id: 'r1',
            deviceId: 'dev-1',
            watchType: 'service',
            name: 'Print Spooler',
            status: 'stopped',
            cpuPercent: null,
            memoryMb: null,
            pid: null,
            timestamp: '2026-06-24T10:00:00.000Z',
          },
          {
            id: 'r2',
            deviceId: 'dev-1',
            watchType: 'process',
            name: 'nginx',
            status: 'running',
            cpuPercent: 2.5,
            memoryMb: 128,
            pid: 4242,
            timestamp: '2026-06-24T10:00:00.000Z',
          },
        ],
      })
    );

    render(<DeviceMonitoringTab deviceId="dev-1" />);

    await screen.findByText('Print Spooler');
    expect(fetchWithAuthMock).toHaveBeenCalledWith('/monitoring/results/dev-1/summary');
    expect(screen.getByText('nginx')).toBeInTheDocument();
    expect(screen.getByText('Stopped')).toBeInTheDocument();
    expect(screen.getByText('Running')).toBeInTheDocument();
    expect(screen.getAllByTestId('device-monitoring-row')).toHaveLength(2);
    // Non-running watch is surfaced first.
    expect(screen.getAllByTestId('device-monitoring-row')[0]).toHaveTextContent('Print Spooler');
  });

  it('renders an empty state when no results are reported', async () => {
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ data: [] }));

    render(<DeviceMonitoringTab deviceId="dev-1" />);

    expect(await screen.findByTestId('device-monitoring-empty')).toBeInTheDocument();
  });

  it('renders an error state when the request fails', async () => {
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({}, false, 500));

    render(<DeviceMonitoringTab deviceId="dev-1" />);

    await waitFor(() => {
      expect(screen.getByTestId('device-monitoring-error')).toBeInTheDocument();
    });
  });
});
