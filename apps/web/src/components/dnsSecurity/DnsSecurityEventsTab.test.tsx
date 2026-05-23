import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DnsSecurityEventsTab from './DnsSecurityEventsTab';
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

  it('Surfaces an inline error when the events endpoint fails', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({}, false, 500));
    render(<DnsSecurityEventsTab />);
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/Failed to load events/);
    });
  });
});
