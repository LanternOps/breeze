import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import BackupJobList from './BackupJobList';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

const fetchMock = vi.mocked(fetchWithAuth);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

describe('BackupJobList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads inline job details from the backup jobs API', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);

      if (url === '/backup/jobs') {
        return makeJsonResponse({
          data: [
            {
              id: 'job-1',
              type: 'file',
              deviceId: 'device-1',
              configId: 'config-1',
              deviceName: 'Alpha Workstation',
              configName: 'Nightly',
              status: 'failed',
              startedAt: '2026-04-01T18:00:00.000Z',
              completedAt: '2026-04-01T18:02:00.000Z',
              createdAt: '2026-04-01T17:59:00.000Z',
              totalSize: 1024,
              fileCount: 10,
              errorCount: 1,
              errorLog: 'dispatch failed',
            },
          ],
        });
      }

      if (url === '/backup/jobs/job-1') {
        return makeJsonResponse({
          id: 'job-1',
          type: 'file',
          deviceId: 'device-1',
          configId: 'config-1',
          deviceName: 'Alpha Workstation',
          configName: 'Nightly',
          status: 'failed',
          startedAt: '2026-04-01T18:00:00.000Z',
          completedAt: '2026-04-01T18:02:00.000Z',
          createdAt: '2026-04-01T17:59:00.000Z',
          updatedAt: '2026-04-01T18:03:00.000Z',
          totalSize: 1024,
          fileCount: 10,
          errorCount: 1,
          errorLog: 'Full restore dispatch failed: queue unavailable',
          snapshotId: 'snapshot-1',
          policyId: 'policy-1',
          featureLinkId: 'feature-link-1',
        });
      }

      return makeJsonResponse({ error: 'Not found' }, false, 404);
    });

    render(<BackupJobList />);

    await screen.findByText('Alpha Workstation');
    fireEvent.click(screen.getByRole('button', { name: /View details for Alpha Workstation backup/i }));

    expect(await screen.findByText('snapshot-1')).toBeTruthy();
    expect(screen.getByText('policy-1')).toBeTruthy();
    expect(screen.getByText(/Full restore dispatch failed: queue unavailable/i)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith('/backup/jobs/job-1');
  });

  it('shows an error when job details cannot be loaded', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);

      if (url === '/backup/jobs') {
        return makeJsonResponse({
          data: [
            {
              id: 'job-1',
              type: 'file',
              deviceId: 'device-1',
              configId: 'config-1',
              deviceName: 'Alpha Workstation',
              configName: 'Nightly',
              status: 'completed',
              startedAt: '2026-04-01T18:00:00.000Z',
              completedAt: '2026-04-01T18:02:00.000Z',
              createdAt: '2026-04-01T17:59:00.000Z',
              totalSize: 1024,
              fileCount: 10,
              errorCount: 0,
              errorLog: null,
            },
          ],
        });
      }

      if (url === '/backup/jobs/job-1') {
        return makeJsonResponse({ error: 'Job details unavailable' }, false, 502);
      }

      return makeJsonResponse({ error: 'Not found' }, false, 404);
    });

    render(<BackupJobList />);

    await screen.findByText('Alpha Workstation');
    fireEvent.click(screen.getByRole('button', { name: /View details for Alpha Workstation backup/i }));

    await waitFor(() => expect(screen.getByText('Job details unavailable')).toBeTruthy());
  });
});
