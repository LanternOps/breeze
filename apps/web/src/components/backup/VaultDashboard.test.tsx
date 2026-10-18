import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import VaultDashboard from './VaultDashboard';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

const fetchMock = vi.mocked(fetchWithAuth);
const showToastMock = vi.mocked(showToast);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

describe('VaultDashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockResolvedValue(makeJsonResponse({ data: [] }));
  });

  it('renders loading state', () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));

    render(<VaultDashboard />);

    expect(screen.getByText('Loading vaults...')).toBeTruthy();
  });

  it('renders empty state when no vaults exist', async () => {
    render(<VaultDashboard />);

    await screen.findByText('No vaults configured');
    expect(screen.getByText(/Add a local vault to enable on-site backup storage/i)).toBeTruthy();
  });

  it('renders alpha banner', async () => {
    render(<VaultDashboard />);

    await screen.findByText('Local Vaults');
    expect(screen.getByText(/Local vault \(SMB\/USB\) caching is in early access/i)).toBeTruthy();
  });

  it('renders last sync error details for failed vaults', async () => {
    fetchMock.mockResolvedValueOnce(
      makeJsonResponse({
        data: [
          {
            id: 'vault-1',
            deviceId: 'device-1',
            vaultPath: '/vault/path',
            vaultType: 'local',
            isActive: true,
            lastSyncStatus: 'failed',
            lastSyncAt: '2026-03-31T10:00:00.000Z',
            syncSizeBytes: 1024,
            lastSyncError: 'Vault sync failed: share unavailable',
          },
        ],
      })
    );

    render(<VaultDashboard />);

    expect(await screen.findByText(/Vault sync failed: share unavailable/i)).toBeTruthy();
    expect(screen.getByText('Failed')).toBeTruthy();
  });

  describe('#8385', () => {
    const row = (over: Record<string, unknown> = {}) => ({
      id: 'vault-1',
      deviceId: 'abcdef12-0000-0000-0000-000000000000',
      deviceName: 'ACME-FILESRV',
      vaultPath: '/vault/path',
      vaultType: 'local',
      isActive: true,
      lastSyncStatus: 'completed',
      ...over,
    });
    const setup = (rows: unknown[], mutationResponse: Response = makeJsonResponse({ deviceConfig: { status: 'queued' } })) => {
      fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
        if (init?.method && init.method !== 'GET') return mutationResponse;
        return makeJsonResponse({ data: rows });
      });
    };
    const mutation = () =>
      fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method) as [string, RequestInit];

    it('renders the device name supplied by the API', async () => {
      setup([row()]);
      render(<VaultDashboard />);
      expect(await screen.findByText('ACME-FILESRV')).toBeTruthy();
      expect(screen.queryByText('abcdef12')).toBeNull();
    });

    it('deactivate PATCHes isActive:false (not active)', async () => {
      setup([row()]);
      render(<VaultDashboard />);
      fireEvent.click(await screen.findByRole('button', { name: 'Deactivate' }));
      await waitFor(() => expect(mutation()).toBeTruthy());
      const [url, init] = mutation();
      expect(url).toBe('/backup/vault/vault-1');
      expect(init.method).toBe('PATCH');
      const body = JSON.parse(init.body as string);
      expect(body).toEqual({ isActive: false });
      expect(body).not.toHaveProperty('active');
    });

    it('shows an Inactive badge instead of sync status and disables Sync/Deactivate', async () => {
      setup([row({ isActive: false })]);
      render(<VaultDashboard />);
      expect(await screen.findByText('Inactive')).toBeTruthy();
      expect(screen.queryByText('Completed')).toBeNull();
      expect((screen.getByRole('button', { name: /Sync/ }) as HTMLButtonElement).disabled).toBe(true);
      expect((screen.getByRole('button', { name: 'Deactivate' }) as HTMLButtonElement).disabled).toBe(true);
    });

    it('warns when deactivation could not be pushed to the device', async () => {
      setup([row()], makeJsonResponse({ deviceConfig: { status: 'failed', error: 'device offline' } }));
      render(<VaultDashboard />);
      fireEvent.click(await screen.findByRole('button', { name: 'Deactivate' }));
      await waitFor(() =>
        expect(showToastMock).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'warning', message: expect.stringContaining('device offline') }),
        ),
      );
    });

    it('toasts a failed sync via runAction (e.g. no snapshot yet)', async () => {
      const msg = 'No backup snapshot to sync yet: run a file backup on this device first';
      setup([row()], makeJsonResponse({ error: msg }, false, 400));
      render(<VaultDashboard />);
      fireEvent.click(await screen.findByRole('button', { name: /Sync/ }));
      await waitFor(() =>
        expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: msg })),
      );
    });
  });
});
