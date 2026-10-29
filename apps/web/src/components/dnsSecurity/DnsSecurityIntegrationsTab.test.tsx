import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DnsSecurityIntegrationsTab from './DnsSecurityIntegrationsTab';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  // orgStore (pulled in transitively via the Add modal) registers an orgId
  // provider at module load, so this export must exist under the mock.
  registerOrgIdProvider: vi.fn(),
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

  it('marks a sync cut short by the request budget as catching up, with the unfetched range on hover (#10018)', async () => {
    const budgetMessage =
      'Reached the per-run request budget; 2026-10-22T04:25:27.166Z..2026-10-24T16:00:00.187Z not yet fetched, resumes next run';
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({
        data: [{
          id: 'int-1',
          orgId: 'org-1',
          provider: 'umbrella',
          name: 'Umbrella Prod',
          enabled: true,
          lastSync: '2026-10-22T04:25:27.166Z',
          lastSyncStatus: 'partial',
          lastSyncError: budgetMessage,
          totalEventsProcessed: 10,
          createdAt: '2026-05-01T00:00:00.000Z',
        }],
      }),
    );

    render(<DnsSecurityIntegrationsTab />);
    await waitFor(() => expect(screen.getByText('Umbrella Prod')).toBeInTheDocument());

    const cell = screen.getByText(/catching up/);
    expect(cell).toHaveAttribute('title', budgetMessage);
    expect(cell).not.toHaveTextContent(/failed/);
  });

  it('surfaces an inline error banner when the list endpoint fails', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ error: 'boom' }, false, 500));
    render(<DnsSecurityIntegrationsTab />);
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/Failed to load integrations/);
    });
  });
  // #10019 / #10020 — background delete and the retention edit.
  const umbrellaRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'int-1',
    orgId: 'org-1',
    provider: 'umbrella',
    name: 'Umbrella Prod',
    isActive: true,
    config: { organizationId: '42' },
    lastSync: '2026-05-22T19:00:00.000Z',
    lastSyncStatus: 'success',
    lastSyncError: null,
    totalEventsProcessed: 10,
    createdAt: '2026-05-01T00:00:00.000Z',
    ...overrides,
  });

  it('Delete queues a background delete (202) and says so instead of claiming it is done', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ data: [umbrellaRow()] }));
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<DnsSecurityIntegrationsTab />);
    await waitFor(() => expect(screen.getByText('Umbrella Prod')).toBeInTheDocument());

    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ success: true, id: 'int-1', status: 'deleting' }, true, 202));
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ data: [umbrellaRow({ isActive: false, lastSyncStatus: 'deleting' })] }));

    fireEvent.click(screen.getByTitle('Delete integration'));

    await waitFor(() => {
      expect(showToastMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'success', message: 'Deleting Umbrella Prod in the background' }),
      );
    });
    expect(fetchWithAuthMock).toHaveBeenCalledWith('/dns-security/integrations/int-1', expect.objectContaining({ method: 'DELETE' }));
    expect(confirmSpy.mock.calls[0]![0]).toMatch(/removed in the background/);
    await waitFor(() => expect(screen.getByText('Deleting…')).toBeInTheDocument());
    confirmSpy.mockRestore();
  });

  it('shows a row being deleted as such and disables its actions', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({
      data: [umbrellaRow({ isActive: false, lastSyncStatus: 'deleting' })],
    }));
    render(<DnsSecurityIntegrationsTab />);
    await waitFor(() => expect(screen.getByText('Deleting…')).toBeInTheDocument());
    expect(screen.getByTitle('Sync now')).toBeDisabled();
    expect(screen.getByTitle('Delete integration')).toBeDisabled();
    expect(screen.getByTitle('Stored data')).toBeDisabled();
  });

  it('edits retentionDays with PATCH, prefilled from the integration config', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({
      data: [umbrellaRow({ config: { organizationId: '42', retentionDays: 7 } })],
    }));
    render(<DnsSecurityIntegrationsTab />);
    await waitFor(() => expect(screen.getByText('Umbrella Prod')).toBeInTheDocument());

    fireEvent.click(screen.getByTitle('Stored data'));
    const input = await screen.findByLabelText('Keep DNS events and statistics for (days)');
    expect(input).toHaveValue(7);

    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ id: 'int-1', retentionDays: 30 }));
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ data: [umbrellaRow()] }));
    fireEvent.change(input, { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(fetchWithAuthMock).toHaveBeenCalledWith('/dns-security/integrations/int-1', expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ retentionDays: 30, storeAllowedTraffic: false }),
      }));
    });
    await waitFor(() => {
      expect(showToastMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'success', message: 'Stored data settings updated for Umbrella Prod' }),
      );
    });
  });

  it('an empty retention field sends null so the deployment default applies', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({
      data: [umbrellaRow({ config: { retentionDays: 7 } })],
    }));
    render(<DnsSecurityIntegrationsTab />);
    await waitFor(() => expect(screen.getByText('Umbrella Prod')).toBeInTheDocument());

    fireEvent.click(screen.getByTitle('Stored data'));
    const input = await screen.findByLabelText('Keep DNS events and statistics for (days)');
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ id: 'int-1', retentionDays: null }));
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ data: [umbrellaRow()] }));
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(fetchWithAuthMock).toHaveBeenCalledWith('/dns-security/integrations/int-1', expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ retentionDays: null, storeAllowedTraffic: false }),
      }));
    });
  });

  it('rejects an out-of-range retention value without calling the API', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ data: [umbrellaRow()] }));
    render(<DnsSecurityIntegrationsTab />);
    await waitFor(() => expect(screen.getByText('Umbrella Prod')).toBeInTheDocument());

    fireEvent.click(screen.getByTitle('Stored data'));
    const input = await screen.findByLabelText('Keep DNS events and statistics for (days)');
    fireEvent.change(input, { target: { value: '400' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Enter a whole number of days from 1 to 365, or leave it empty.')).toBeInTheDocument();
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(1);
  });
});
