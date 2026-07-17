import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

// A running backup job with the live-progress fields the API now returns.
const runningJob = (overrides: Record<string, unknown> = {}) => ({
  id: 'job-run',
  type: 'file',
  deviceId: 'device-1',
  configId: 'config-1',
  deviceName: 'Beta Server',
  configName: 'Nightly',
  status: 'running',
  startedAt: '2026-04-01T00:00:00.000Z',
  completedAt: null,
  createdAt: '2026-04-01T00:00:00.000Z',
  errorCount: 0,
  errorLog: null,
  ...overrides,
});

// Flush the microtask queue (fetch → json → setState) without relying on
// timer-based async helpers, which do not compose with fake timers.
const flush = async () => {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
};

describe('BackupJobList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
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

  it('renders live progress (percent, files, speed) for a running job', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-01T00:01:00.000Z')); // 60s after startedAt

    fetchMock.mockImplementation(async (input) => {
      if (String(input) === '/backup/jobs') {
        return makeJsonResponse({
          data: [
            runningJob({
              transferredSize: 6_000_000,
              totalSize: 10_000_000,
              fileCount: 5,
              totalFiles: 20,
            }),
          ],
        });
      }
      return makeJsonResponse({ error: 'Not found' }, false, 404);
    });

    render(<BackupJobList />);
    await act(async () => {
      await flush();
    });

    expect(screen.getByText('Beta Server')).toBeTruthy();
    expect(screen.getByText('60%')).toBeTruthy();
    expect(screen.getByText('5 / 20 files')).toBeTruthy();
    // Average fallback: 6,000,000 B / 60 s = ~97.66 KB/s.
    expect(screen.getByText(/\/s$/)).toBeTruthy();
    // No stalled badge without a lastProgressAt timestamp.
    expect(screen.queryByTestId('backup-job-stalled')).toBeNull();
  });

  it('updates progress and computes speed across two poll refreshes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-01T00:00:10.000Z'));

    let call = 0;
    fetchMock.mockImplementation(async (input) => {
      if (String(input) === '/backup/jobs') {
        call += 1;
        return makeJsonResponse({
          data: [
            runningJob({
              transferredSize: call === 1 ? 1_000_000 : 5_000_000,
              totalSize: 10_000_000,
              fileCount: call === 1 ? 2 : 8,
              totalFiles: 20,
            }),
          ],
        });
      }
      return makeJsonResponse({ error: 'Not found' }, false, 404);
    });

    render(<BackupJobList />);
    await act(async () => {
      await flush();
    });

    expect(screen.getByText('10%')).toBeTruthy();
    expect(screen.getByText('2 / 20 files')).toBeTruthy();

    // Second poll refresh: 5s later, 4 MB more transferred.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
      await flush();
    });

    expect(screen.getByText('50%')).toBeTruthy();
    expect(screen.getByText('8 / 20 files')).toBeTruthy();
    // Delta speed = 4,000,000 B / 5 s = ~781 KB/s.
    expect(screen.getByText(/\/s$/)).toBeTruthy();
  });

  it('shows a stalled badge when a running job has no progress for over 2 minutes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-01T00:10:00.000Z'));

    fetchMock.mockImplementation(async (input) => {
      if (String(input) === '/backup/jobs') {
        return makeJsonResponse({
          data: [
            runningJob({
              transferredSize: 1000,
              totalSize: 10_000,
              fileCount: 1,
              totalFiles: 5,
              lastProgressAt: '2026-04-01T00:05:00.000Z', // 5 min old
            }),
          ],
        });
      }
      return makeJsonResponse({ error: 'Not found' }, false, 404);
    });

    render(<BackupJobList />);
    await act(async () => {
      await flush();
    });

    const badge = screen.getByTestId('backup-job-stalled');
    expect(badge).toBeTruthy();
    expect(badge.getAttribute('title')).toContain('5');
  });

  it('does not show a stalled badge when progress is recent', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-01T00:05:30.000Z'));

    fetchMock.mockImplementation(async (input) => {
      if (String(input) === '/backup/jobs') {
        return makeJsonResponse({
          data: [
            runningJob({
              transferredSize: 1000,
              totalSize: 10_000,
              fileCount: 1,
              totalFiles: 5,
              lastProgressAt: '2026-04-01T00:05:00.000Z', // 30s old
            }),
          ],
        });
      }
      return makeJsonResponse({ error: 'Not found' }, false, 404);
    });

    render(<BackupJobList />);
    await act(async () => {
      await flush();
    });

    expect(screen.queryByTestId('backup-job-stalled')).toBeNull();
  });

  it('renders a legacy running job with null progress fields without NaN or Infinity', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-01T00:01:00.000Z'));

    fetchMock.mockImplementation(async (input) => {
      if (String(input) === '/backup/jobs') {
        return makeJsonResponse({
          data: [
            runningJob({
              transferredSize: null,
              totalSize: null,
              fileCount: null,
              totalFiles: null,
              lastProgressAt: null,
            }),
          ],
        });
      }
      return makeJsonResponse({ error: 'Not found' }, false, 404);
    });

    const { container } = render(<BackupJobList />);
    await act(async () => {
      await flush();
    });

    expect(screen.getByText('Beta Server')).toBeTruthy();
    expect(container.textContent).not.toMatch(/NaN|Infinity/);
    expect(screen.queryByTestId('backup-job-stalled')).toBeNull();
  });

  it('labels the running-job action button "Stop"', async () => {
    fetchMock.mockImplementation(async (input) => {
      if (String(input) === '/backup/jobs') {
        return makeJsonResponse({
          data: [runningJob({ transferredSize: 100, totalSize: 1000, fileCount: 1, totalFiles: 2 })],
        });
      }
      return makeJsonResponse({ error: 'Not found' }, false, 404);
    });

    render(<BackupJobList />);

    const stopButton = await screen.findByRole('button', { name: /Stop backup for Beta Server/i });
    expect(stopButton.textContent).toContain('Stop');
  });
});
