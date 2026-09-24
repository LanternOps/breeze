import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DeviceAnomaliesPanel from './DeviceAnomaliesPanel';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn(), registerOrgIdProvider: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);
const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERROR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const flagsResponse = makeJsonResponse({
  mlFeatureFlags: {
    'ml.anomalies.enabled': { flag: 'ml.anomalies.enabled', enabled: true, defaultEnabled: false, source: 'org_settings' },
    'ml.remediation_suggestions.enabled': { flag: 'ml.remediation_suggestions.enabled', enabled: false, defaultEnabled: false, source: 'org_settings' },
    'ml.anomalies.v1_shadow.enabled': { flag: 'ml.anomalies.v1_shadow.enabled', enabled: false, defaultEnabled: false, source: 'org_settings' },
  },
});

function episode(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id, orgId: 'org-1', deviceId: 'dev-1', episodeKey: 'device_metrics:spike:cpu', sourceTable: 'device_metrics',
    anomalyType: 'spike', metricFamily: 'cpu', metricNames: ['cpu_percent'], status: 'open', closeReason: null,
    firstSeenAt: '2026-06-18T12:00:00.000Z', lastSeenAt: '2026-06-18T12:10:00.000Z', bucketCount: 2,
    peakValue: 96.4, peakMetricName: 'cpu_percent', peakBaselineValue: 42.2, peakScore: 8.1, peakAt: '2026-06-18T12:05:00.000Z',
    recurrenceCount: 0, attribution: null, linkedAlertId: null, snoozedUntil: null, resolvedAt: null, resolvedByUserId: null,
    note: null, createdAt: '2026-06-18T12:00:00.000Z', updatedAt: '2026-06-18T12:10:00.000Z',
    durationSeconds: 600, ongoing: true, promoted: false, snoozed: false, rangeMin: 90, rangeMax: 96.4,
    peakAnomalyId: `${id}-peak`, deviceLastSeenAt: null,
    ...overrides,
  };
}

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
}

