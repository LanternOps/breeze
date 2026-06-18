import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import AlertsPage from './AlertsPage';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn()
}));

const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (a: unknown) => showToast(a) }));

const navigateTo = vi.fn();
vi.mock('@/lib/navigation', () => ({ navigateTo: (...args: unknown[]) => navigateTo(...args) }));

// The device filter bar issues its own fetches; stub it out so the page's
// alert/device fetches are the only traffic under test.
vi.mock('../filters/DeviceFilterBar', () => ({
  DeviceFilterBar: () => null
}));

// Pin the org-scope selectors so the page doesn't try to read a real store.
vi.mock('../../stores/orgStore', () => ({
  useOrgStore: (selector: (s: { orgScope: string; currentOrgId: string | null }) => unknown) =>
    selector({ orgScope: 'current', currentOrgId: 'org-1' })
}));

const fetchMock = vi.mocked(fetchWithAuth);

const ALERT_ID = '5d4c3b2a-1111-4222-8333-444455556666';

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload)
  }) as unknown as Response;

const activeAlert = {
  id: ALERT_ID,
  title: 'High CPU on SRV-01',
  message: 'CPU above 95% for 5 minutes',
  severity: 'critical',
  status: 'active',
  deviceId: 'device-1',
  deviceName: 'SRV-01',
  triggeredAt: new Date().toISOString()
};

const remediationFlags = (enabled: boolean, alertCorrelationEnabled = true) => ({
  mlFeatureFlags: {
    'ml.alert_correlation.enabled': {
      flag: 'ml.alert_correlation.enabled',
      enabled: alertCorrelationEnabled,
      defaultEnabled: false,
      source: 'org_settings',
    },
    'ml.remediation_suggestions.enabled': {
      flag: 'ml.remediation_suggestions.enabled',
      enabled,
      defaultEnabled: false,
      source: 'org_settings',
    },
  },
});

