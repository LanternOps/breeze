import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DnsSecurityIntegrationsTab from './DnsSecurityIntegrationsTab';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

vi.mock('../shared/Toast', () => ({
  showToast: vi.fn(),
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);
const showToastMock = vi.mocked(showToast);

function makeJsonResponse(payload: unknown, ok = true, status = ok ? 200 : 500): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  } as unknown as Response;
}

describe('DnsSecurityIntegrationsTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the empty state when no integrations exist', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ data: [] }));
    render(<DnsSecurityIntegrationsTab />);
    await waitFor(() => {
      expect(screen.getByText('No DNS integrations configured')).toBeInTheDocument();
    });
  });

  it('renders each integration row with its provider label and last-sync state', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({
        data: [
          {
            id: 'int-1',
            orgId: 'org-1',
            provider: 'cloudflare',
            name: 'Acme HQ Gateway',
            enabled: true,
            lastSync: '2026-05-22T19:00:00.000Z',
            lastSyncStatus: 'success',
            lastSyncError: null,
            totalEventsProcessed: 4242,
            createdAt: '2026-05-01T00:00:00.000Z',
          },
          {
            id: 'int-2',
            orgId: 'org-1',
            provider: 'adguard_home',
            name: 'Lab AdGuard',
            enabled: true,
            lastSync: null,
            lastSyncStatus: null,
            lastSyncError: null,
            totalEventsProcessed: 0,
            createdAt: '2026-05-02T00:00:00.000Z',
          },
        ],
      }),
    );

    render(<DnsSecurityIntegrationsTab />);

    await waitFor(() => {
      expect(screen.getByText('Acme HQ Gateway')).toBeInTheDocument();
    });
    expect(screen.getByText('Cloudflare Gateway')).toBeInTheDocument();
    expect(screen.getByText('AdGuard Home')).toBeInTheDocument();
    expect(screen.getByText('Lab AdGuard')).toBeInTheDocument();
    expect(screen.getByText('4242')).toBeInTheDocument();
    expect(screen.getByText('Never')).toBeInTheDocument();
  });

  it('Sync button POSTs /integrations/:id/sync via runAction and toasts on success', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({
        data: [{
          id: 'int-1',
          orgId: 'org-1',
          provider: 'umbrella',
          name: 'Umbrella Prod',
          enabled: true,
          lastSync: '2026-05-22T19:00:00.000Z',
          lastSyncStatus: 'success',
          lastSyncError: null,
          totalEventsProcessed: 10,
          createdAt: '2026-05-01T00:00:00.000Z',
        }],
      }),
    );

    render(<DnsSecurityIntegrationsTab />);
    await waitFor(() => expect(screen.getByText('Umbrella Prod')).toBeInTheDocument());

    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ success: true }));
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ data: [] })); // refetch

    fireEvent.click(screen.getByTitle('Sync now'));

    await waitFor(() => {
      expect(showToastMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'success', message: 'Sync queued for Umbrella Prod' }),
      );
    });
  });

  it('surfaces an inline error banner when the list endpoint fails', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ error: 'boom' }, false, 500));
    render(<DnsSecurityIntegrationsTab />);
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/Failed to load integrations/);
    });
  });
});
