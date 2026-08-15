import { fireEvent, render, screen, within } from '@testing-library/react';
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

/**
 * A 200 whose body is not JSON — what a proxy error page or a truncated
 * response looks like to the page. `json()` rejects the way `fetch` would.
 */
const unparseableResponse = (body = '<html><body>502 Bad Gateway</body></html>'): Response =>
  ({
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => body,
    json: async () => {
      throw new SyntaxError('Unexpected token <');
    }
  }) as unknown as Response;

const CURRENT_METRICS = {
  data: {
    uptime: 99.5,
    remoteSessions: 3,
    sessions: 3,
    devices: { total: 10, online: 9, offline: 1, pending: 0 },
    business_metrics: { devices_total: 10, devices_active: 9, devices_pending: 0 }
  }
};

const TRENDS_PAYLOAD = {
  data: [
    { timestamp: '2026-07-01T00:00:00.000Z', cpu: 41, memory: 62 },
    { timestamp: '2026-07-02T00:00:00.000Z', cpu: 44, memory: 65 }
  ]
};

/**
 * Routes every request to a healthy default, so each test overrides exactly the
 * one source it is about and any error banner names that source alone.
 *
 * Overrides are matched longest-prefix-first: `/analytics/sla/{id}/compliance`
 * has to be able to fail while `/analytics/sla` still serves the listing.
 */
const routeFetch = (overrides: Record<string, () => Response> = {}) => {
  const ordered = Object.entries(overrides).sort(([a], [b]) => b.length - a.length);

  fetchMock.mockImplementation(async (input: unknown) => {
    const url = String(input);

    for (const [prefix, respond] of ordered) {
      if (url.startsWith(prefix)) return respond();
    }

    if (url.startsWith('/metrics/trends')) return jsonResponse(TRENDS_PAYLOAD);
    if (url.startsWith('/metrics')) return jsonResponse(CURRENT_METRICS);
    if (url.startsWith('/analytics/os-distribution')) {
      return jsonResponse({ data: [{ name: 'Windows 11', value: 7 }] });
    }
    if (url.startsWith('/alerts/summary')) {
      return jsonResponse({ data: { bySeverity: { critical: 1, high: 2, medium: 0, low: 0 } } });
    }
    if (url.startsWith('/devices')) return jsonResponse({ data: [{ id: 'device-1' }] });
    return jsonResponse({});
  });
};

/**
 * The "Updated <time>" stamp is set only after every analytics request has
 * settled, so anchoring on it guarantees the overridden response has already
 * been applied when the callers assert below.
 */
const waitForLoadedPage = async () => {
  await screen.findByText(/^Updated /);
  expect(screen.getByText('99.50%')).toBeInTheDocument();
};

const openSlaTab = () => {
  fireEvent.click(screen.getByRole('tab', { name: 'SLA Compliance' }));
};

beforeEach(() => {
  vi.clearAllMocks();
  // `selectDashboard` writes the tab into the hash, which would otherwise
  // survive into the next test and open it on the wrong dashboard.
  window.location.hash = '';
});

describe('AnalyticsPage load failures', () => {
  it('reports a 200 with an unparseable body instead of rendering it as an empty card', async () => {
    routeFetch({ '/alerts/summary': () => unparseableResponse() });

    render(<AnalyticsPage />);
    await waitForLoadedPage();

    expect(screen.getByText('Unable to load: alerts')).toBeInTheDocument();
  });

  it('reports a failed device list instead of silently reading as an empty fleet', async () => {
    routeFetch({
      '/devices': () => jsonResponse({ error: 'boom' }, { status: 500, statusText: 'Server Error' })
    });

    render(<AnalyticsPage />);
    await waitForLoadedPage();

    // An empty `deviceIds` is indistinguishable from "no devices selected" in
    // the explorer, so the failure has to reach the banner.
    expect(screen.getByText('Unable to load: devices')).toBeInTheDocument();
  });

  it('keeps the figure from the SLA listing when the live compliance call fails', async () => {
    routeFetch({
      '/analytics/sla': () =>
        jsonResponse({ data: [{ id: 'sla-1', compliancePercentage: 99.9, uptimeTarget: 99.5 }] }),
      '/analytics/sla/': () => jsonResponse({ error: 'boom' }, { status: 500, statusText: 'Server Error' })
    });

    render(<AnalyticsPage />);
    await waitForLoadedPage();
    openSlaTab();

    // The listing already carried a number, so the card stays populated and the
    // best-effort live lookup failing is not a page error.
    expect(screen.getByText('99.90%')).toBeInTheDocument();
    expect(screen.queryByText(/Unable to load/)).not.toBeInTheDocument();
  });

  it('reports SLA as a failure when a definition exists but no figure could be loaded', async () => {
    routeFetch({
      '/analytics/sla': () => jsonResponse({ data: [{ id: 'sla-1', uptimeTarget: 99.5 }] }),
      '/analytics/sla/': () => jsonResponse({ error: 'boom' }, { status: 500, statusText: 'Server Error' })
    });

    render(<AnalyticsPage />);
    await waitForLoadedPage();

    // Neither source produced a figure. That is a load failure, not the
    // "no SLA configured" empty state.
    expect(screen.getByText('Unable to load: sla')).toBeInTheDocument();

    openSlaTab();
    // Several cards on this tab render the same empty-state text, so scope the
    // assertion to the SLA card itself.
    const slaCard = screen.getByRole('heading', { name: 'SLA Compliance' }).closest('.rounded-lg');
    expect(slaCard).not.toBeNull();
    expect(within(slaCard as HTMLElement).getByText('No data available')).toBeInTheDocument();
  });
});
