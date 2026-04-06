import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import BackupDashboard from './BackupDashboard';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn()
}));
vi.mock('./HypervDashboard', () => ({
  default: () => <div>Hyper-V Dashboard Stub</div>,
}));
vi.mock('./VMRestoreWizard', () => ({
  default: () => <div>VM Restore Wizard</div>,
}));
vi.mock('./InstantBootStatus', () => ({
  default: () => <div>Instant Boot Status Stub</div>,
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload)
  }) as unknown as Response;

describe('BackupDashboard usage history chart', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.location.hash = '';
    HTMLDialogElement.prototype.showModal = vi.fn(function showModal(this: HTMLDialogElement) {
      this.setAttribute('open', '');
    });
    HTMLDialogElement.prototype.close = vi.fn(function close(this: HTMLDialogElement) {
      this.removeAttribute('open');
    });
  });

  it('renders provider usage timeline from API history payload', async () => {
    fetchWithAuthMock.mockImplementation(async (input) => {
      const url = String(input);

      if (url === '/backup/dashboard') {
        return makeJsonResponse({
          data: {
            stats: [{ id: 'storage_used', name: 'Storage Used', value: '1.5 TB', change: '+4.2%' }],
            recentJobs: [
              {
                id: 'job-1',
                device: 'edge-01',
                config: 'Primary S3',
                status: 'completed',
                started: '10m ago',
                duration: '2m',
                size: '1.2 GB',
                errorLog: 'Chunk retry exceeded threshold'
              }
            ],
            storageProviders: [
              { id: 's3', name: 'S3', used: '1.2 TB', total: '2 TB', percent: 60 },
              { id: 'local', name: 'Local', used: '300 GB', total: '1 TB', percent: 30 }
            ],
            attentionItems: []
          }
        });
      }

      if (url === '/backup/usage-history?days=14') {
        return makeJsonResponse({
          data: {
            points: [
              {
                timestamp: '2026-02-01T00:00:00.000Z',
                totalBytes: 1000,
                providers: [
                  { provider: 's3', bytes: 700 },
                  { provider: 'local', bytes: 300 }
                ]
              },
              {
                timestamp: '2026-02-02T00:00:00.000Z',
                totalBytes: 2000,
                providers: [
                  { provider: 's3', bytes: 1300 },
                  { provider: 'local', bytes: 700 }
                ]
              }
            ]
          }
        });
      }

      return makeJsonResponse({}, false, 404);
    });

    render(<BackupDashboard />);

    await screen.findByText('Storage by Provider');
    expect(await screen.findByLabelText('Storage usage trend by provider over time')).not.toBeNull();
    expect(screen.getByText(/Chunk retry exceeded threshold/i)).toBeTruthy();
    expect(screen.queryByText('Chart placeholder: integrate provider usage history.')).toBeNull();
  });

  it('shows the recovery bootstrap tab', async () => {
    fetchWithAuthMock.mockImplementation(async (input) => {
      const url = String(input);

      if (url === '/backup/dashboard') {
        return makeJsonResponse({ data: { stats: [], recentJobs: [], storageProviders: [], attentionItems: [] } });
      }

      if (url === '/backup/usage-history?days=14') {
        return makeJsonResponse({ data: { points: [] } });
      }

      return makeJsonResponse({}, false, 404);
    });

    render(<BackupDashboard />);

    expect(await screen.findByRole('button', { name: /Recovery Bootstrap/i })).toBeTruthy();
  });

  it('mounts VM restore and instant boot status within the Hyper-V tab', async () => {
    fetchWithAuthMock.mockImplementation(async (input) => {
      const url = String(input);

      if (url === '/backup/dashboard') {
        return makeJsonResponse({ data: { stats: [], recentJobs: [], storageProviders: [], attentionItems: [] } });
      }

      if (url === '/backup/usage-history?days=14') {
        return makeJsonResponse({ data: { points: [] } });
      }

      return makeJsonResponse({}, false, 404);
    });

    render(<BackupDashboard />);

    fireEvent.click(await screen.findByRole('button', { name: /Hyper-V/i }));

    expect(await screen.findByText('Hyper-V Dashboard Stub')).toBeTruthy();
    expect(screen.getByText('VM Restore Wizard')).toBeTruthy();
    expect(screen.getByText('Active instant boots')).toBeTruthy();
    expect(screen.getByText('Instant Boot Status Stub')).toBeTruthy();
  });

  it('reports offline and already-running devices separately in run-all flows', async () => {
    fetchWithAuthMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init as RequestInit | undefined)?.method ?? 'GET';

      if (url === '/backup/dashboard') {
        return makeJsonResponse({ data: { stats: [], recentJobs: [], storageProviders: [], attentionItems: [] } });
      }

      if (url === '/backup/usage-history?days=14') {
        return makeJsonResponse({ data: { points: [] } });
      }

      if (url === '/backup/jobs/run-all/preview' && method === 'GET') {
        return makeJsonResponse({ data: { deviceCount: 1, alreadyRunning: 2, offline: 3 } });
      }

      if (url === '/backup/jobs/run-all' && method === 'POST') {
        return makeJsonResponse({
          data: {
            created: 1,
            skipped: 5,
            skippedRunning: 2,
            skippedOffline: 3,
            failed: 1,
            jobIds: ['job-1'],
            failedJobIds: ['job-2'],
          },
        }, true, 201);
      }

      return makeJsonResponse({}, false, 404);
    });

    render(<BackupDashboard />);

    const runAllButton = await screen.findByRole('button', { name: /Run all backups/i });
    fireEvent.click(runAllButton);

    expect(await screen.findByText(/1 device/i)).toBeTruthy();
    expect(screen.getByText(/2 already running devices will be skipped/i)).toBeTruthy();
    expect(screen.getByText(/3 offline devices will be skipped/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Run backups/i }));

    await waitFor(() =>
      expect(
        screen.getByText(/Started 1 backup job\. 2 skipped \(already running\)\. 3 skipped \(offline\)\. 1 failed to dispatch/i)
      ).toBeTruthy()
    );
  });

  it('runs overdue backups from the overview card', async () => {
    fetchWithAuthMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init as RequestInit | undefined)?.method ?? 'GET';

      if (url === '/backup/dashboard') {
        return makeJsonResponse({
          data: {
            stats: [],
            recentJobs: [],
            storageProviders: [],
            attentionItems: [],
            overdueDevices: [
              { id: 'device-1', name: 'Alpha', lastBackup: 'Yesterday' },
              { id: 'device-2', name: 'Beta', lastBackup: '2 days ago' },
              { id: 'device-3', name: 'Gamma', lastBackup: '3 days ago' },
            ],
          },
        });
      }

      if (url === '/backup/usage-history?days=14') {
        return makeJsonResponse({ data: { points: [] } });
      }

      if (url === '/backup/jobs/run/device-1' && method === 'POST') {
        return makeJsonResponse({ id: 'job-1' }, true, 201);
      }

      if (url === '/backup/jobs/run/device-2' && method === 'POST') {
        return makeJsonResponse({ error: 'A backup job is already pending or running for this device' }, false, 409);
      }

      if (url === '/backup/jobs/run/device-3' && method === 'POST') {
        return makeJsonResponse({ error: 'Dispatch failed' }, false, 502);
      }

      return makeJsonResponse({}, false, 404);
    });

    render(<BackupDashboard />);

    const runOverdueButton = await screen.findByRole('button', { name: /Run overdue backups/i });
    fireEvent.click(runOverdueButton);

    await waitFor(() =>
      expect(screen.getByText(/Started 1 overdue backup job\. 1 skipped\. 1 failed/i)).toBeTruthy()
    );

    expect(fetchWithAuthMock).toHaveBeenCalledWith('/backup/jobs/run/device-1', { method: 'POST' });
    expect(fetchWithAuthMock).toHaveBeenCalledWith('/backup/jobs/run/device-2', { method: 'POST' });
    expect(fetchWithAuthMock).toHaveBeenCalledWith('/backup/jobs/run/device-3', { method: 'POST' });
  });
});
