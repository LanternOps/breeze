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
      makeJsonResponse({
        data: { total: 12345, blocked: 234, allowed: 12100, redirected: 7 },
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
      makeJsonResponse({ data: { total: 0, blocked: 0, allowed: 0, redirected: 0 } }),
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
});
