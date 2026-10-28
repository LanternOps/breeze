import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import DnsSecurityIntegrationsTab from './DnsSecurityIntegrationsTab';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';
import { navigateTo } from '@/lib/navigation';

vi.mock('@/lib/navigation', () => ({
  navigateTo: vi.fn(),
}));

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
    expect(screen.getByTitle('Change retention period')).toBeDisabled();
  });

  it('edits retentionDays with PATCH, prefilled from the integration config', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({
      data: [umbrellaRow({ config: { organizationId: '42', retentionDays: 7 } })],
    }));
    render(<DnsSecurityIntegrationsTab />);
    await waitFor(() => expect(screen.getByText('Umbrella Prod')).toBeInTheDocument());

    fireEvent.click(screen.getByTitle('Change retention period'));
    const input = await screen.findByLabelText('Keep DNS events and statistics for (days)');
    expect(input).toHaveValue(7);

    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ id: 'int-1', retentionDays: 30 }));
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ data: [umbrellaRow()] }));
    fireEvent.change(input, { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(fetchWithAuthMock).toHaveBeenCalledWith('/dns-security/integrations/int-1', expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ retentionDays: 30 }),
      }));
    });
    await waitFor(() => {
      expect(showToastMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'success', message: 'Retention updated for Umbrella Prod' }),
      );
    });
  });

  it('an empty retention field sends null so the deployment default applies', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({
      data: [umbrellaRow({ config: { retentionDays: 7 } })],
    }));
    render(<DnsSecurityIntegrationsTab />);
    await waitFor(() => expect(screen.getByText('Umbrella Prod')).toBeInTheDocument());

    fireEvent.click(screen.getByTitle('Change retention period'));
    const input = await screen.findByLabelText('Keep DNS events and statistics for (days)');
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ id: 'int-1', retentionDays: null }));
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ data: [umbrellaRow()] }));
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(fetchWithAuthMock).toHaveBeenCalledWith('/dns-security/integrations/int-1', expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ retentionDays: null }),
      }));
    });
  });

  it('rejects an out-of-range retention value without calling the API', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ data: [umbrellaRow()] }));
    render(<DnsSecurityIntegrationsTab />);
    await waitFor(() => expect(screen.getByText('Umbrella Prod')).toBeInTheDocument());

    fireEvent.click(screen.getByTitle('Change retention period'));
    const input = await screen.findByLabelText('Keep DNS events and statistics for (days)');
    fireEvent.change(input, { target: { value: '400' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Enter a whole number of days from 1 to 365, or leave it empty.')).toBeInTheDocument();
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(1);
  });
  // #10085 — a "Deleting…" row is polled until the background job removes it.
  describe('polling while a row is being deleted', () => {
    const LIST_URL = '/dns-security/integrations';
    const listCalls = () => fetchWithAuthMock.mock.calls.filter(([url]) => url === LIST_URL).length;
    const deletingRow = () => umbrellaRow({ isActive: false, lastSyncStatus: 'deleting' });
    const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
    const setVisibility = (state: 'visible' | 'hidden') => {
      Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
      Object.defineProperty(document, 'hidden', { value: state === 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    };

    beforeEach(() => {
      // Drop any persistent mockResolvedValue from an earlier test.
      fetchWithAuthMock.mockReset();
      vi.useFakeTimers({ shouldAdvanceTime: true });
      setVisibility('visible');
    });

    afterEach(() => {
      vi.useRealTimers();
      setVisibility('visible');
    });

    it('refetches a deleting row, drops it once the API stops returning it, then stops polling', async () => {
      fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ data: [deletingRow()] }));
      render(<DnsSecurityIntegrationsTab />);
      await waitFor(() => expect(screen.getByText('Deleting…')).toBeInTheDocument());
      expect(listCalls()).toBe(1);

      // Still deleting at the first poll: the table stays up (no spinner swap).
      fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ data: [deletingRow()] }));
      await advance(5_000);
      expect(listCalls()).toBe(2);
      expect(screen.getByText('Deleting…')).toBeInTheDocument();
      expect(screen.queryByText('Loading integrations…')).not.toBeInTheDocument();

      // Backoff: the next poll is 10 s later, not 5 s.
      fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ data: [] }));
      await advance(5_000);
      expect(listCalls()).toBe(2);
      await advance(5_000);
      expect(listCalls()).toBe(3);
      await waitFor(() => expect(screen.getByText('No DNS integrations configured')).toBeInTheDocument());

      // Nothing left deleting: no further requests.
      await advance(120_000);
      expect(listCalls()).toBe(3);
      // Deleted elsewhere (not from this tab): it drops without a toast.
      expect(showToastMock).not.toHaveBeenCalled();
    });

    it('backs off 5, 10, 20 s and then holds at 30 s', async () => {
      fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ data: [deletingRow()] }));
      render(<DnsSecurityIntegrationsTab />);
      await waitFor(() => expect(screen.getByText('Deleting…')).toBeInTheDocument());

      for (const [gap, expected] of [[5_000, 2], [10_000, 3], [20_000, 4], [30_000, 5], [30_000, 6]] as const) {
        await advance(gap - 100);
        expect(listCalls()).toBe(expected - 1);
        await advance(100);
        expect(listCalls()).toBe(expected);
      }
    });

    it('counts only consecutive failures toward the pause', async () => {
      fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ data: [deletingRow()] }));
      render(<DnsSecurityIntegrationsTab />);
      await waitFor(() => expect(screen.getByText('Deleting…')).toBeInTheDocument());

      const fail = () => makeJsonResponse({ error: 'boom' }, false, 503);
      const ok = () => makeJsonResponse({ data: [deletingRow()] });
      for (const res of [fail(), fail(), ok(), fail(), fail(), ok(), fail()]) {
        fetchWithAuthMock.mockResolvedValueOnce(res);
      }
      // 7 polls at 5+10+20+30+30+30+30 s: four failures in total, never three in a row.
      await advance(155_000);
      expect(listCalls()).toBe(8);
      fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ data: [] }));
      await advance(30_000);
      expect(listCalls()).toBe(9);
    });

    it('stops polling and sends the user to login on a 401', async () => {
      fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ data: [deletingRow()] }));
      render(<DnsSecurityIntegrationsTab />);
      await waitFor(() => expect(screen.getByText('Deleting…')).toBeInTheDocument());

      fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ error: 'unauthorized' }, false, 401));
      await advance(5_000);
      expect(listCalls()).toBe(2);
      expect(vi.mocked(navigateTo)).toHaveBeenCalledWith('/login', { replace: true });
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      await advance(300_000);
      expect(listCalls()).toBe(2);
    });

    it('treats a 200 without a list as a failure, not as every row gone', async () => {
      fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ data: [umbrellaRow()] }));
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
      render(<DnsSecurityIntegrationsTab />);
      await waitFor(() => expect(screen.getByText('Umbrella Prod')).toBeInTheDocument());

      fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ success: true, id: 'int-1', status: 'deleting' }, true, 202));
      fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ data: [deletingRow()] }));
      fireEvent.click(screen.getByTitle('Delete integration'));
      await waitFor(() => expect(screen.getByText('Deleting…')).toBeInTheDocument());

      fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ unexpected: true }));
      await advance(5_000);
      expect(screen.getByRole('alert')).toHaveTextContent('Failed to load integrations');
      expect(screen.getByText('Deleting…')).toBeInTheDocument();
      expect(showToastMock).not.toHaveBeenCalledWith(expect.objectContaining({ message: 'Umbrella Prod deleted' }));
      confirmSpy.mockRestore();
    });

    it('drops an older list answer that lands after a newer one', async () => {
      const otherRow = umbrellaRow({ id: 'int-2', name: 'Cloudflare Lab', provider: 'cloudflare' });
      fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ data: [umbrellaRow(), otherRow] }));
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
      render(<DnsSecurityIntegrationsTab />);
      await waitFor(() => expect(screen.getByText('Cloudflare Lab')).toBeInTheDocument());

      // Sync row 1 and, before its refetch answers, delete row 2.
      let resolveSyncRefetch: (res: Response) => void = () => {};
      fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ success: true })); // POST sync
      fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ success: true, id: 'int-2', status: 'deleting' }, true, 202));
      fetchWithAuthMock.mockReturnValueOnce(new Promise<Response>((resolve) => { resolveSyncRefetch = resolve; }));
      fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({
        data: [umbrellaRow(), { ...otherRow, isActive: false, lastSyncStatus: 'deleting' }],
      }));
      fireEvent.click(screen.getAllByTitle('Sync now')[0]!);
      fireEvent.click(screen.getAllByTitle('Delete integration')[1]!);
      await waitFor(() => expect(listCalls()).toBe(3));
      await waitFor(() => expect(screen.getByText('Deleting…')).toBeInTheDocument());

      // The sync's older answer (row 2 still active) must not overwrite it.
      await act(async () => { resolveSyncRefetch(makeJsonResponse({ data: [umbrellaRow(), otherRow] })); });
      expect(screen.getByText('Deleting…')).toBeInTheDocument();
      confirmSpy.mockRestore();
    });

    it('resumes a paused poll after a successful manual refresh', async () => {
      const otherRow = umbrellaRow({ id: 'int-2', name: 'Cloudflare Lab', provider: 'cloudflare' });
      fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ data: [deletingRow(), otherRow] }));
      render(<DnsSecurityIntegrationsTab />);
      await waitFor(() => expect(screen.getByText('Cloudflare Lab')).toBeInTheDocument());

      for (let i = 0; i < 3; i++) fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ error: 'boom' }, false, 503));
      await advance(35_000);
      expect(listCalls()).toBe(4);
      await advance(120_000);
      expect(listCalls()).toBe(4); // paused

      // Sync the other row: its refetch succeeds and restarts the poll.
      fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ success: true }));
      fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ data: [deletingRow(), otherRow] }));
      const syncButtons = screen.getAllByTitle('Sync now');
      fireEvent.click(syncButtons[1]!);
      await waitFor(() => expect(listCalls()).toBe(5));
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();

      fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ data: [otherRow] }));
      await advance(5_000);
      expect(listCalls()).toBe(6);
      await waitFor(() => expect(screen.queryByText('Deleting…')).not.toBeInTheDocument());
    });

    it('resumes a paused poll when the browser tab is shown again', async () => {
      fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ data: [deletingRow()] }));
      render(<DnsSecurityIntegrationsTab />);
      await waitFor(() => expect(screen.getByText('Deleting…')).toBeInTheDocument());

      for (let i = 0; i < 3; i++) fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ error: 'boom' }, false, 503));
      await advance(35_000);
      await advance(120_000);
      expect(listCalls()).toBe(4);

      fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ data: [] }));
      setVisibility('hidden');
      setVisibility('visible');
      await advance(0);
      expect(listCalls()).toBe(5);
      await waitFor(() => expect(screen.getByText('No DNS integrations configured')).toBeInTheDocument());
    });

    it('does not refetch on a visibility change while a poll is already scheduled', async () => {
      fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ data: [deletingRow()] }));
      render(<DnsSecurityIntegrationsTab />);
      await waitFor(() => expect(screen.getByText('Deleting…')).toBeInTheDocument());

      setVisibility('hidden');
      setVisibility('visible');
      setVisibility('visible');
      await advance(0);
      expect(listCalls()).toBe(1);
      await advance(5_000);
      expect(listCalls()).toBe(2);
    });

    it('does not poll when no row is being deleted', async () => {
      fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ data: [umbrellaRow()] }));
      render(<DnsSecurityIntegrationsTab />);
      await waitFor(() => expect(screen.getByText('Umbrella Prod')).toBeInTheDocument());
      await advance(120_000);
      expect(listCalls()).toBe(1);
    });

    it('pauses while the browser tab is hidden and refetches when it is shown again', async () => {
      fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ data: [deletingRow()] }));
      render(<DnsSecurityIntegrationsTab />);
      await waitFor(() => expect(screen.getByText('Deleting…')).toBeInTheDocument());

      setVisibility('hidden');
      await advance(120_000);
      expect(listCalls()).toBe(1);

      fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ data: [] }));
      setVisibility('visible');
      await advance(0);
      expect(listCalls()).toBe(2);
      await waitFor(() => expect(screen.getByText('No DNS integrations configured')).toBeInTheDocument());
    });

    it('stops after repeated failures, keeps the rows and shows the error', async () => {
      fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ data: [deletingRow()] }));
      render(<DnsSecurityIntegrationsTab />);
      await waitFor(() => expect(screen.getByText('Deleting…')).toBeInTheDocument());

      fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ error: 'boom' }, false, 503));
      await advance(5_000);
      await advance(10_000);
      await advance(20_000);
      expect(listCalls()).toBe(4);
      expect(screen.getByRole('alert')).toHaveTextContent('Failed to load integrations (HTTP 503)');
      expect(screen.getByText('Umbrella Prod')).toBeInTheDocument();

      await advance(300_000);
      expect(listCalls()).toBe(4);
    });

    it('clears the error banner once a later poll succeeds', async () => {
      fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ data: [deletingRow()] }));
      render(<DnsSecurityIntegrationsTab />);
      await waitFor(() => expect(screen.getByText('Deleting…')).toBeInTheDocument());

      fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ error: 'boom' }, false, 503));
      await advance(5_000);
      expect(screen.getByRole('alert')).toBeInTheDocument();

      fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ data: [deletingRow()] }));
      await advance(10_000);
      expect(listCalls()).toBe(3);
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('stops polling on unmount', async () => {
      fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ data: [deletingRow()] }));
      const { unmount } = render(<DnsSecurityIntegrationsTab />);
      await waitFor(() => expect(screen.getByText('Deleting…')).toBeInTheDocument());
      unmount();
      await advance(120_000);
      expect(listCalls()).toBe(1);
    });

    it('toasts when an integration this tab deleted is gone', async () => {
      fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ data: [umbrellaRow()] }));
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
      render(<DnsSecurityIntegrationsTab />);
      await waitFor(() => expect(screen.getByText('Umbrella Prod')).toBeInTheDocument());

      fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ success: true, id: 'int-1', status: 'deleting' }, true, 202));
      fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ data: [deletingRow()] }));
      fireEvent.click(screen.getByTitle('Delete integration'));
      await waitFor(() => expect(screen.getByText('Deleting…')).toBeInTheDocument());
      expect(showToastMock).not.toHaveBeenCalledWith(expect.objectContaining({ message: 'Umbrella Prod deleted' }));

      fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ data: [] }));
      await advance(5_000);
      await waitFor(() => {
        expect(showToastMock).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'success', message: 'Umbrella Prod deleted' }),
        );
      });
      confirmSpy.mockRestore();
    });
  });
});
