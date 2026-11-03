import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DnsSecurityEventsTab from './DnsSecurityEventsTab';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

function makeJsonResponse(payload: unknown, ok = true, status = ok ? 200 : 500): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  } as unknown as Response;
}

describe('DnsSecurityEventsTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('defaults to blocked-only — query string contains action=blocked', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ data: [], pagination: { total: 0 } }));
    render(<DnsSecurityEventsTab />);
    await waitFor(() => {
      const url = fetchWithAuthMock.mock.calls[0]?.[0];
      expect(String(url)).toMatch(/action=blocked/);
    });
  });

  it('toggling "Show all" re-fetches without the action filter', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ data: [], pagination: { total: 0 } }));
    render(<DnsSecurityEventsTab />);
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(1));

    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ data: [], pagination: { total: 0 } }));
    fireEvent.click(screen.getByLabelText(/Show all/));

    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(2));
    const secondUrl = String(fetchWithAuthMock.mock.calls[1]![0]);
    expect(secondUrl).not.toMatch(/action=blocked/);
  });

  it('renders event rows with action badge + device hostname fallback chain', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({
        data: [
          {
            id: 'evt-1',
            timestamp: '2026-05-22T20:00:00.000Z',
            domain: 'malware.example.com',
            queryType: 'A',
            action: 'blocked',
            category: 'malware',
            threatType: 'trojan',
            sourceIp: '10.0.0.42',
            sourceHostname: null,
            deviceId: 'dev-1',
            deviceHostname: 'TST-LAPTOP-01',
            integrationId: 'int-1',
          },
          {
            id: 'evt-2',
            timestamp: '2026-05-22T20:01:00.000Z',
            domain: 'unknown.example.com',
            queryType: 'AAAA',
            action: 'blocked',
            category: null,
            threatType: null,
            sourceIp: '10.0.0.99',
            sourceHostname: null,
            deviceId: null,
            deviceHostname: null,
            integrationId: 'int-1',
          },
        ],
        pagination: { total: 2 },
      }),
    );

    render(<DnsSecurityEventsTab />);
    await waitFor(() => expect(screen.getByText('malware.example.com')).toBeInTheDocument());
    expect(screen.getByText('TST-LAPTOP-01')).toBeInTheDocument();
    expect(screen.getByText('10.0.0.99')).toBeInTheDocument(); // sourceIp fallback for the unknown row
    expect(screen.getAllByText('blocked').length).toBeGreaterThan(0);
  });

  // #10054 — bounded window, keyset "Load more", capped count.
  function eventRow(id: string) {
    return {
      id,
      timestamp: '2026-10-27T10:00:00.000Z',
      domain: `${id}.example.com`,
      queryType: 'A',
      action: 'blocked',
      category: 'malware',
      threatType: null,
      sourceIp: null,
      sourceHostname: null,
      deviceId: null,
      deviceHostname: `host-${id}`,
      integrationId: 'int-1',
    };
  }

  it('always sends a start bound (last 7 days by default)', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ data: [], pagination: { total: 0 } }));
    const before = Date.now();
    render(<DnsSecurityEventsTab />);
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(1));
    const params = new URL(String(fetchWithAuthMock.mock.calls[0]![0]), 'http://x').searchParams;
    const start = Date.parse(params.get('start') ?? '');
    expect(Math.abs(before - 7 * 86_400_000 - start)).toBeLessThan(5_000);
    expect(params.has('cursor')).toBe(false);
  });

  it('changing the time range re-fetches with the new start', async () => {
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ data: [], pagination: { total: 0 } }));
    render(<DnsSecurityEventsTab />);
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByTestId('dns-events-window'), { target: { value: 'last24h' } });
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(2));
    const params = new URL(String(fetchWithAuthMock.mock.calls[1]![0]), 'http://x').searchParams;
    const start = Date.parse(params.get('start') ?? '');
    expect(Date.now() - start).toBeLessThanOrEqual(86_400_000 + 5_000);
    expect(Date.now() - start).toBeGreaterThanOrEqual(86_400_000 - 5_000);
  });

  it('"Load more" sends the cursor with the first page window start and appends rows', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({
      data: [eventRow('a')],
      pagination: { total: 2, totalCapped: false, nextCursor: 'cur-1' },
      window: { start: '2026-10-20T10:00:00.000Z', end: null },
    }));
    render(<DnsSecurityEventsTab />);
    await waitFor(() => expect(screen.getByText('a.example.com')).toBeInTheDocument());

    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({
      data: [eventRow('b')],
      pagination: { total: null, totalCapped: false, nextCursor: null },
    }));
    fireEvent.click(screen.getByTestId('dns-events-load-more'));

    await waitFor(() => expect(screen.getByText('b.example.com')).toBeInTheDocument());
    expect(screen.getByText('a.example.com')).toBeInTheDocument();
    const params = new URL(String(fetchWithAuthMock.mock.calls[1]![0]), 'http://x').searchParams;
    expect(params.get('cursor')).toBe('cur-1');
    expect(params.get('start')).toBe('2026-10-20T10:00:00.000Z');
    expect(params.get('action')).toBe('blocked');
    // Last page: no more button; the first page's total stays.
    expect(screen.queryByTestId('dns-events-load-more')).not.toBeInTheDocument();
    expect(screen.getByText(/2 of 2 blocked events/)).toBeInTheDocument();
  });

  it('drops a Load more response that lands after the time range changed', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({
      data: [eventRow('a')],
      pagination: { total: 2, totalCapped: false, nextCursor: 'cur-1' },
      window: { start: '2026-10-20T10:00:00.000Z', end: null },
    }));
    render(<DnsSecurityEventsTab />);
    await waitFor(() => expect(screen.getByText('a.example.com')).toBeInTheDocument());

    let resolveStale!: (r: Response) => void;
    fetchWithAuthMock.mockReturnValueOnce(new Promise<Response>((resolve) => { resolveStale = resolve; }));
    fireEvent.click(screen.getByTestId('dns-events-load-more'));
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(2));

    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({
      data: [eventRow('fresh')],
      pagination: { total: 1, totalCapped: false, nextCursor: null },
    }));
    fireEvent.change(screen.getByTestId('dns-events-window'), { target: { value: 'last24h' } });
    await waitFor(() => expect(screen.getByText('fresh.example.com')).toBeInTheDocument());

    resolveStale(makeJsonResponse({
      data: [eventRow('stale')],
      pagination: { total: null, totalCapped: false, nextCursor: null },
    }));
    await new Promise((r) => setTimeout(r, 0));
    await waitFor(() => expect(screen.queryByText('stale.example.com')).not.toBeInTheDocument());
    expect(screen.queryByText('a.example.com')).not.toBeInTheDocument();
  });

  it('a failed Load more keeps the loaded rows, shows the error and allows a retry', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({
      data: [eventRow('a')],
      pagination: { total: 2, totalCapped: false, nextCursor: 'cur-1' },
    }));
    render(<DnsSecurityEventsTab />);
    await waitFor(() => expect(screen.getByText('a.example.com')).toBeInTheDocument());

    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({}, false, 500));
    fireEvent.click(screen.getByTestId('dns-events-load-more'));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/HTTP 500/));
    expect(screen.getByText('a.example.com')).toBeInTheDocument();
    expect(screen.getByTestId('dns-events-load-more')).not.toBeDisabled();
  });

  it('a 401 on Load more redirects to login without an error or new rows', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({
      data: [eventRow('a')],
      pagination: { total: 2, totalCapped: false, nextCursor: 'cur-1' },
    }));
    render(<DnsSecurityEventsTab />);
    await waitFor(() => expect(screen.getByText('a.example.com')).toBeInTheDocument());

    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({}, false, 401));
    fireEvent.click(screen.getByTestId('dns-events-load-more'));

    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith('/login', { replace: true }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows a capped total as a lower bound', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({
      data: [eventRow('a')],
      pagination: { total: 10000, totalCapped: true, nextCursor: 'cur-1' },
    }));
    render(<DnsSecurityEventsTab />);
    await waitFor(() => expect(screen.getByText(/1 of 10,000\+ blocked events/)).toBeInTheDocument());
  });

  it('Surfaces an inline error when the events endpoint fails', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({}, false, 500));
    render(<DnsSecurityEventsTab />);
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/Failed to load events/);
    });
  });
});