describe('DeviceAnomaliesPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useOrgStore.setState({ currentOrgId: 'org-1' });
  });

  it('loads and renders open episodes by default', async () => {
    fetchWithAuthMock.mockImplementation((input) => {
      const url = String(input);
      if (url === '/config/ml-feature-flags') return Promise.resolve(flagsResponse);
      if (url === '/devices/dev-1/anomaly-episodes?status=open&limit=25') {
        return Promise.resolve(makeJsonResponse({ data: [episode('episode-1')], focusedEpisodeId: null }));
      }
      return Promise.resolve(makeJsonResponse({ error: `unexpected ${url}` }, false, 404));
    });

    render(<DeviceAnomaliesPanel deviceId="dev-1" />);

    // The panel's own heading key (deviceAnomaliesPanel.metricAnomalies,
    // pre-existing and reused by this rewrite) reads "Metric Anomalies", not
    // "Anomalies" as the plan's literal test assumed.
    expect(await screen.findByText('Metric Anomalies')).toBeTruthy();
    expect(await screen.findByTestId('anomaly-episode-episode-1')).toBeTruthy();
  });

  it('switches to the recently-closed filter', async () => {
    fetchWithAuthMock.mockImplementation((input) => {
      const url = String(input);
      if (url === '/config/ml-feature-flags') return Promise.resolve(flagsResponse);
      if (url === '/devices/dev-1/anomaly-episodes?status=open&limit=25') return Promise.resolve(makeJsonResponse({ data: [], focusedEpisodeId: null }));
      if (url === '/devices/dev-1/anomaly-episodes?status=closed&limit=1') return Promise.resolve(makeJsonResponse({ data: [], focusedEpisodeId: null }));
      if (url === '/devices/dev-1/anomaly-episodes?status=closed&limit=25') {
        return Promise.resolve(makeJsonResponse({ data: [episode('episode-2', { status: 'resolved', closeReason: 'cleared', ongoing: false })], focusedEpisodeId: null }));
      }
      return Promise.resolve(makeJsonResponse({ error: `unexpected ${url}` }, false, 404));
    });

    render(<DeviceAnomaliesPanel deviceId="dev-1" />);
    await screen.findByText('No open anomalies');
    fireEvent.click(screen.getByRole('button', { name: /recently closed/i }));
    expect(await screen.findByTestId('anomaly-episode-episode-2')).toBeTruthy();
  });

  it('empty state offers a "show recently closed" link when closed episodes exist', async () => {
    fetchWithAuthMock.mockImplementation((input) => {
      const url = String(input);
      if (url === '/config/ml-feature-flags') return Promise.resolve(flagsResponse);
      if (url === '/devices/dev-1/anomaly-episodes?status=open&limit=25') return Promise.resolve(makeJsonResponse({ data: [], focusedEpisodeId: null }));
      // "Recently closed" = W02's status=closed (resolved/dismissed in the last 7 days).
      if (url === '/devices/dev-1/anomaly-episodes?status=closed&limit=1') return Promise.resolve(makeJsonResponse({ data: [episode('episode-3', { status: 'resolved', closeReason: 'cleared', ongoing: false })], focusedEpisodeId: null }));
      return Promise.resolve(makeJsonResponse({ error: `unexpected ${url}` }, false, 404));
    });

    render(<DeviceAnomaliesPanel deviceId="dev-1" />);
    expect(await screen.findByRole('button', { name: /show recently closed/i })).toBeTruthy();
  });

  it('passes focusedAnomalyId through as ref (status=all) and rings the episode W02 resolved it to', async () => {
    // A legacy alert deep link carries a MEMBER anomaly id; W02 resolves it to
    // its episode and returns that as focusedEpisodeId (always data[0]).
    fetchWithAuthMock.mockImplementation((input) => {
      const url = String(input);
      if (url === '/config/ml-feature-flags') return Promise.resolve(flagsResponse);
      if (url === '/devices/dev-1/anomaly-episodes?status=all&limit=100&ref=anomaly-77') {
        return Promise.resolve(makeJsonResponse({
          data: [
            episode('episode-9', { promoted: true, linkedAlertId: 'alert-1' }),
            episode('episode-10'),
          ],
          focusedEpisodeId: 'episode-9',
        }));
      }
      return Promise.resolve(makeJsonResponse({ error: `unexpected ${url}` }, false, 404));
    });

    render(<DeviceAnomaliesPanel deviceId="dev-1" focusedAnomalyId="anomaly-77" />);
    expect(await screen.findByTestId('anomaly-episode-episode-9')).toHaveClass('ring-2');
    expect(screen.getByTestId('anomaly-episode-episode-10')).not.toHaveClass('ring-2');
    // The ref resolved, so the legacy fallback (A9) is never consulted.
    expect(fetchWithAuthMock).not.toHaveBeenCalledWith(expect.stringContaining('/anomalies?'));
  });

  it('an unknown ref rings nothing (focusedEpisodeId null)', async () => {
    fetchWithAuthMock.mockImplementation((input) => {
      const url = String(input);
      if (url === '/config/ml-feature-flags') return Promise.resolve(flagsResponse);
      if (url === '/devices/dev-1/anomaly-episodes?status=all&limit=100&ref=gone-1') {
        return Promise.resolve(makeJsonResponse({ data: [episode('episode-1')], focusedEpisodeId: null }));
      }
      return Promise.resolve(makeJsonResponse({ error: `unexpected ${url}` }, false, 404));
    });

    render(<DeviceAnomaliesPanel deviceId="dev-1" focusedAnomalyId="gone-1" />);
    expect(await screen.findByTestId('anomaly-episode-episode-1')).not.toHaveClass('ring-2');
    // A9 fallback was tried (legacy list 404s here) and renders nothing.
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledWith('/devices/dev-1/anomalies?status=all&limit=100'));
    expect(screen.queryByTestId('anomaly-legacy-detection')).toBeNull();
  });

  it('a ref that resolves to no episode shows the legacy detection read-only, with a note (A9)', async () => {
    fetchWithAuthMock.mockImplementation((input) => {
      const url = String(input);
      if (url === '/config/ml-feature-flags') return Promise.resolve(flagsResponse);
      if (url === '/devices/dev-1/anomaly-episodes?status=all&limit=100&ref=anomaly-old') {
        return Promise.resolve(makeJsonResponse({ data: [], focusedEpisodeId: null }));
      }
      if (url === '/devices/dev-1/anomalies?status=all&limit=100') {
        return Promise.resolve(makeJsonResponse({
          data: [
            { id: 'anomaly-other', metricName: 'ram_percent', anomalyType: 'spike', status: 'open', windowStart: '2026-06-01T09:00:00.000Z', windowEnd: '2026-06-01T09:05:00.000Z', observedValue: 91, baselineValue: 50 },
            { id: 'anomaly-old', metricName: 'cpu_percent', anomalyType: 'spike', status: 'promoted', windowStart: '2026-06-01T10:00:00.000Z', windowEnd: '2026-06-01T10:05:00.000Z', observedValue: 97, baselineValue: 40 },
          ],
        }));
      }
      return Promise.resolve(makeJsonResponse({ error: `unexpected ${url}` }, false, 404));
    });

    render(<DeviceAnomaliesPanel deviceId="dev-1" focusedAnomalyId="anomaly-old" />);

    const legacy = await screen.findByTestId('anomaly-legacy-detection');
    expect(legacy.textContent).toContain('This detection predates episode grouping.');
    expect(legacy.textContent).toContain('97.0%');
    expect(legacy.textContent).not.toContain('91.0%');
    expect(within(legacy).queryByRole('button')).toBeNull(); // read-only
  });

  it('polls every 60 s while an open episode is shown and the tab is visible; stops when hidden and on unmount (A9)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setVisibility('visible');
    const listUrl = '/devices/dev-1/anomaly-episodes?status=open&limit=25';
    try {
      fetchWithAuthMock.mockImplementation((input) => {
        const url = String(input);
        if (url === '/config/ml-feature-flags') return Promise.resolve(flagsResponse);
        if (url === listUrl) return Promise.resolve(makeJsonResponse({ data: [episode('episode-1')], focusedEpisodeId: null }));
        return Promise.resolve(makeJsonResponse({ error: `unexpected ${url}` }, false, 404));
      });
      const listCalls = () => fetchWithAuthMock.mock.calls.filter(([url]) => String(url) === listUrl).length;

      const { unmount } = render(<DeviceAnomaliesPanel deviceId="dev-1" />);
      await screen.findByTestId('anomaly-episode-episode-1');
      expect(listCalls()).toBe(1);

      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      expect(listCalls()).toBe(2);
      // Silent refresh: the card never gives way to the loading spinner.
      expect(screen.getByTestId('anomaly-episode-episode-1')).toBeTruthy();

      setVisibility('hidden');
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      expect(listCalls()).toBe(2);

      setVisibility('visible');
      unmount();
      await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
      expect(listCalls()).toBe(2);
    } finally {
      setVisibility('visible');
      vi.useRealTimers();
    }
  });

  it('does not poll when no open episode is shown (A9)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const listUrl = '/devices/dev-1/anomaly-episodes?status=open&limit=25';
    try {
      fetchWithAuthMock.mockImplementation((input) => {
        const url = String(input);
        if (url === '/config/ml-feature-flags') return Promise.resolve(flagsResponse);
        if (url === listUrl) return Promise.resolve(makeJsonResponse({ data: [], focusedEpisodeId: null }));
        if (url === '/devices/dev-1/anomaly-episodes?status=closed&limit=1') return Promise.resolve(makeJsonResponse({ data: [], focusedEpisodeId: null }));
        return Promise.resolve(makeJsonResponse({ error: `unexpected ${url}` }, false, 404));
      });
      render(<DeviceAnomaliesPanel deviceId="dev-1" />);
      await screen.findByText('No open anomalies');
      await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
      expect(fetchWithAuthMock.mock.calls.filter(([url]) => String(url) === listUrl)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('compact mode caps at 3 open episodes and fetches limit=3', async () => {
    fetchWithAuthMock.mockImplementation((input) => {
      const url = String(input);
      if (url === '/config/ml-feature-flags') return Promise.resolve(flagsResponse);
      if (url === '/devices/dev-1/anomaly-episodes?status=open&limit=3') {
        return Promise.resolve(makeJsonResponse({ data: [episode('e1'), episode('e2'), episode('e3'), episode('e4')], focusedEpisodeId: null }));
      }
      return Promise.resolve(makeJsonResponse({ error: `unexpected ${url}` }, false, 404));
    });

    render(<DeviceAnomaliesPanel deviceId="dev-1" compact />);
    await screen.findByTestId('anomaly-episode-e1');
    expect(screen.queryByTestId('anomaly-episode-e4')).toBeNull();
  });

  it('disabled state shows no episodes and skips the fetch', async () => {
    fetchWithAuthMock.mockImplementation((input) => {
      const url = String(input);
      if (url === '/config/ml-feature-flags') {
        return Promise.resolve(makeJsonResponse({
          mlFeatureFlags: { 'ml.anomalies.enabled': { flag: 'ml.anomalies.enabled', enabled: false, defaultEnabled: false, source: 'org_settings' } },
        }));
      }
      return Promise.resolve(makeJsonResponse({ error: `unexpected ${url}` }, false, 404));
    });

    render(<DeviceAnomaliesPanel deviceId="dev-1" />);
    await screen.findByText('Anomaly detection disabled');
    expect(fetchWithAuthMock).not.toHaveBeenCalledWith(expect.stringContaining('/anomaly-episodes'));
  });

  it('splices an updated episode out of the open list after a resolve', async () => {
    fetchWithAuthMock.mockImplementation((input, init) => {
      const url = String(input);
      if (url === '/config/ml-feature-flags') return Promise.resolve(flagsResponse);
      if (url === '/devices/dev-1/anomaly-episodes?status=open&limit=25') return Promise.resolve(makeJsonResponse({ data: [episode('episode-1')], focusedEpisodeId: null }));
      if (url === '/devices/dev-1/anomaly-episodes?status=closed&limit=1') return Promise.resolve(makeJsonResponse({ data: [], focusedEpisodeId: null }));
      if (url === '/devices/dev-1/anomaly-episodes/episode-1' && init?.method === 'PATCH') {
        return Promise.resolve(makeJsonResponse({
          data: episode('episode-1', { status: 'resolved', closeReason: 'user', ongoing: false }),
          meta: { alertId: null, alertResolved: false, labelledMembers: 2 },
        }));
      }
      return Promise.resolve(makeJsonResponse({ error: `unexpected ${url}` }, false, 404));
    });

    render(<DeviceAnomaliesPanel deviceId="dev-1" />);
    fireEvent.click(await screen.findByRole('button', { name: /^resolve$/i }));
    await waitFor(() => expect(screen.queryByTestId('anomaly-episode-episode-1')).toBeNull());
  });
  it('refetches the list when a card action returns 409 (episode already closed elsewhere)', async () => {
    let listCalls = 0;
    fetchWithAuthMock.mockImplementation((input, init) => {
      const url = String(input);
      if (url === '/config/ml-feature-flags') return Promise.resolve(flagsResponse);
      if (url === '/devices/dev-1/anomaly-episodes?status=open&limit=25') {
        listCalls += 1;
        // First load shows the episode; after the 409 the server no longer lists it.
        return Promise.resolve(makeJsonResponse({ data: listCalls === 1 ? [episode('episode-1')] : [], focusedEpisodeId: null }));
      }
      if (url === '/devices/dev-1/anomaly-episodes?status=closed&limit=1') return Promise.resolve(makeJsonResponse({ data: [], focusedEpisodeId: null }));
      if (url === '/devices/dev-1/anomaly-episodes/episode-1' && init?.method === 'PATCH') {
        return Promise.resolve(makeJsonResponse({ error: 'This anomaly has already closed', reason: 'episode_closed' }, false, 409));
      }
      return Promise.resolve(makeJsonResponse({ error: `unexpected ${url}` }, false, 404));
    });

    render(<DeviceAnomaliesPanel deviceId="dev-1" />);
    fireEvent.click(await screen.findByRole('button', { name: /^resolve$/i }));
    await waitFor(() => expect(screen.queryByTestId('anomaly-episode-episode-1')).toBeNull());
    expect(listCalls).toBe(2);
  });
});
