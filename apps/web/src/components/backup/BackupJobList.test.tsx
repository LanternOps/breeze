import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import BackupJobList from './BackupJobList';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

// Mock the Toast singleton so we can assert what the cancel handler surfaces to
// the user (runAction and the warning path both route through showToast).
vi.mock('../shared/Toast', () => ({
  showToast: vi.fn(),
}));

const fetchMock = vi.mocked(fetchWithAuth);
const showToastMock = vi.mocked(showToast);

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

// A run the agent finished as `partial`: a restorable snapshot exists but most
// of the files failed (issue #3000 — 21 of 22 files failed, job still green).
const partialJob = (overrides: Record<string, unknown> = {}) => ({
  id: 'job-partial',
  type: 'file',
  deviceId: 'device-2',
  configId: 'config-1',
  deviceName: 'Gamma Laptop',
  configName: 'Nightly',
  status: 'partial',
  startedAt: '2026-04-01T18:00:00.000Z',
  completedAt: '2026-04-01T18:05:00.000Z',
  createdAt: '2026-04-01T17:59:00.000Z',
  totalSize: 3_355_443,
  fileCount: 1,
  totalFiles: 22,
  errorCount: 21,
  errorLog: 'access denied: C:\\Users\\a\\Documents',
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

  it('shows an ETA for a running job with a total and a speed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-01T00:01:00.000Z')); // 60s after startedAt

    fetchMock.mockImplementation(async (input) => {
      if (String(input) === '/backup/jobs') {
        return makeJsonResponse({
          data: [
            runningJob({
              // 1 MB in 60 s → 9 MB left at ~16.7 KB/s = 540 s.
              transferredSize: 1_000_000,
              totalSize: 10_000_000,
              lastKeepaliveAt: '2026-04-01T00:00:55.000Z',
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

    expect(screen.getByTestId('backup-job-eta').textContent).toBe('about 9m left');
  });

  it('shows no ETA for a stalled running job', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-01T00:10:00.000Z'));

    fetchMock.mockImplementation(async (input) => {
      if (String(input) === '/backup/jobs') {
        return makeJsonResponse({
          data: [
            runningJob({
              transferredSize: 1_000_000,
              totalSize: 10_000_000,
              lastKeepaliveAt: '2026-04-01T00:05:00.000Z',
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

    expect(screen.getByTestId('backup-job-stalled')).toBeTruthy();
    expect(screen.queryByTestId('backup-job-eta')).toBeNull();
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

  it('#2798: no stalled badge while the agent is alive, even if no file has finished for minutes', async () => {
    // lastProgressAt now advances only when bytes/files move; one large file
    // legitimately holds it still. The badge is about a silent agent, so it
    // keys on lastKeepaliveAt.
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
              lastProgressAt: '2026-04-01T00:05:00.000Z', // 5 min without a transfer
              lastKeepaliveAt: '2026-04-01T00:09:45.000Z', // agent alive 15s ago
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

  it('#2798: shows the stalled badge when the keepalive itself goes quiet', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-01T00:10:00.000Z'));

    fetchMock.mockImplementation(async (input) => {
      if (String(input) === '/backup/jobs') {
        return makeJsonResponse({
          data: [
            runningJob({
              transferredSize: 1000,
              totalSize: 10_000,
              lastProgressAt: '2026-04-01T00:02:00.000Z',
              lastKeepaliveAt: '2026-04-01T00:06:00.000Z', // 4 min silent
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
    expect(badge.getAttribute('title')).toContain('4');
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

  it('keeps the table rendered during a background poll refresh (no full-page spinner)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-01T00:00:10.000Z'));

    let call = 0;
    fetchMock.mockImplementation(async (input) => {
      if (String(input) === '/backup/jobs') {
        call += 1;
        if (call === 1) {
          return makeJsonResponse({
            data: [runningJob({ transferredSize: 1_000_000, totalSize: 10_000_000, fileCount: 2, totalFiles: 20 })],
          });
        }
        // Poll refresh: leave the request in flight so `loading` stays true.
        return new Promise<Response>(() => {});
      }
      return makeJsonResponse({ error: 'Not found' }, false, 404);
    });

    render(<BackupJobList />);
    await act(async () => {
      await flush();
    });
    expect(screen.getByText('Beta Server')).toBeTruthy();

    // Poll tick fires; the in-flight refresh keeps loading=true. The table must
    // stay rendered rather than being replaced by the full-page spinner.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
      await flush();
    });
    expect(screen.getByText('Beta Server')).toBeTruthy();
  });

  it('shows no speed when a running job makes no progress between polls (stalled)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-01T00:00:10.000Z'));

    fetchMock.mockImplementation(async (input) => {
      if (String(input) === '/backup/jobs') {
        return makeJsonResponse({
          data: [runningJob({ transferredSize: 2_000_000, totalSize: 10_000_000, fileCount: 4, totalFiles: 20 })],
        });
      }
      return makeJsonResponse({ error: 'Not found' }, false, 404);
    });

    render(<BackupJobList />);
    await act(async () => {
      await flush();
    });
    // First render uses the average-since-start fallback (no prior sample).
    expect(screen.getByText(/\/s$/)).toBeTruthy();

    // Second poll: identical byte count -> zero delta -> no speed shown.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
      await flush();
    });
    expect(screen.queryByText(/\/s$/)).toBeNull();
  });

  it('does not revert an optimistic cancel when a poll GET in flight reports running', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-01T00:00:10.000Z'));

    let listCall = 0;
    let releasePoll: (() => void) | undefined;
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/backup/jobs') {
        listCall += 1;
        const running = {
          data: [runningJob({ id: 'job-run', transferredSize: 1_000_000, totalSize: 10_000_000, fileCount: 2, totalFiles: 20 })],
        };
        if (listCall === 1) return makeJsonResponse(running);
        // Poll GET: resolve only when released, and it still reports "running".
        return new Promise<Response>((resolve) => {
          releasePoll = () => resolve(makeJsonResponse(running));
        });
      }
      if (url === '/backup/jobs/job-run/cancel') {
        return makeJsonResponse({ id: 'job-run', status: 'cancelled' });
      }
      return makeJsonResponse({ error: 'Not found' }, false, 404);
    });

    render(<BackupJobList />);
    await act(async () => {
      await flush();
    });

    // Poll GET goes in flight (pending) before the user cancels.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
      await flush();
    });

    // User stops the job — POST resolves, optimistic Cancelled shown.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Stop backup for Beta Server/i }));
      await flush();
    });
    // Scope to the job row — "Cancelled"/"Running" also appear as filter options.
    const rowAfterCancel = screen.getByText('Beta Server').closest('tr') as HTMLElement;
    expect(within(rowAfterCancel).getByText('Cancelled')).toBeTruthy();

    // The stale in-flight poll now resolves reporting "running"; it must not win.
    await act(async () => {
      releasePoll?.();
      await flush();
    });
    const rowAfterPoll = screen.getByText('Beta Server').closest('tr') as HTMLElement;
    expect(within(rowAfterPoll).getByText('Cancelled')).toBeTruthy();
    expect(within(rowAfterPoll).queryByText('Running')).toBeNull();
  });

  it('shows what a completed job stored, with uploaded and reused bytes', async () => {
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
              totalSize: 10_485_760,
              fileCount: 10,
              errorCount: 0,
              errorLog: null,
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
          status: 'completed',
          createdAt: '2026-04-01T17:59:00.000Z',
          updatedAt: '2026-04-01T18:03:00.000Z',
          totalSize: 10_485_760, // 10 MB protected
          referencedSize: 4_194_304, // 4 MB reused -> 6 MB uploaded
          dataAccounting: { protectedBytes: 10_485_760, uploadedBytes: 6_291_456, reusedBytes: 4_194_304, processedBytes: null, runKind: 'incremental', fullRunReason: null },
          fileCount: 10,
          errorLog: null,
        });
      }
      return makeJsonResponse({ error: 'Not found' }, false, 404);
    });

    render(<BackupJobList />);
    await screen.findByText('Alpha Workstation');
    fireEvent.click(screen.getByRole('button', { name: /View details for Alpha Workstation backup/i }));

    const summary = (await screen.findByText('What this run stored')).closest('[data-testid="backup-job-data-summary"]') as HTMLElement;
    expect(summary.textContent).toContain('10.0 MB');
    expect(summary.textContent).toContain('6.00 MB');
    expect(summary.textContent).toContain('Uploaded this run');
    expect(summary.textContent).toContain('Reused from earlier backups');
  });

  it('shows uploaded and reused bytes, and a Full chip with its reason, in the Size cell', async () => {
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
              totalSize: 10_485_760,
              errorCount: 0,
              errorLog: null,
              dataAccounting: { protectedBytes: 10_485_760, uploadedBytes: 10_485_760, reusedBytes: 0, processedBytes: null, runKind: 'full', fullRunReason: 'no_prior_snapshot' },
            },
            {
              id: 'job-2',
              type: 'file',
              deviceId: 'device-2',
              configId: 'config-1',
              deviceName: 'Beta Server',
              configName: 'Nightly',
              status: 'failed',
              startedAt: '2026-04-01T18:00:00.000Z',
              completedAt: '2026-04-01T18:02:00.000Z',
              createdAt: '2026-04-01T17:59:00.000Z',
              totalSize: 10_485_760,
              transferredSize: 6_291_456,
              errorCount: 0,
              errorLog: 'failed to upload file to s3: SlowDown',
              dataAccounting: { protectedBytes: null, uploadedBytes: null, reusedBytes: null, processedBytes: 6_291_456, runKind: 'incremental', fullRunReason: null },
            },
          ],
        });
      }
      return makeJsonResponse({ error: 'Not found' }, false, 404);
    });

    render(<BackupJobList />);

    const fullRow = (await screen.findByText('Alpha Workstation')).closest('tr') as HTMLElement;
    expect(within(fullRow).getByTestId('backup-job-data-summary').textContent).toContain('10.0 MB uploaded · 0 B reused');
    expect(within(fullRow).getByTestId('backup-run-full').getAttribute('title')).toBe('First backup for this device and destination');

    const failedRow = screen.getByText('Beta Server').closest('tr') as HTMLElement;
    const failedCell = within(failedRow).getByTestId('backup-job-data-summary');
    expect(failedCell.textContent).toContain('6.00 MB processed before it stopped');
    expect(failedCell.textContent).not.toMatch(/uploaded/i);
  });

  it('renders no data summary when an older API sends no dataAccounting', async () => {
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
              totalSize: 10_485_760,
              fileCount: 10,
              errorCount: 0,
              errorLog: null,
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
          status: 'completed',
          createdAt: '2026-04-01T17:59:00.000Z',
          updatedAt: '2026-04-01T18:03:00.000Z',
          totalSize: 10_485_760,
          referencedSize: null,
          fileCount: 10,
          errorLog: null,
        });
      }
      return makeJsonResponse({ error: 'Not found' }, false, 404);
    });

    render(<BackupJobList />);
    await screen.findByText('Alpha Workstation');
    fireEvent.click(screen.getByRole('button', { name: /View details for Alpha Workstation backup/i }));

    // Detail panel opens (snapshot/error sections load) but no data summary.
    await screen.findByText(/No error log recorded/i);
    expect(screen.queryByTestId('backup-job-data-summary')).toBeNull();
  });

  it('shows zero uploaded when reused exceeds the total (no negatives)', async () => {
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
        return makeJsonResponse({
          id: 'job-1',
          type: 'file',
          deviceId: 'device-1',
          configId: 'config-1',
          status: 'completed',
          createdAt: '2026-04-01T17:59:00.000Z',
          updatedAt: '2026-04-01T18:03:00.000Z',
          totalSize: 1024, // 1 KB protected
          referencedSize: 4096, // 4 KB referenced -> negative delta must clamp to 0
          dataAccounting: { protectedBytes: 1024, uploadedBytes: 0, reusedBytes: 4096, processedBytes: null, runKind: 'incremental', fullRunReason: null },
          fileCount: 10,
          errorLog: null,
        });
      }
      return makeJsonResponse({ error: 'Not found' }, false, 404);
    });

    render(<BackupJobList />);
    await screen.findByText('Alpha Workstation');
    fireEvent.click(screen.getByRole('button', { name: /View details for Alpha Workstation backup/i }));

    const savings = (await screen.findByText('What this run stored')).closest('[data-testid="backup-job-data-summary"]') as HTMLElement;
    // No negative byte value should ever be rendered.
    expect(savings.textContent).not.toMatch(/-\d/);
    expect(savings.textContent).toContain('1.00 KB'); // protected
  });

  it('surfaces the warning when a cancel returns HTTP 200 with a partial-delivery warning', async () => {
    const warning =
      'Job marked as cancelled but the stop signal could not be delivered to the agent. The backup may still be running on the device.';
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/backup/jobs') {
        return makeJsonResponse({
          data: [runningJob({ transferredSize: 100, totalSize: 1000, fileCount: 1, totalFiles: 2 })],
        });
      }
      if (url === '/backup/jobs/job-run/cancel') {
        // 200 OK, no success:false — a partial success runAction treats as
        // success. The `warning` must still reach the user.
        return makeJsonResponse({ id: 'job-run', status: 'cancelled', warning });
      }
      return makeJsonResponse({ error: 'Not found' }, false, 404);
    });

    render(<BackupJobList />);

    const stopButton = await screen.findByRole('button', { name: /Stop backup for Beta Server/i });
    fireEvent.click(stopButton);

    await waitFor(() => expect(showToastMock).toHaveBeenCalled());
    expect(showToastMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'warning', message: expect.stringContaining('still be running') })
    );
    // The partial failure must NOT be reported as a clean success.
    expect(showToastMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it('renders a recently-cancelled job as completed when an in-flight poll reports completed', async () => {
    // Pins that the reconcile uses TERMINAL_STATUSES (not a narrowed
    // `=== "cancelled"` check): the server winning with a DIFFERENT terminal
    // status must be accepted, not stuck showing "Cancelled".
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-01T00:00:10.000Z'));

    let listCall = 0;
    let releasePoll: (() => void) | undefined;
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/backup/jobs') {
        listCall += 1;
        if (listCall === 1) {
          return makeJsonResponse({
            data: [runningJob({ id: 'job-run', transferredSize: 1_000_000, totalSize: 10_000_000, fileCount: 2, totalFiles: 20 })],
          });
        }
        // Poll GET: resolve only when released, reporting a terminal "completed".
        const completed = {
          data: [
            runningJob({
              id: 'job-run',
              status: 'completed',
              completedAt: '2026-04-01T00:00:20.000Z',
              transferredSize: 10_000_000,
              totalSize: 10_000_000,
              fileCount: 20,
              totalFiles: 20,
            }),
          ],
        };
        return new Promise<Response>((resolve) => {
          releasePoll = () => resolve(makeJsonResponse(completed));
        });
      }
      if (url === '/backup/jobs/job-run/cancel') {
        return makeJsonResponse({ id: 'job-run', status: 'cancelled' });
      }
      return makeJsonResponse({ error: 'Not found' }, false, 404);
    });

    render(<BackupJobList />);
    await act(async () => {
      await flush();
    });

    // Poll GET goes in flight before the user cancels.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
      await flush();
    });

    // User stops the job — optimistic Cancelled shown.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Stop backup for Beta Server/i }));
      await flush();
    });
    const rowAfterCancel = screen.getByText('Beta Server').closest('tr') as HTMLElement;
    expect(within(rowAfterCancel).getByText('Cancelled')).toBeTruthy();

    // The in-flight poll resolves reporting "completed" — a terminal status the
    // reconcile must accept, replacing the optimistic Cancelled.
    await act(async () => {
      releasePoll?.();
      await flush();
    });
    const rowAfterPoll = screen.getByText('Beta Server').closest('tr') as HTMLElement;
    expect(within(rowAfterPoll).getByText('Completed')).toBeTruthy();
    expect(within(rowAfterPoll).queryByText('Cancelled')).toBeNull();
  });

  it('renders a partial job with its own status and never as "Queued"', async () => {
    // normalizeStatus() used to have no branch for `partial`, so it fell through
    // to "queued" — a finished backup showed a clock and looked stuck forever.
    fetchMock.mockImplementation(async (input) => {
      if (String(input) === '/backup/jobs') {
        return makeJsonResponse({ data: [partialJob()] });
      }
      return makeJsonResponse({ error: 'Not found' }, false, 404);
    });

    render(<BackupJobList />);

    // Scope to the job row — "Queued"/"Partial" also appear as filter options.
    const row = (await screen.findByText('Gamma Laptop')).closest('tr') as HTMLElement;
    expect(within(row).getByText('Partial')).toBeTruthy();
    expect(within(row).queryByText('Queued')).toBeNull();
    expect(within(row).queryByText('Completed')).toBeNull();
  });

  it('shows the failed file count on the collapsed row without expanding details', async () => {
    fetchMock.mockImplementation(async (input) => {
      if (String(input) === '/backup/jobs') {
        return makeJsonResponse({ data: [partialJob()] });
      }
      return makeJsonResponse({ error: 'Not found' }, false, 404);
    });

    render(<BackupJobList />);

    const row = (await screen.findByText('Gamma Laptop')).closest('tr') as HTMLElement;
    const failed = within(row).getByTestId('backup-job-failed-count');
    expect(failed.textContent).toContain('21');
    // The count must come from the list payload, not a details fetch.
    expect(fetchMock).not.toHaveBeenCalledWith('/backup/jobs/job-partial');
  });

  it('shows the failed file count for a completed job that had file errors', async () => {
    fetchMock.mockImplementation(async (input) => {
      if (String(input) === '/backup/jobs') {
        return makeJsonResponse({
          data: [partialJob({ status: 'completed', errorCount: 3 })],
        });
      }
      return makeJsonResponse({ error: 'Not found' }, false, 404);
    });

    render(<BackupJobList />);

    const row = (await screen.findByText('Gamma Laptop')).closest('tr') as HTMLElement;
    expect(within(row).getByText('Completed')).toBeTruthy();
    expect(within(row).getByTestId('backup-job-failed-count').textContent).toContain('3');
  });

  it('shows no failed-count indicator for a clean job', async () => {
    fetchMock.mockImplementation(async (input) => {
      if (String(input) === '/backup/jobs') {
        return makeJsonResponse({
          data: [partialJob({ status: 'completed', errorCount: 0, errorLog: null })],
        });
      }
      return makeJsonResponse({ error: 'Not found' }, false, 404);
    });

    render(<BackupJobList />);

    await screen.findByText('Gamma Laptop');
    expect(screen.queryByTestId('backup-job-failed-count')).toBeNull();
  });

  it('shows what a partial job stored', async () => {
    // A partial run still produced a restorable snapshot, so the dedup detail is
    // as meaningful as it is for a completed one.
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/backup/jobs') {
        return makeJsonResponse({ data: [partialJob({ totalSize: 10_485_760 })] });
      }
      if (url === '/backup/jobs/job-partial') {
        return makeJsonResponse({
          id: 'job-partial',
          type: 'file',
          deviceId: 'device-2',
          configId: 'config-1',
          status: 'partial',
          createdAt: '2026-04-01T17:59:00.000Z',
          updatedAt: '2026-04-01T18:05:00.000Z',
          totalSize: 10_485_760,
          referencedSize: 4_194_304,
          dataAccounting: { protectedBytes: 10_485_760, uploadedBytes: 6_291_456, reusedBytes: 4_194_304, processedBytes: null, runKind: 'incremental', fullRunReason: null },
          fileCount: 1,
          errorLog: 'access denied',
        });
      }
      return makeJsonResponse({ error: 'Not found' }, false, 404);
    });

    render(<BackupJobList />);
    await screen.findByText('Gamma Laptop');
    fireEvent.click(screen.getByRole('button', { name: /View details for Gamma Laptop backup/i }));

    const summary = (await screen.findByText('What this run stored')).closest('[data-testid="backup-job-data-summary"]') as HTMLElement;
    expect(summary.textContent).toContain('10.0 MB');
    expect(summary.textContent).toContain('6.00 MB');
    expect(summary.textContent).toContain('Uploaded this run');
    expect(summary.textContent).toContain('Reused from earlier backups');
  });

  it('renders a completed_with_errors job as its own amber status, never green Completed and never Partial', async () => {
    // Issue #5396: `completed_with_errors` contains the substring "complete", so
    // normalizeStatus() used to launder it into the green `completed` bucket.
    fetchMock.mockImplementation(async (input) => {
      if (String(input) === '/backup/jobs') {
        return makeJsonResponse({ data: [partialJob({ status: 'completed_with_errors' })] });
      }
      return makeJsonResponse({ error: 'Not found' }, false, 404);
    });

    render(<BackupJobList />);

    const row = (await screen.findByText('Gamma Laptop')).closest('tr') as HTMLElement;
    expect(within(row).getByText('Completed with errors')).toBeTruthy();
    expect(within(row).queryByText('Completed')).toBeNull();
    expect(within(row).queryByText('Partial')).toBeNull();
    expect(within(row).queryByText('Queued')).toBeNull();
  });

  it('shows what a completed_with_errors job stored', async () => {
    // A completed_with_errors run still produced a restorable snapshot, so the
    // dedup detail is as meaningful as it is for a completed/partial run.
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/backup/jobs') {
        return makeJsonResponse({
          data: [partialJob({ status: 'completed_with_errors', totalSize: 10_485_760 })],
        });
      }
      if (url === '/backup/jobs/job-partial') {
        return makeJsonResponse({
          id: 'job-partial',
          type: 'file',
          deviceId: 'device-2',
          configId: 'config-1',
          status: 'completed_with_errors',
          createdAt: '2026-04-01T17:59:00.000Z',
          updatedAt: '2026-04-01T18:05:00.000Z',
          totalSize: 10_485_760,
          referencedSize: 4_194_304,
          dataAccounting: { protectedBytes: 10_485_760, uploadedBytes: 6_291_456, reusedBytes: 4_194_304, processedBytes: null, runKind: 'incremental', fullRunReason: null },
          fileCount: 1,
          errorLog: 'access denied',
        });
      }
      return makeJsonResponse({ error: 'Not found' }, false, 404);
    });

    render(<BackupJobList />);
    await screen.findByText('Gamma Laptop');
    fireEvent.click(screen.getByRole('button', { name: /View details for Gamma Laptop backup/i }));

    const summary = (await screen.findByText('What this run stored')).closest('[data-testid="backup-job-data-summary"]') as HTMLElement;
    expect(summary.textContent).toContain('10.0 MB');
    expect(summary.textContent).toContain('6.00 MB');
    expect(summary.textContent).toContain('Uploaded this run');
    expect(summary.textContent).toContain('Reused from earlier backups');
  });

  it('shows a prominent "files not backed up" block for a completed_with_errors job with the failed count and error log', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/backup/jobs') {
        return makeJsonResponse({ data: [partialJob({ status: 'completed_with_errors', errorCount: 3 })] });
      }
      if (url === '/backup/jobs/job-partial') {
        return makeJsonResponse({
          id: 'job-partial',
          type: 'file',
          deviceId: 'device-2',
          configId: 'config-1',
          status: 'completed_with_errors',
          createdAt: '2026-04-01T17:59:00.000Z',
          errorCount: 3,
          errorLog: '3 file(s) could not be read during collection: C:\\x: permission denied',
        });
      }
      return makeJsonResponse({ error: 'Not found' }, false, 404);
    });

    render(<BackupJobList />);
    await screen.findByText('Gamma Laptop');
    fireEvent.click(screen.getByRole('button', { name: /View details for Gamma Laptop backup/i }));

    const block = await screen.findByTestId('backup-job-files-not-backed-up');
    expect(block.textContent).toContain('3');
    expect(block.textContent).toContain('permission denied');
  });

  it('shows the same prominent "files not backed up" block for a partial job', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/backup/jobs') {
        return makeJsonResponse({ data: [partialJob()] });
      }
      if (url === '/backup/jobs/job-partial') {
        return makeJsonResponse({
          id: 'job-partial',
          type: 'file',
          deviceId: 'device-2',
          configId: 'config-1',
          status: 'partial',
          createdAt: '2026-04-01T17:59:00.000Z',
          errorCount: 21,
          errorLog: 'access denied: C:\\Users\\a\\Documents',
        });
      }
      return makeJsonResponse({ error: 'Not found' }, false, 404);
    });

    render(<BackupJobList />);
    await screen.findByText('Gamma Laptop');
    fireEvent.click(screen.getByRole('button', { name: /View details for Gamma Laptop backup/i }));

    const block = await screen.findByTestId('backup-job-files-not-backed-up');
    expect(block.textContent).toContain('21');
  });

  it('shows the error summary in the Errors column for a failed job even when errorCount is 0', async () => {
    // The error is carried in errorLog, not errorCount, for a job that failed
    // outright (e.g. dispatch failure before any file was even attempted).
    // The Errors cell used to gate on `errorCount > 0` alone and showed "-",
    // hiding the one piece of information that explains the failure.
    fetchMock.mockImplementation(async (input) => {
      if (String(input) === '/backup/jobs') {
        return makeJsonResponse({
          data: [
            partialJob({
              status: 'failed',
              errorCount: 0,
              errorLog: 'dispatch failed: queue unavailable',
            }),
          ],
        });
      }
      return makeJsonResponse({ error: 'Not found' }, false, 404);
    });

    render(<BackupJobList />);

    const row = (await screen.findByText('Gamma Laptop')).closest('tr') as HTMLElement;
    expect(within(row).getByTestId('backup-job-error-summary').textContent).toContain(
      'dispatch failed: queue unavailable'
    );
    expect(within(row).queryByText('-')).toBeNull();
  });

  describe('failure category (#11027)', () => {
    const mockJobs = (...jobs: unknown[]) =>
      fetchMock.mockImplementation(async (input) => {
        const url = String(input);
        if (url === '/backup/jobs') return makeJsonResponse({ data: jobs });
        if (url === '/backup/jobs/job-partial') return makeJsonResponse(jobs[0]);
        return makeJsonResponse({ error: 'Not found' }, false, 404);
      });

    it('failed row shows category badge before the error summary', async () => {
      mockJobs(partialJob({
        status: 'failed',
        errorCount: 0,
        errorLog: 'failed to upload file to s3: SlowDown',
        failureCategory: 'storage',
      }));

      render(<BackupJobList />);

      const row = (await screen.findByText('Gamma Laptop')).closest('tr') as HTMLElement;
      const badge = within(row).getByTestId('backup-failure-category');
      const summary = within(row).getByTestId('backup-job-error-summary');
      expect(badge.getAttribute('data-category')).toBe('storage');
      expect(badge.textContent).toBe('Storage problem');
      expect(summary.textContent).toContain('failed to upload file to s3: SlowDown');
      expect(badge.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('shows the badge on a cancelled row that has no error text', async () => {
      mockJobs(partialJob({ status: 'cancelled', errorCount: 0, errorLog: null, failureCategory: 'cancelled' }));

      render(<BackupJobList />);

      const row = (await screen.findByText('Gamma Laptop')).closest('tr') as HTMLElement;
      expect(within(row).getByTestId('backup-failure-category').getAttribute('data-category')).toBe('cancelled');
      expect(within(row).queryByTestId('backup-job-error-summary')).toBeNull();
    });

    it('renders no badge when the API sends no category', async () => {
      mockJobs(partialJob({ status: 'completed', errorCount: 0, errorLog: null, failureCategory: null }));

      render(<BackupJobList />);

      const row = (await screen.findByText('Gamma Laptop')).closest('tr') as HTMLElement;
      expect(within(row).queryByTestId('backup-failure-category')).toBeNull();
      expect(within(row).getByText('-')).toBeTruthy();
    });

    it('explains the category with its hint in the expanded details', async () => {
      mockJobs(partialJob({
        status: 'failed',
        errorCount: 0,
        errorLog: 'backup helper exited unexpectedly',
        failureCategory: 'agent',
      }));

      render(<BackupJobList />);

      const row = (await screen.findByText('Gamma Laptop')).closest('tr') as HTMLElement;
      expect(screen.queryByText(/stopped unexpectedly/)).toBeNull();
      fireEvent.click(within(row).getByRole('button', { name: /details/i }));

      await screen.findByText(/The backup component on the device stopped unexpectedly/);
      expect(screen.getByRole('link', { name: 'Troubleshooting guide' })).toBeTruthy();
    });

    it('explains the category inside the files-not-backed-up block of a partial run', async () => {
      mockJobs(partialJob({ failureCategory: 'source_access' }));

      render(<BackupJobList />);

      const row = (await screen.findByText('Gamma Laptop')).closest('tr') as HTMLElement;
      fireEvent.click(within(row).getByRole('button', { name: /details/i }));

      const block = await screen.findByTestId('backup-job-files-not-backed-up');
      expect(within(block).getByTestId('backup-failure-category').getAttribute('data-category')).toBe('source_access');
      expect(within(block).getByText(/Some files were locked/)).toBeTruthy();
    });
  });

  it('strips the internal reaper tag prefix from the displayed error summary', async () => {
    fetchMock.mockImplementation(async (input) => {
      if (String(input) === '/backup/jobs') {
        return makeJsonResponse({
          data: [
            partialJob({
              status: 'failed',
              errorCount: 0,
              errorLog: '[stale-backup-reaper] snapshot lease expired, job requeued',
            }),
          ],
        });
      }
      return makeJsonResponse({ error: 'Not found' }, false, 404);
    });

    render(<BackupJobList />);

    const row = (await screen.findByText('Gamma Laptop')).closest('tr') as HTMLElement;
    const summary = within(row).getByTestId('backup-job-error-summary').textContent ?? '';
    expect(summary).toContain('snapshot lease expired, job requeued');
    expect(summary).not.toContain('[stale-backup-reaper]');
  });

  it('puts the full error text in the Errors cell tooltip, not the 60-character truncation', async () => {
    const longError =
      '[stale-backup-reaper] agent did not report within the lease window after it published the snapshot manifest; job marked failed';
    fetchMock.mockImplementation(async (input) => {
      if (String(input) === '/backup/jobs') {
        return makeJsonResponse({
          data: [partialJob({ status: 'failed', errorCount: 0, errorLog: longError })],
        });
      }
      return makeJsonResponse({ error: 'Not found' }, false, 404);
    });

    render(<BackupJobList />);

    const row = (await screen.findByText('Gamma Laptop')).closest('tr') as HTMLElement;
    const summary = within(row).getByTestId('backup-job-error-summary');
    // The cell stays short...
    expect(summary.textContent).toContain('...');
    // ...but hovering reveals the whole reason (tag prefix still stripped).
    expect(summary.getAttribute('title')).toBe(
      'agent did not report within the lease window after it published the snapshot manifest; job marked failed'
    );
  });

  it('shows "-" in the Errors column for a job with no error info', async () => {
    fetchMock.mockImplementation(async (input) => {
      if (String(input) === '/backup/jobs') {
        return makeJsonResponse({
          data: [partialJob({ status: 'completed', errorCount: 0, errorLog: null })],
        });
      }
      return makeJsonResponse({ error: 'Not found' }, false, 404);
    });

    render(<BackupJobList />);

    const row = (await screen.findByText('Gamma Laptop')).closest('tr') as HTMLElement;
    expect(within(row).queryByTestId('backup-job-error-summary')).toBeNull();
  });

  describe('skipped reparse points (#9543)', () => {
    // Verbatim shape of the agent's summarizeSkippedReparsePoints fragment.
    const reparseNote =
      '159 reparse point(s) were not backed up (junctions and mount points are skipped, not followed; 159 other): ' +
      'C:\\a.exe (other reparse point, tag 0x8000001B); C:\\b.exe (other reparse point, tag 0x8000001B); ' +
      'C:\\c.exe (other reparse point, tag 0x8000001B); C:\\d.exe (other reparse point, tag 0x8000001B); ' +
      'C:\\e.exe (other reparse point, tag 0x8000001B) (+154 more)';

    const mockJob = (status: string, errorLog: string) => {
      fetchMock.mockImplementation(async (input) => {
        const url = String(input);
        if (url === '/backup/jobs') {
          return makeJsonResponse({ data: [partialJob({ status, errorCount: 0, errorLog })] });
        }
        if (url === '/backup/jobs/job-partial') {
          return makeJsonResponse({
            id: 'job-partial',
            type: 'file',
            deviceId: 'device-2',
            configId: 'config-1',
            status,
            createdAt: '2026-04-01T17:59:00.000Z',
            errorCount: 0,
            errorLog,
          });
        }
        return makeJsonResponse({ error: 'Not found' }, false, 404);
      });
    };

    it('keeps the real failure reason in the Errors column and error log, and shows the skip as info', async () => {
      mockJob('failed', `backup stopped; ${reparseNote}`);

      render(<BackupJobList />);
      const row = (await screen.findByText('Gamma Laptop')).closest('tr') as HTMLElement;
      const summary = within(row).getByTestId('backup-job-error-summary');
      expect(summary.textContent).toContain('backup stopped');
      expect(summary.textContent).not.toContain('reparse');
      expect(summary.getAttribute('title')).toBe('backup stopped');

      fireEvent.click(screen.getByRole('button', { name: /View details for Gamma Laptop backup/i }));
      const notice = await screen.findByTestId('backup-job-reparse-skipped');
      expect(notice.textContent).toContain('159 reparse points skipped');
      // The agent's sampled paths stay reachable behind the disclosure.
      expect(notice.textContent).toContain('C:\\a.exe (other reparse point, tag 0x8000001B)');
      const errorLog = screen.getByText('Error Log').nextElementSibling as HTMLElement;
      expect(errorLog.textContent).toBe('backup stopped');
    });

    describe('the recoverable index drop note on historic rows (#11026)', () => {
      const indexNote = 'snapshot file index omitted (17950 entries): the result exceeded the 4934464 byte server result budget, so per-file restore browsing is unavailable for this snapshot';

      it('hides the note when it is all the row carries', async () => {
        mockJob('completed', `bounded: ${indexNote}`);
        render(<BackupJobList />);
        const row = (await screen.findByText('Gamma Laptop')).closest('tr') as HTMLElement;
        expect(within(row).queryByTestId('backup-job-error-summary')).toBeNull();
        expect(row.textContent).not.toContain('snapshot file index');

        fireEvent.click(screen.getByRole('button', { name: /View details for Gamma Laptop backup/i }));
        await waitFor(() => expect(screen.queryByText('Error Log')).toBeNull());
        expect(document.body.textContent).not.toContain('snapshot file index');
      });

      it('keeps the other text, in the Errors column and the error log', async () => {
        mockJob('failed', `disk full || bounded: ${indexNote}`);
        render(<BackupJobList />);
        const row = (await screen.findByText('Gamma Laptop')).closest('tr') as HTMLElement;
        const summary = within(row).getByTestId('backup-job-error-summary');
        expect(summary.textContent).toContain('disk full');
        expect(summary.textContent).not.toContain('snapshot file index');

        fireEvent.click(screen.getByRole('button', { name: /View details for Gamma Laptop backup/i }));
        const label = await screen.findByText('Error Log');
        expect((label.nextElementSibling as HTMLElement).textContent).toBe('disk full');
      });
    });

    it('shows no error at all for a completed run whose only note is skipped reparse points', async () => {
      mockJob('completed', reparseNote);

      render(<BackupJobList />);
      const row = (await screen.findByText('Gamma Laptop')).closest('tr') as HTMLElement;
      expect(within(row).queryByTestId('backup-job-error-summary')).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: /View details for Gamma Laptop backup/i }));
      expect((await screen.findByTestId('backup-job-reparse-skipped')).textContent).toContain('159');
      expect(screen.getByText('No error log recorded.')).toBeTruthy();
    });

    it('keeps the "files not backed up" block for a partial run with real file errors, without the skip text in it', async () => {
      fetchMock.mockImplementation(async (input) => {
        const url = String(input);
        if (url === '/backup/jobs') {
          return makeJsonResponse({ data: [partialJob({ errorCount: 21, errorLog: reparseNote })] });
        }
        if (url === '/backup/jobs/job-partial') {
          return makeJsonResponse({
            id: 'job-partial', type: 'file', deviceId: 'device-2', configId: 'config-1', status: 'partial',
            createdAt: '2026-04-01T17:59:00.000Z', errorCount: 21, errorLog: reparseNote,
          });
        }
        return makeJsonResponse({ error: 'Not found' }, false, 404);
      });

      render(<BackupJobList />);
      const row = (await screen.findByText('Gamma Laptop')).closest('tr') as HTMLElement;
      // errorCount still drives the Errors column when the log was only the skip.
      expect(within(row).getByTestId('backup-job-error-summary').textContent).toContain('21 errors');

      fireEvent.click(screen.getByRole('button', { name: /View details for Gamma Laptop backup/i }));
      const block = await screen.findByTestId('backup-job-files-not-backed-up');
      expect(block.textContent).toContain('21');
      expect(block.textContent).not.toContain('reparse');
      expect(screen.getByTestId('backup-job-reparse-skipped')).toBeTruthy();
    });

    it('does not open the "files not backed up" block for a completed_with_errors run on the skip alone', async () => {
      // errorCount 0 + a reparse-only note: the warning block must not claim
      // files failed when the only thing in errorLog is the deliberate skip.
      mockJob('completed_with_errors', reparseNote);

      render(<BackupJobList />);
      await screen.findByText('Gamma Laptop');
      fireEvent.click(screen.getByRole('button', { name: /View details for Gamma Laptop backup/i }));
      await screen.findByTestId('backup-job-reparse-skipped');
      expect(screen.queryByTestId('backup-job-files-not-backed-up')).toBeNull();
    });
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
