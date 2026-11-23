/**
 * #12324 — every Alerts-page filter goes to GET /alerts, and the page shows
 * what the server returned. The page used to fetch the newest 50 alerts and
 * filter them in the browser, so in the All-organizations view a device's
 * current alerts could sit behind newer alerts from other orgs and never show.
 *
 * These tests are fetch-mocked, so they prove the WIRE (which params go out,
 * which response fields are read). That the API applies them is proved in
 * apps/api/src/__tests__/integration/alertsListServerFilters.integration.test.ts.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import AlertsPage from './AlertsPage';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: (select: (state: { user: { canManagePartnerWide: boolean } }) => unknown) => select({ user: { canManagePartnerWide: true } }),
}));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

const DEVICE_FILTER = { operator: 'AND', conditions: [{ field: 'hostname', operator: 'equals', value: 'target-host' }] };
vi.mock('../filters/DeviceFilterBar', () => ({
  DeviceFilterBar: ({ onChange }: { onChange: (filter: unknown) => void }) => (
    <button data-testid="apply-device-filter" onClick={() => onChange(DEVICE_FILTER)}>Apply</button>
  ),
}));

// All-organizations view by default (no current org, fleet toggle on); a test
// can pin one org instead.
let mockCurrentOrgId: string | null = null;
vi.mock('../../stores/orgStore', () => ({
  useOrgStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ orgScope: mockCurrentOrgId ? 'current' : 'all', currentOrgId: mockCurrentOrgId, allOrgs: !mockCurrentOrgId, error: null, organizationsLoaded: true, organizations: [] }),
}));

const fetchMock = vi.mocked(fetchWithAuth);

const json = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERROR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const alertRow = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
  id, title, message: `${title} message`, severity: 'low', status: 'active',
  deviceId: `device-${id}`, deviceHostname: `host-${id}`, orgId: 'org-a', orgName: 'Org A',
  triggeredAt: new Date().toISOString(), ...extra,
});

const NOISE = Array.from({ length: 25 }, (_, i) => alertRow(`noise-${i}`, `Noise ${i}`));
const TARGET = alertRow('target', 'Disk almost full', {
  severity: 'critical', deviceId: 'target-device', deviceHostname: 'target-host', orgId: 'org-b', orgName: 'Org B',
  triggeredAt: new Date(Date.now() - 48 * 3600 * 1000).toISOString(),
});

function alertsCalls(): URLSearchParams[] {
  return fetchMock.mock.calls
    .map(([url, init]) => ({ url: String(url), method: (init as RequestInit | undefined)?.method ?? 'GET' }))
    .filter(({ url, method }) => method === 'GET' && url.startsWith('/alerts?'))
    .map(({ url }) => new URLSearchParams(url.slice('/alerts?'.length)));
}
const lastAlertsCall = () => alertsCalls().at(-1)!;

type Handler = (params: URLSearchParams) => { data: unknown[]; total: number } | Response;
function mockApi(handler: Handler, summary: unknown = { openBySeverity: { critical: 7, high: 0, medium: 2, low: 40, info: 0 } }) {
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (method === 'GET' && url.startsWith('/alerts?')) {
      const params = new URLSearchParams(url.slice('/alerts?'.length));
      const result = handler(params);
      if (result instanceof Object && 'ok' in result) return result as Response;
      const { data, total } = result as { data: unknown[]; total: number };
      return json({ data, pagination: { page: Number(params.get('page') ?? 1), limit: Number(params.get('limit') ?? 50), total } });
    }
    if (method === 'GET' && url === '/alerts/summary') return json(summary);
    if (url === '/filters/preview') throw new Error('the page must not resolve the device filter itself any more');
    return json({ data: [] });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  window.location.hash = '';
  mockCurrentOrgId = null;
});

describe('AlertsPage server-side filters (#12324)', () => {
  it('sends the device filter to GET /alerts and shows the older alert the server returns', async () => {
    mockApi((params) => params.get('deviceFilter')
      ? { data: [TARGET], total: 1 }
      : { data: NOISE, total: 60 });
    render(<AlertsPage />);
    await screen.findByText('Noise 0');

    fireEvent.click(screen.getByTestId('apply-device-filter'));

    expect(await screen.findByText('Disk almost full')).toBeInTheDocument();
    expect(screen.queryByText('Noise 0')).not.toBeInTheDocument();
    expect(JSON.parse(lastAlertsCall().get('deviceFilter')!)).toEqual(DEVICE_FILTER);
    expect(fetchMock.mock.calls.some(([url]) => String(url) === '/filters/preview')).toBe(false);
    expect(screen.getByTestId('alert-list-count')).toHaveAttribute('data-total', '1');
  });

  it('asks for one page of 25 and pages with the server total', async () => {
    mockApi((params) => ({
      data: params.get('page') === '2' ? [alertRow('p2', 'Second page row')] : NOISE,
      total: 26,
    }));
    render(<AlertsPage />);
    await screen.findByText('Noise 0');
    expect(lastAlertsCall().get('limit')).toBe('25');
    expect(lastAlertsCall().get('page')).toBe('1');
    // "All Status" leaves status to the server, whose default hides dismissed.
    expect(lastAlertsCall().has('status')).toBe(false);
    expect(screen.getByTestId('alert-list-count')).toHaveAttribute('data-total', '26');
    expect(screen.getByText(/1–25 of 26/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));

    expect(await screen.findByText('Second page row')).toBeInTheDocument();
    expect(lastAlertsCall().get('page')).toBe('2');
    expect(screen.getByText(/26–26 of 26/)).toBeInTheDocument();
  });

  it('sends status, severity, date range and a debounced search, resetting to page 1', async () => {
    window.location.hash = '#severity=critical,high';
    mockApi((params) => ({
      data: params.get('status') === 'resolved' ? [alertRow('r', 'Resolved row', { status: 'resolved' })] : NOISE,
      total: 30,
    }));
    render(<AlertsPage />);
    await screen.findByText('Noise 0');
    await waitFor(() => expect(lastAlertsCall().get('severity')).toBe('critical,high'));

    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(lastAlertsCall().get('page')).toBe('2'));

    fireEvent.click(screen.getByRole('button', { name: /Filters/i }));
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'resolved' } });
    expect(await screen.findByText('Resolved row')).toBeInTheDocument();
    expect(lastAlertsCall().get('status')).toBe('resolved');
    expect(lastAlertsCall().get('page')).toBe('1');

    const before = Date.now();
    fireEvent.change(screen.getByLabelText('Date range'), { target: { value: '24h' } });
    await waitFor(() => expect(lastAlertsCall().has('startDate')).toBe(true));
    const startDate = Date.parse(lastAlertsCall().get('startDate')!);
    expect(Math.abs(before - 24 * 3600 * 1000 - startDate)).toBeLessThan(5000);

    const callsBeforeSearch = alertsCalls().length;
    fireEvent.change(screen.getByPlaceholderText('Search alerts...'), { target: { value: 'disk' } });
    // Debounced: typing does not refetch on every keystroke.
    expect(alertsCalls().length).toBe(callsBeforeSearch);
    await waitFor(() => expect(lastAlertsCall().get('search')).toBe('disk'));
  });

  it('keeps the filters on screen when a filtered page is empty instead of claiming all clear', async () => {
    mockApi((params) => params.get('deviceFilter') ? { data: [], total: 0 } : { data: NOISE, total: 60 });
    render(<AlertsPage />);
    await screen.findByText('Noise 0');
    fireEvent.click(screen.getByTestId('apply-device-filter'));
    expect(await screen.findByText('No alerts match your filters.')).toBeInTheDocument();
    expect(screen.queryByText('All clear')).not.toBeInTheDocument();
    expect(screen.getByTestId('apply-device-filter')).toBeInTheDocument();
  });

  it('a failed filtered fetch hides the previous rows, blocks actions and retries', async () => {
    let fail = true;
    mockApi((params) => {
      if (params.get('deviceFilter')) return fail ? json({ error: 'nope' }, false, 503) : { data: [TARGET], total: 1 };
      return { data: NOISE, total: 60 };
    });
    render(<AlertsPage />);
    await screen.findByText('Noise 0');
    fireEvent.click(screen.getByTestId('apply-device-filter'));
    await screen.findByTestId('alert-device-filter-error');
    expect(screen.queryByText('Noise 0')).not.toBeInTheDocument();
    fail = false;
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
    expect(await screen.findByText('Disk almost full')).toBeInTheDocument();
  });

  it('a #<alertId> link to an alert that is not on the loaded page opens it by id', async () => {
    const OLD_ID = '9a8b7c6d-1111-4222-8333-444455556666';
    window.location.hash = OLD_ID;
    mockApi(() => ({ data: NOISE, total: 60 }));
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input) === `/alerts/${OLD_ID}`) {
        return json({ ...alertRow(OLD_ID, 'Old linked alert'), id: OLD_ID, device: { hostname: 'old-host' }, notifications: [] });
      }
      return base(input, init);
    });
    render(<AlertsPage />);
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Old linked alert');
  });

  it('with one org selected, a #<alertId> link to another org\'s alert does not open it', async () => {
    mockCurrentOrgId = 'org-a';
    const OTHER_ID = '7b6a5c4d-1111-4222-8333-444455556666';
    window.location.hash = OTHER_ID;
    mockApi(() => ({ data: NOISE, total: 60 }));
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input) === `/alerts/${OTHER_ID}`) {
        return json({ ...alertRow(OTHER_ID, 'Other org alert'), id: OTHER_ID, orgId: 'org-b', notifications: [] });
      }
      return base(input, init);
    });
    render(<AlertsPage />);
    await screen.findByText('Noise 0');
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url) === `/alerts/${OTHER_ID}`)).toBe(true));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a failed filtered fetch without a device filter offers a retry', async () => {
    let fail = true;
    mockApi((params) => {
      if (params.get('status') === 'resolved') {
        return fail ? json({ error: 'nope' }, false, 503) : { data: [alertRow('r', 'Resolved row', { status: 'resolved' })], total: 1 };
      }
      return { data: NOISE, total: 60 };
    });
    render(<AlertsPage />);
    await screen.findByText('Noise 0');
    fireEvent.click(screen.getByRole('button', { name: /Filters/i }));
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'resolved' } });
    const retry = await screen.findByTestId('alert-list-fetch-error');
    expect(screen.queryByText('Noise 0')).not.toBeInTheDocument();
    fail = false;
    await act(async () => { fireEvent.click(within(retry).getByRole('button')); });
    expect(await screen.findByText('Resolved row')).toBeInTheDocument();
  });

  it('a page past the end (its rows were just closed) moves back to the last page', async () => {
    let shrunk = false;
    mockApi((params) => {
      if (params.get('page') === '2') return shrunk ? { data: [], total: 25 } : { data: [alertRow('p2', 'Second page row')], total: 26 };
      return { data: NOISE, total: shrunk ? 25 : 26 };
    });
    render(<AlertsPage />);
    await screen.findByText('Noise 0');
    shrunk = true;
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    // Page 2 came back empty with 25 total: the page settles on page 1.
    await waitFor(() => expect(lastAlertsCall().get('page')).toBe('1'));
    expect(await screen.findByText('Noise 0')).toBeInTheDocument();
    const pages = alertsCalls().map((p) => p.get('page'));
    expect(pages.filter((p) => p === '2')).toHaveLength(1);
  });

  it('switching scope starts the list at page 1 without fetching the old page in the new scope', async () => {
    mockApi((params) => ({ data: params.get('page') === '2' ? [alertRow('p2', 'Second page row')] : NOISE, total: 26 }));
    const { rerender } = render(<AlertsPage />);
    await screen.findByText('Noise 0');
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await screen.findByText('Second page row');
    const before = alertsCalls().length;
    mockCurrentOrgId = 'org-a';
    rerender(<AlertsPage />);
    await screen.findByText('Noise 0');
    const after = alertsCalls().slice(before);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((p) => p.get('page') === '1')).toBe(true);
  });

  it('reads the summary strip from /alerts/summary, not from the loaded page', async () => {
    mockApi(() => ({ data: NOISE, total: 60 }));
    render(<AlertsPage />);
    await screen.findByText('Noise 0');
    // 25 low rows are loaded, but the strip shows the server's 40 open lows.
    expect(await screen.findByText('40')).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
  });
});
