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

const anomalyFlags = (enabled: boolean) => ({
  mlFeatureFlags: {
    'ml.anomalies.enabled': {
      flag: 'ml.anomalies.enabled',
      enabled,
      defaultEnabled: false,
      source: 'org_settings',
    },
  },
});

describe('DeviceAnomaliesPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    showToast.mockReset();
  });

  it('renders open metric anomalies for a device', async () => {
    fetchWithAuthMock.mockImplementation((input) => {
      const url = String(input);
      if (url === '/config/ml-feature-flags') return Promise.resolve(makeJsonResponse(anomalyFlags(true)));
      if (url === '/devices/dev-1/anomalies?status=open&limit=25') {
        return Promise.resolve(makeJsonResponse({
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
        }));
      }
      return Promise.resolve(makeJsonResponse({ error: `unexpected ${url}` }, false, 404));
    });

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
    fetchWithAuthMock.mockImplementation((input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === '/config/ml-feature-flags') return Promise.resolve(makeJsonResponse(anomalyFlags(true)));
      if (url === '/devices/dev-1/anomalies?status=open&limit=5') {
        return Promise.resolve(makeJsonResponse({
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
        }));
      }
      if (url === '/devices/dev-1/anomalies/anomaly-1/status' && method === 'PATCH') {
        return Promise.resolve(makeJsonResponse({ data: { id: 'anomaly-1', status: 'dismissed' } }));
      }
      return Promise.resolve(makeJsonResponse({ error: `unexpected ${method} ${url}` }, false, 404));
    });

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

  it('keeps a link to the alert created from a promoted anomaly', async () => {
    fetchWithAuthMock.mockImplementation((input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === '/config/ml-feature-flags') return Promise.resolve(makeJsonResponse(anomalyFlags(true)));
      if (url === '/devices/dev-1/anomalies?status=open&limit=5') {
        return Promise.resolve(makeJsonResponse({
          data: [
            {
              id: 'anomaly-1',
              metricType: 'system',
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
        }));
      }
      if (url === '/devices/dev-1/anomalies/anomaly-1/status' && method === 'PATCH') {
        return Promise.resolve(makeJsonResponse({
          data: {
            id: 'anomaly-1',
            metricType: 'system',
            metricName: 'cpu_percent',
            anomalyType: 'spike',
            status: 'promoted',
            windowStart: '2026-06-18T12:00:00.000Z',
            windowEnd: '2026-06-18T12:05:00.000Z',
            observedValue: 96.4,
            baselineValue: 42.2,
            score: 8.1,
            confidence: 0.91,
            sampleCount: 5,
            linkedAlertId: 'alert-1',
            detectedAt: '2026-06-18T12:05:00.000Z',
          },
        }));
      }
      return Promise.resolve(makeJsonResponse({ error: `unexpected ${method} ${url}` }, false, 404));
    });

    render(<DeviceAnomaliesPanel deviceId="dev-1" compact />);

    const promote = await screen.findByRole('button', { name: /promote/i });
    fireEvent.click(promote);

    expect(await screen.findByText('Anomaly promoted to alert')).toBeTruthy();
    expect(screen.getByText('Spike on CPU')).toBeTruthy();
    expect(screen.getByRole('link', { name: /open alert/i })).toHaveAttribute('href', '/alerts/alert-1');
    expect(screen.queryByText('96.4%')).toBeNull();
  });

  it('loads all statuses and highlights a focused promoted anomaly', async () => {
    fetchWithAuthMock.mockImplementation((input) => {
      const url = String(input);
      if (url === '/config/ml-feature-flags') return Promise.resolve(makeJsonResponse(anomalyFlags(true)));
      if (url === '/devices/dev-1/anomalies?status=all&limit=100') {
        return Promise.resolve(makeJsonResponse({
          data: [
            {
              id: 'anomaly-1',
              metricType: 'system',
              metricName: 'cpu_percent',
              anomalyType: 'spike',
              status: 'promoted',
              windowStart: '2026-06-18T12:00:00.000Z',
              windowEnd: '2026-06-18T12:05:00.000Z',
              observedValue: 96.4,
              baselineValue: 42.2,
              score: 8.1,
              confidence: 0.91,
              sampleCount: 5,
              linkedAlertId: 'alert-1',
              detectedAt: '2026-06-18T12:05:00.000Z',
            },
          ],
        }));
      }
      return Promise.resolve(makeJsonResponse({ error: `unexpected ${url}` }, false, 404));
    });

    render(<DeviceAnomaliesPanel deviceId="dev-1" focusedAnomalyId="anomaly-1" />);

    const row = await screen.findByTestId('metric-anomaly-anomaly-1');
    expect(fetchWithAuthMock).toHaveBeenCalledWith('/devices/dev-1/anomalies?status=all&limit=100');
    expect(row).toHaveClass('border-primary/60');
    expect(screen.getByText('Linked from alert')).toBeTruthy();
    expect(screen.getByText('Promoted')).toBeTruthy();
    expect(screen.getByRole('link', { name: /open alert/i })).toHaveAttribute('href', '/alerts/alert-1');
    expect(screen.queryByRole('button', { name: /promote/i })).toBeNull();
  });

  it('renders process-sample anomaly metric labels', async () => {
    fetchWithAuthMock.mockImplementation((input) => {
      const url = String(input);
      if (url === '/config/ml-feature-flags') return Promise.resolve(makeJsonResponse(anomalyFlags(true)));
      if (url === '/devices/dev-1/anomalies?status=open&limit=25') {
        return Promise.resolve(makeJsonResponse({
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
        }));
      }
      return Promise.resolve(makeJsonResponse({ error: `unexpected ${url}` }, false, 404));
    });

    render(<DeviceAnomaliesPanel deviceId="dev-1" />);

    await screen.findByText('Network egress');
    expect(screen.getByText('Top process network I/O')).toBeTruthy();
    expect(screen.getByText('1.5 MB/s')).toBeTruthy();
    expect(screen.getByText('200.0 KB/s')).toBeTruthy();
  });

  it('warns when a promote succeeds without an alert link', async () => {
    fetchWithAuthMock.mockImplementation((input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === '/config/ml-feature-flags') return Promise.resolve(makeJsonResponse(anomalyFlags(true)));
      if (url === '/devices/dev-1/anomalies?status=open&limit=5') {
        return Promise.resolve(makeJsonResponse({
          data: [
            {
              id: 'anomaly-1',
              metricType: 'system',
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
        }));
      }
      if (url === '/devices/dev-1/anomalies/anomaly-1/status' && method === 'PATCH') {
        // Promote succeeds but the backend returns no linkedAlertId.
        return Promise.resolve(makeJsonResponse({
          data: { id: 'anomaly-1', status: 'promoted', linkedAlertId: null },
        }));
      }
      return Promise.resolve(makeJsonResponse({ error: `unexpected ${method} ${url}` }, false, 404));
    });

    render(<DeviceAnomaliesPanel deviceId="dev-1" compact />);

    fireEvent.click(await screen.findByRole('button', { name: /promote/i }));

    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
        type: 'warning',
        message: 'Anomaly promoted but no alert link returned',
      }));
    });
    // No "promoted to alert" success banner, and the row is gone.
    expect(screen.queryByText('Anomaly promoted to alert')).toBeNull();
    await waitFor(() => expect(screen.queryByText('Spike')).toBeNull());
  });

  it('toasts an error when a status update fails (non-2xx)', async () => {
    fetchWithAuthMock.mockImplementation((input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === '/config/ml-feature-flags') return Promise.resolve(makeJsonResponse(anomalyFlags(true)));
      if (url === '/devices/dev-1/anomalies?status=open&limit=5') {
        return Promise.resolve(makeJsonResponse({
          data: [
            {
              id: 'anomaly-1',
              metricType: 'system',
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
        }));
      }
      if (url === '/devices/dev-1/anomalies/anomaly-1/status' && method === 'PATCH') {
        return Promise.resolve(makeJsonResponse({ error: 'boom' }, false, 500));
      }
      return Promise.resolve(makeJsonResponse({ error: `unexpected ${method} ${url}` }, false, 404));
    });

    render(<DeviceAnomaliesPanel deviceId="dev-1" compact />);

    fireEvent.click(await screen.findByRole('button', { name: /dismiss/i }));

    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
    });
    // The row stays put because the mutation failed.
    expect(screen.getByText('Spike')).toBeTruthy();
  });

  it('renders an error state with a working Retry when the load fails', async () => {
    let attempt = 0;
    fetchWithAuthMock.mockImplementation((input) => {
      const url = String(input);
      if (url === '/config/ml-feature-flags') return Promise.resolve(makeJsonResponse(anomalyFlags(true)));
      if (url === '/devices/dev-1/anomalies?status=open&limit=25') {
        attempt += 1;
        if (attempt === 1) return Promise.resolve(makeJsonResponse({ error: 'down' }, false, 500));
        return Promise.resolve(makeJsonResponse({ data: [] }));
      }
      return Promise.resolve(makeJsonResponse({ error: `unexpected ${url}` }, false, 404));
    });

    render(<DeviceAnomaliesPanel deviceId="dev-1" />);

    expect(await screen.findByText('Failed to load metric anomalies')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));

    await screen.findByText('No open anomalies');
    expect(attempt).toBe(2);
  });

  it('labels the panel disabled and does not load anomalies when anomaly output is disabled', async () => {
    fetchWithAuthMock.mockImplementation((input) => {
      const url = String(input);
      if (url === '/config/ml-feature-flags') return Promise.resolve(makeJsonResponse(anomalyFlags(false)));
      return Promise.resolve(makeJsonResponse({ error: `unexpected ${url}` }, false, 404));
    });

    render(<DeviceAnomaliesPanel deviceId="dev-1" />);

    await screen.findByText('Anomaly detection disabled');
    expect(screen.getByText('Anomaly detection is disabled for this organization.')).toBeTruthy();
    expect(fetchWithAuthMock).not.toHaveBeenCalledWith('/devices/dev-1/anomalies?status=open&limit=25');
  });
});
