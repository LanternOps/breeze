import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DnsSecurityOverviewTab from './DnsSecurityOverviewTab';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

function makeJsonResponse(payload: unknown, ok = true, status = ok ? 200 : 500): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  } as unknown as Response;
}

describe('DnsSecurityOverviewTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders stat counters from /stats and top-blocked list from /top-blocked in parallel', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(
      // The real /dns-security/stats shape (#10054: the tab used to read
      // `data.total` etc., which the API never sent, so every counter was 0).
      makeJsonResponse({
        summary: { totalQueries: 12345, blockedQueries: 234, allowedQueries: 12100, redirectedQueries: 7, blockedRate: 1.9 },
        allowedTraffic: 'all',
      }),
    );
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({
        data: [
          { domain: 'malware.example.com', count: 47, category: 'malware' },
          { domain: 'phish.example.com', count: 22, category: 'phishing' },
        ],
      }),
    );

    render(<DnsSecurityOverviewTab />);

    await waitFor(() => expect(screen.getByText('12,345')).toBeInTheDocument());
    expect(screen.getByText('234')).toBeInTheDocument();
    expect(screen.getByText('12,100')).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.getByText('malware.example.com')).toBeInTheDocument();
    expect(screen.getByText('phish.example.com')).toBeInTheDocument();
    // Counts column on the top-blocked widget
    expect(screen.getByText('47')).toBeInTheDocument();
    expect(screen.getByText('22')).toBeInTheDocument();
  });

  it('renders empty-state for top-blocked when API returns []', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({
        summary: { totalQueries: 0, blockedQueries: 0, allowedQueries: 0, redirectedQueries: 0, blockedRate: 0 },
        allowedTraffic: 'all',
      }),
    );
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ data: [] }));

    render(<DnsSecurityOverviewTab />);

    await waitFor(() => {
      expect(screen.getByText('No blocked domains in the current window.')).toBeInTheDocument();
    });
  });

  it('Shows inline error when BOTH endpoints fail; tolerates partial failure when one succeeds', async () => {
    // Both fail
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({}, false, 500));
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({}, false, 500));

    render(<DnsSecurityOverviewTab />);
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/Failed to load overview/);
    });
  });

  // #10054 — sync stores allowed traffic only for integrations that opted in.
  it('shows "Not stored" instead of a zero allowed count when no integration stores allowed traffic', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({
        summary: { totalQueries: 240, blockedQueries: 234, allowedQueries: null, redirectedQueries: 6, blockedRate: null },
        allowedTraffic: 'none',
      }),
    );
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ data: [] }));

    render(<DnsSecurityOverviewTab />);

    await waitFor(() => expect(screen.getByText('234')).toBeInTheDocument());
    expect(screen.getByTestId('dns-overview-allowed-value')).toHaveTextContent('Not stored');
    expect(screen.getByTestId('dns-overview-allowed-traffic-note')).toHaveTextContent(
      /Allowed queries are not stored/,
    );
  });

  it('flags a partial allowed count when only some integrations store allowed traffic', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({
        summary: { totalQueries: 1240, blockedQueries: 234, allowedQueries: 1000, redirectedQueries: 6, blockedRate: 18.87 },
        allowedTraffic: 'some',
      }),
    );
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ data: [] }));

    render(<DnsSecurityOverviewTab />);

    await waitFor(() => expect(screen.getByTestId('dns-overview-allowed-value')).toHaveTextContent('1,000'));
    expect(screen.getByTestId('dns-overview-allowed-traffic-note')).toHaveTextContent(/some integrations/);
  });

  it('shows no allowed-traffic note when every integration stores allowed traffic', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({
        summary: { totalQueries: 10, blockedQueries: 1, allowedQueries: 9, redirectedQueries: 0, blockedRate: 10 },
        allowedTraffic: 'all',
      }),
    );
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ data: [] }));

    render(<DnsSecurityOverviewTab />);

    await waitFor(() => expect(screen.getByTestId('dns-overview-allowed-value')).toHaveTextContent('9'));
    expect(screen.queryByTestId('dns-overview-allowed-traffic-note')).not.toBeInTheDocument();
  });
});