/** A promise we can resolve from the test body to simulate a slow ack. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('AlertsPage — acknowledge in-flight feedback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows an in-flight spinner on the acked row while the request is pending, then a success toast', async () => {
    const ackDeferred = deferred<Response>();

    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === '/alerts' && method === 'GET') {
        return Promise.resolve(makeJsonResponse({ data: [activeAlert] }));
      }
      if (url === '/devices' && method === 'GET') {
        return Promise.resolve(makeJsonResponse({ data: [] }));
      }
      if (url === `/alerts/${ALERT_ID}/acknowledge` && method === 'POST') {
        // Deliberately do NOT resolve yet — this models the ~19s ack.
        return ackDeferred.promise;
      }
      return Promise.resolve(makeJsonResponse({ error: 'unexpected' }, false, 404));
    });

    render(<AlertsPage />);

    // Wait for the alert row to render.
    const ackButton = await screen.findByRole('button', { name: /Acknowledge: High CPU on SRV-01/i });
    const row = ackButton.closest('tr')!;

    // Click Ack — the request is now in flight (deferred, unresolved).
    fireEvent.click(ackButton);

    // While in flight, the row must surface a spinner and hide the action buttons.
    await waitFor(() => {
      expect(within(row).queryByRole('button', { name: /Acknowledge:/i })).not.toBeInTheDocument();
    });
    expect(row.querySelector('.animate-spin')).toBeInTheDocument();

    // No success toast yet — the request hasn't returned.
    expect(showToast).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));

    // Resolve the ack.
    ackDeferred.resolve(makeJsonResponse({ success: true }));

    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
    });
  });

  it('disables the AlertDetails Acknowledge button and shows a spinner while the request is pending', async () => {
    const ackDeferred = deferred<Response>();

    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === '/alerts' && method === 'GET') {
        return Promise.resolve(makeJsonResponse({ data: [activeAlert] }));
      }
      if (url === '/devices' && method === 'GET') {
        return Promise.resolve(makeJsonResponse({ data: [] }));
      }
      if (url === `/alerts/${ALERT_ID}` && method === 'GET') {
        // Detail-panel fetch (status/notification history).
        return Promise.resolve(makeJsonResponse({ statusHistory: [], notificationHistory: [] }));
      }
      if (url === '/config/ml-feature-flags' && method === 'GET') {
        return Promise.resolve(makeJsonResponse(remediationFlags(true)));
      }
      if (url === `/remediation-suggestions?sourceType=alert&sourceId=${ALERT_ID}&limit=5` && method === 'GET') {
        return Promise.resolve(makeJsonResponse({ data: [] }));
      }
      if (url === `/alerts/${ALERT_ID}/acknowledge` && method === 'POST') {
        return ackDeferred.promise;
      }
      return Promise.resolve(makeJsonResponse({ error: 'unexpected' }, false, 404));
    });

    render(<AlertsPage />);

    // Open the slide-over by clicking the row (the title cell).
    const titleCell = await screen.findByText('High CPU on SRV-01');
    fireEvent.click(titleCell);

    // The detail panel's Acknowledge button (full word, distinct from the row "Ack").
    const dialog = await screen.findByRole('dialog');
    const detailAck = within(dialog).getByRole('button', { name: /^Acknowledge$/i });
    expect(detailAck).not.toBeDisabled();

    fireEvent.click(detailAck);

    // In flight: button disabled + spinner present in the dialog footer.
    await waitFor(() => expect(detailAck).toBeDisabled());
    expect(dialog.querySelector('.animate-spin')).toBeInTheDocument();

    ackDeferred.resolve(makeJsonResponse({ success: true }));
    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
    });
  });

  it('loads and generates suggested fixes from the selected alert', async () => {
    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === '/alerts' && method === 'GET') {
        return Promise.resolve(makeJsonResponse({ data: [activeAlert] }));
      }
      if (url === '/devices' && method === 'GET') {
        return Promise.resolve(makeJsonResponse({ data: [] }));
      }
      if (url === `/alerts/${ALERT_ID}` && method === 'GET') {
        return Promise.resolve(makeJsonResponse({ statusHistory: [], notificationHistory: [] }));
      }
      if (url === '/config/ml-feature-flags' && method === 'GET') {
        return Promise.resolve(makeJsonResponse(remediationFlags(true)));
      }
      if (url === `/remediation-suggestions?sourceType=alert&sourceId=${ALERT_ID}&limit=5` && method === 'GET') {
        return Promise.resolve(makeJsonResponse({ data: [] }));
      }
      if (url === '/remediation-suggestions/generate' && method === 'POST') {
        return Promise.resolve(makeJsonResponse({ data: [] }));
      }
      return Promise.resolve(makeJsonResponse({ error: `unexpected ${method} ${url}` }, false, 404));
    });

    render(<AlertsPage />);

    fireEvent.click(await screen.findByText('High CPU on SRV-01'));

    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('Suggested Fixes');
    expect(fetchMock).toHaveBeenCalledWith(`/remediation-suggestions?sourceType=alert&sourceId=${ALERT_ID}&limit=5`);

    fireEvent.click(within(dialog).getByRole('button', { name: /^Generate$/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/remediation-suggestions/generate',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ sourceType: 'alert', sourceId: ALERT_ID, limit: 3 }),
        }),
      );
    });
  });

  it('surfaces an error toast when the acknowledge request fails', async () => {
    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === '/alerts' && method === 'GET') {
        return Promise.resolve(makeJsonResponse({ data: [activeAlert] }));
      }
      if (url === '/devices' && method === 'GET') {
        return Promise.resolve(makeJsonResponse({ data: [] }));
      }
      if (url === `/alerts/${ALERT_ID}/acknowledge` && method === 'POST') {
        return Promise.resolve(makeJsonResponse({ error: 'boom' }, false, 500));
      }
      return Promise.resolve(makeJsonResponse({ error: 'unexpected' }, false, 404));
    });

    render(<AlertsPage />);
    const ackButton = await screen.findByRole('button', { name: /Acknowledge: High CPU on SRV-01/i });
    fireEvent.click(ackButton);

    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
    });
    expect(showToast).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it('shows grouped incident count and noise reduction in the alert list', async () => {
    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === '/alerts' && method === 'GET') {
        return Promise.resolve(makeJsonResponse({
          data: [{
            ...activeAlert,
            deviceName: undefined,
            deviceHostname: 'SRV-01',
            correlationGroupId: '6f5e4d3c-2222-4333-8444-555566667777',
            correlationRole: 'root',
            correlationGroupStatus: 'open',
            correlationMemberCount: 4,
            correlationChildCount: 3,
            noiseReductionPercent: 75,
          }]
        }));
      }
      if (url === '/devices' && method === 'GET') {
        return Promise.resolve(makeJsonResponse({ data: [] }));
      }
      return Promise.resolve(makeJsonResponse({ error: 'unexpected' }, false, 404));
    });

    render(<AlertsPage />);

    expect(await screen.findByText('Grouped incident: 3 related · 75% noise cut')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /SRV-01/i })).toHaveAttribute('href', '/devices/device-1');
  });

  it('labels grouped incidents without linking when alert correlation is disabled', async () => {
    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === '/config/ml-feature-flags' && method === 'GET') {
        return Promise.resolve(makeJsonResponse(remediationFlags(true, false)));
      }
      if (url === '/alerts' && method === 'GET') {
        return Promise.resolve(makeJsonResponse({
          data: [{
            ...activeAlert,
            correlationGroupId: '6f5e4d3c-2222-4333-8444-555566667777',
            correlationRole: 'root',
            correlationGroupStatus: 'open',
            correlationMemberCount: 4,
            correlationChildCount: 3,
            noiseReductionPercent: 75,
          }]
        }));
      }
      if (url === '/devices' && method === 'GET') {
        return Promise.resolve(makeJsonResponse({ data: [] }));
      }
      return Promise.resolve(makeJsonResponse({ error: `unexpected ${method} ${url}` }, false, 404));
    });

    render(<AlertsPage />);

    const disabledBadge = (await screen.findByText('Grouped incident unavailable: alert correlation disabled')).closest('[aria-disabled]');
    expect(disabledBadge).toHaveAttribute('aria-disabled', 'true');
    expect(screen.queryByRole('link', { name: /Grouped incident/i })).toBeNull();
  });

  it('renders promoted metric anomaly context in the alert list and details panel', async () => {
    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === '/alerts' && method === 'GET') {
        return Promise.resolve(makeJsonResponse({
          data: [{
            ...activeAlert,
            context: {
              source: 'metric_anomaly',
              anomalyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
              metricName: 'cpu.usage',
              metricType: 'gauge',
              anomalyType: 'spike',
              observedValue: 97.3,
              baselineValue: 42.1,
              confidence: 0.92,
              score: 8.4,
              modelVersion: 'rollup-v0',
            },
          }]
        }));
      }
      if (url === '/devices' && method === 'GET') {
        return Promise.resolve(makeJsonResponse({ data: [] }));
      }
      if (url === `/alerts/${ALERT_ID}` && method === 'GET') {
        return Promise.resolve(makeJsonResponse({ statusHistory: [], notificationHistory: [] }));
      }
      if (url === '/config/ml-feature-flags' && method === 'GET') {
        return Promise.resolve(makeJsonResponse(remediationFlags(true)));
      }
      if (url === `/remediation-suggestions?sourceType=alert&sourceId=${ALERT_ID}&limit=5` && method === 'GET') {
        return Promise.resolve(makeJsonResponse({ data: [] }));
      }
      return Promise.resolve(makeJsonResponse({ error: `unexpected ${method} ${url}` }, false, 404));
    });

    render(<AlertsPage />);

    expect(await screen.findByText('ML anomaly: cpu.usage · spike · 92%')).toBeInTheDocument();

    fireEvent.click(screen.getByText('High CPU on SRV-01'));
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).getByText('ML Anomaly Evidence')).toBeInTheDocument();
    expect(within(dialog).getByText('cpu.usage')).toBeInTheDocument();
    expect(within(dialog).getByText('spike')).toBeInTheDocument();
    expect(within(dialog).getByText('97.30')).toBeInTheDocument();
    expect(within(dialog).getByText('42.10')).toBeInTheDocument();
    expect(within(dialog).getByText('92%')).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: /Open device anomalies/i })).toHaveAttribute(
      'href',
      '/devices/device-1#anomalies/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    );
  });
});
