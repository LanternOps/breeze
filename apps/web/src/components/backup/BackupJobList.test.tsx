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

  it('shows the incremental savings line for a completed job with referencedSize', async () => {
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
          fileCount: 10,
          errorLog: null,
        });
      }
      return makeJsonResponse({ error: 'Not found' }, false, 404);
    });

    render(<BackupJobList />);
    await screen.findByText('Alpha Workstation');
    fireEvent.click(screen.getByRole('button', { name: /View details for Alpha Workstation backup/i }));

    const savings = await screen.findByTestId('backup-job-savings');
    expect(savings.textContent).toContain('10.0 MB');
    expect(savings.textContent).toContain('6.00 MB');
    expect(savings.textContent).toContain('protected');
    expect(savings.textContent).toContain('uploaded');
  });

  it('renders nothing new for a completed job with null referencedSize (legacy/full run)', async () => {
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

    // Detail panel opens (snapshot/error sections load) but no savings line.
    await screen.findByText(/No error log recorded/i);
    expect(screen.queryByTestId('backup-job-savings')).toBeNull();
  });

  it('clamps uploaded to zero when referencedSize exceeds totalSize (no negatives)', async () => {
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
          fileCount: 10,
          errorLog: null,
        });
      }
      return makeJsonResponse({ error: 'Not found' }, false, 404);
    });

    render(<BackupJobList />);
    await screen.findByText('Alpha Workstation');
    fireEvent.click(screen.getByRole('button', { name: /View details for Alpha Workstation backup/i }));

    const savings = await screen.findByTestId('backup-job-savings');
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
