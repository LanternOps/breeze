import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import AnalyticsPage from './AnalyticsPage';
import { fetchWithAuth } from '../../stores/auth';

// `AnalyticsPage`, `QueryBuilder` and `DashboardGrid` all read the API through
// this one helper, so mocking it here controls every request the page makes.
vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));

const fetchMock = vi.mocked(fetchWithAuth);

// jsdom has no ResizeObserver; recharts' ResponsiveContainer (executive summary
// trend line, performance chart, OS pie) constructs one as soon as it mounts.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;

const jsonResponse = (
  payload: unknown,
  init: { status?: number; statusText?: string } = {}
): Response => {
  const status = init.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: init.statusText ?? (status === 200 ? 'OK' : 'Error'),
    text: async () => JSON.stringify(payload),
    json: async () => payload
  } as unknown as Response;
};

/** Shape returned by `GET /metrics` for a caller who can see current metrics. */
const CURRENT_METRICS = {
  data: {
    uptime: 99.5,
    remoteSessions: 3,
    sessions: 3,
    devices: { total: 10, online: 9, offline: 1, pending: 0 },
    business_metrics: { devices_total: 10, devices_active: 9, devices_pending: 0 }
  }
};

/** Shape returned by `GET /metrics/trends` for an unrestricted caller. */
const TRENDS_PAYLOAD = {
  data: [
    { timestamp: '2026-07-01T00:00:00.000Z', cpu: 41, memory: 62 },
    { timestamp: '2026-07-02T00:00:00.000Z', cpu: 44, memory: 65 }
  ]
};

/**
 * The exact body `GET /metrics/trends` returns for a site-restricted caller
 * (apps/api/src/routes/metrics.ts). `metric_rollups` has no site axis, so the
 * API denies the aggregate outright rather than leaking org-wide numbers.
 */
const SITE_SCOPED_DENIAL = {
  error: 'Trend metrics are unavailable for site-restricted users',
  code: 'SITE_SCOPED_TRENDS_UNAVAILABLE'
};

const routeFetch = (trendsResponse: () => Response) => {
  fetchMock.mockImplementation(async (input: unknown) => {
    const url = String(input);
    if (url.startsWith('/metrics/trends')) return trendsResponse();
    if (url.startsWith('/metrics')) return jsonResponse(CURRENT_METRICS);
    if (url.startsWith('/analytics/os-distribution')) {
      return jsonResponse({ data: [{ name: 'Windows 11', value: 7 }] });
    }
    if (url.startsWith('/alerts/summary')) {
      return jsonResponse({ data: { bySeverity: { critical: 1, high: 2, medium: 0, low: 0 } } });
    }
    return jsonResponse({});
  });
};

/**
 * Waits for the page to finish loading, then asserts the current-metric cards
 * rendered real values. The "Updated <time>" stamp is set only after every
 * analytics request has settled, so anchoring on it guarantees the trends
 * response has already been applied when the callers assert below.
 */
const waitForLoadedPage = async () => {
  await screen.findByText(/^Updated /);
  expect(screen.getByText('Fleet uptime')).toBeInTheDocument();
  expect(screen.getByText('Sessions in range')).toBeInTheDocument();
  expect(screen.getByText('99.50%')).toBeInTheDocument();
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AnalyticsPage site-scoped trends', () => {
  it('renders current-metric cards without the performance card or an error banner when trends are denied', async () => {
    routeFetch(() => jsonResponse(SITE_SCOPED_DENIAL, { status: 403, statusText: 'Forbidden' }));

    render(<AnalyticsPage />);
    await waitForLoadedPage();

    // The one card backed by /metrics/trends is omitted...
    expect(screen.queryByText('Performance Trend')).not.toBeInTheDocument();
    expect(screen.queryByText('CPU and memory utilization')).not.toBeInTheDocument();

    // ...and the expected denial is not reported as a page-wide failure.
    expect(screen.queryByText(/Unable to load/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Failed to load analytics data/)).not.toBeInTheDocument();

    // Every other card still renders.
    expect(screen.getByText('OS Distribution')).toBeInTheDocument();
    expect(screen.getByText('Alert Statistics')).toBeInTheDocument();
    expect(screen.getByText('Policy Compliance')).toBeInTheDocument();
  });

  it('renders the performance card for an unrestricted caller', async () => {
    routeFetch(() => jsonResponse(TRENDS_PAYLOAD));

    render(<AnalyticsPage />);
    await waitForLoadedPage();

    expect(screen.getByText('Performance Trend')).toBeInTheDocument();
    expect(screen.getByText('CPU and memory utilization')).toBeInTheDocument();
    expect(screen.queryByText(/Unable to load/)).not.toBeInTheDocument();
  });

  it('still surfaces an error banner when trends fail for any other reason', async () => {
    routeFetch(() => jsonResponse({ error: 'boom' }, { status: 500, statusText: 'Server Error' }));

    render(<AnalyticsPage />);
    await waitForLoadedPage();

    expect(screen.getByText('Unable to load: performance')).toBeInTheDocument();
    // A generic failure is not an authorization denial: the card stays put.
    expect(screen.getByText('Performance Trend')).toBeInTheDocument();
  });

  it('treats a 403 with a different code as an ordinary failure', async () => {
    routeFetch(() =>
      jsonResponse({ error: 'Forbidden', code: 'SOME_OTHER_CODE' }, { status: 403, statusText: 'Forbidden' })
    );

    render(<AnalyticsPage />);
    await waitForLoadedPage();

    expect(screen.getByText('Unable to load: performance')).toBeInTheDocument();
    expect(screen.getByText('Performance Trend')).toBeInTheDocument();
  });
});
