import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DeviceAnomaliesPanel from './DeviceAnomaliesPanel';
import { fetchWithAuth } from '../../stores/auth';

const showToast = vi.fn();

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

vi.mock('../shared/Toast', () => ({
  showToast: (input: unknown) => showToast(input),
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

describe('DeviceAnomaliesPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    showToast.mockReset();
  });

  it('renders open metric anomalies for a device', async () => {
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse({
        data: [
          {
            id: 'anomaly-1',
            metricType: 'cpu',
            metricName: 'cpu_percent',
            anomalyType: 'spike',
            status: 'open',
            windowStart: '2026-06-18T12:00:00.000Z',
            windowEnd: '2026-06-18T12:05:00.000Z',
            observedValue: 96.4,
            baselineValue: 42.2,
            score: 8.1,
            confidence: 0.91,
            sampleCount: 5,
            linkedAlertId: null,
            detectedAt: '2026-06-18T12:05:00.000Z',
          },
        ],
      }),
    );

    render(<DeviceAnomaliesPanel deviceId="dev-1" />);

    await screen.findByText('Metric Anomalies');
    expect(screen.getByText('Spike')).toBeTruthy();
    expect(screen.getByText('CPU')).toBeTruthy();
    expect(screen.getByText('96.4%')).toBeTruthy();
    expect(screen.getByText('42.2%')).toBeTruthy();
    expect(screen.getAllByText('91%').length).toBeGreaterThanOrEqual(1);
    expect(fetchWithAuthMock).toHaveBeenCalledWith('/devices/dev-1/anomalies?status=open&limit=25');
  });

  it('uses runAction for status updates and removes the updated row', async () => {
    fetchWithAuthMock
      .mockResolvedValueOnce(
        makeJsonResponse({
          data: [
            {
              id: 'anomaly-1',
              metricType: 'network',
              metricName: 'bandwidth_out_bps',
              anomalyType: 'network_egress',
              status: 'open',
              windowStart: '2026-06-18T12:00:00.000Z',
              windowEnd: '2026-06-18T12:05:00.000Z',
              observedValue: 1250000,
              baselineValue: 100000,
              score: 7,
              confidence: 0.88,
              sampleCount: 5,
              linkedAlertId: null,
              detectedAt: '2026-06-18T12:05:00.000Z',
            },
          ],
        }),
      )
      .mockResolvedValueOnce(makeJsonResponse({ data: { id: 'anomaly-1', status: 'dismissed' } }));

    render(<DeviceAnomaliesPanel deviceId="dev-1" compact />);

    const dismiss = await screen.findByRole('button', { name: /dismiss/i });
    fireEvent.click(dismiss);

    await waitFor(() => {
      expect(fetchWithAuthMock).toHaveBeenCalledWith(
        '/devices/dev-1/anomalies/anomaly-1/status',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ status: 'dismissed' }),
        }),
      );
    });
    await waitFor(() => expect(screen.queryByText('Network egress')).toBeNull());
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', message: 'Anomaly dismissed' }));
  });

  it('renders process-sample anomaly metric labels', async () => {
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse({
        data: [
          {
            id: 'anomaly-process-1',
            metricType: 'process',
            metricName: 'top_process_net_bps_sum',
            anomalyType: 'network_egress',
            status: 'open',
            windowStart: '2026-06-18T12:00:00.000Z',
            windowEnd: '2026-06-18T12:05:00.000Z',
            observedValue: 1500000,
            baselineValue: 200000,
            score: 8.2,
            confidence: 0.93,
            sampleCount: 3,
            linkedAlertId: null,
            detectedAt: '2026-06-18T12:05:00.000Z',
          },
        ],
      }),
    );

    render(<DeviceAnomaliesPanel deviceId="dev-1" />);

    await screen.findByText('Network egress');
    expect(screen.getByText('Top process network I/O')).toBeTruthy();
    expect(screen.getByText('1.5 MB/s')).toBeTruthy();
    expect(screen.getByText('200.0 KB/s')).toBeTruthy();
  });
});
