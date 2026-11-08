import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import DeviceBackupTab from './DeviceBackupTab';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

vi.mock('../shared/Toast', () => ({
  showToast: vi.fn(),
}));

vi.mock('./BackupVerificationTab', () => ({
  default: () => <div>Verification stub</div>,
}));

vi.mock('./DeviceVaultStatus', () => ({
  default: () => <div>Vault stub</div>,
}));

vi.mock('../shared/AlphaBadge', () => ({
  default: () => <span>Alpha</span>,
}));

let externalPresent = true;
vi.mock('./ExternalBackupCard', () => ({
  default: ({ onPresenceChange }: { onPresenceChange?: (p: boolean) => void }) => {
    onPresenceChange?.(externalPresent);
    return externalPresent ? <div data-testid="stub-external-backup" /> : null;
  },
}));

const fetchMock = vi.mocked(fetchWithAuth);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

describe('DeviceBackupTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    externalPresent = true;

    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init as RequestInit | undefined)?.method ?? 'GET';

      if (url === '/backup/status/device-1') {
        return makeJsonResponse({
          data: {
            protected: true,
            lastSuccessAt: '2026-03-30T01:00:00Z',
            nextScheduledAt: '2026-04-01T01:00:00Z',
          },
        });
      }

      if (url === '/backup/jobs?deviceId=device-1') {
        return makeJsonResponse({
          data: [
            {
              id: 'job-1',
              deviceId: 'device-1',
              type: 'file',
              status: 'completed',
              startedAt: '2026-03-30T00:00:00Z',
              completedAt: '2026-03-30T00:10:00Z',
              totalSize: 1024,
              errorCount: 0,
            },
          ],
        });
      }

      if (url === '/backup/snapshots?deviceId=device-1' && method === 'GET') {
        return makeJsonResponse({
          data: [
            {
              id: 'snap-1',
              deviceId: 'device-1',
              label: 'Nightly Snapshot',
              createdAt: '2026-03-30T00:00:00Z',
              sizeBytes: 1024,
              fileCount: 3,
              location: 'snapshots/provider-snap-1',
              expiresAt: '2026-04-30T00:00:00Z',
              legalHold: false,
              legalHoldReason: null,
              isImmutable: false,
              immutableUntil: null,
              immutabilityEnforcement: null,
              requestedImmutabilityEnforcement: null,
              immutabilityFallbackReason: null,
            },
          ],
        });
      }

      if (url === '/backup/snapshots/snap-1/legal-hold' && method === 'POST') {
        return makeJsonResponse({
          id: 'snap-1',
          deviceId: 'device-1',
          label: 'Nightly Snapshot',
          createdAt: '2026-03-30T00:00:00Z',
          sizeBytes: 1024,
          fileCount: 3,
          location: 'snapshots/provider-snap-1',
          expiresAt: '2026-04-30T00:00:00Z',
          legalHold: true,
          legalHoldReason: 'Litigation hold',
          isImmutable: false,
          immutableUntil: null,
          immutabilityEnforcement: null,
          requestedImmutabilityEnforcement: null,
          immutabilityFallbackReason: null,
        });
      }

      return makeJsonResponse({}, false, 404);
    });
  });

  it('adds an Integrity column with a badge per restore point (#9626)', async () => {
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input) === '/backup/snapshots?deviceId=device-1') {
        const payload = await (await base(input, init)).json();
        return makeJsonResponse({ data: payload.data.map((row: object) => ({ ...row, integrityStatus: 'attested' })) });
      }
      return base(input, init);
    });
    render(<DeviceBackupTab deviceId="device-1" />);
    await screen.findByText('Restore Points');
    const table = (await screen.findByRole('columnheader', { name: 'Integrity' })).closest('table')!;
    expect(within(table).getByTestId('snapshot-integrity-badge').textContent).toBe('Verified');
  });

  it('shows restore-point protection controls for the selected snapshot', async () => {
    render(<DeviceBackupTab deviceId="device-1" />);

    await screen.findByText('Restore Points');
    expect(screen.getByText('Protection Controls')).toBeTruthy();
    expect(screen.getAllByText('Nightly Snapshot').length).toBeGreaterThan(0);
    const jobHistoryHeading = screen.getByText('Job History');
    const jobHistoryCard = jobHistoryHeading.parentElement;
    const jobHistoryTable = jobHistoryCard?.querySelector('table');

    expect(jobHistoryTable).toBeTruthy();
    expect(within(jobHistoryTable as HTMLTableElement).getByText('1.00 KB')).toBeTruthy();
  });

  it('applies legal hold from the device tab', async () => {
    render(<DeviceBackupTab deviceId="device-1" />);

    await screen.findByText('Protection Controls');
    fireEvent.change(screen.getByPlaceholderText(/Reason for applying or releasing protection/i), {
      target: { value: 'Litigation hold' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Apply legal hold/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/backup/snapshots/snap-1/legal-hold',
      expect.objectContaining({ method: 'POST' }),
    ));
    expect(await screen.findByText(/Legal hold applied to the selected restore point/i)).toBeTruthy();
  });

  it('runs a backup now and refreshes on success', async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init as RequestInit | undefined)?.method ?? 'GET';

      if (url === '/backup/jobs/run/device-1' && method === 'POST') {
        return makeJsonResponse({ data: { id: 'job-2' } });
      }

      if (url === '/backup/status/device-1') {
        return makeJsonResponse({
          data: {
            protected: true,
            lastSuccessAt: '2026-03-30T01:00:00Z',
            nextScheduledAt: '2026-04-01T01:00:00Z',
          },
        });
      }

      if (url === '/backup/jobs?deviceId=device-1') {
        return makeJsonResponse({ data: [] });
      }

      if (url === '/backup/snapshots?deviceId=device-1' && method === 'GET') {
        return makeJsonResponse({ data: [] });
      }

      return makeJsonResponse({}, false, 404);
    });

    render(<DeviceBackupTab deviceId="device-1" />);

    const runButton = await screen.findByRole('button', { name: /Run backup now/i });
    expect(runButton).not.toBeDisabled();
    fireEvent.click(runButton);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/backup/jobs/run/device-1',
      expect.objectContaining({ method: 'POST' }),
    ));
    expect(await screen.findByText(/Backup started for this device/i)).toBeTruthy();
  });

  it('shows a friendly message when a backup is already running (409)', async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init as RequestInit | undefined)?.method ?? 'GET';

      if (url === '/backup/jobs/run/device-1' && method === 'POST') {
        return makeJsonResponse({ error: 'already running' }, false, 409);
      }

      if (url === '/backup/status/device-1') {
        return makeJsonResponse({
          data: {
            protected: true,
            lastSuccessAt: '2026-03-30T01:00:00Z',
            nextScheduledAt: '2026-04-01T01:00:00Z',
          },
        });
      }

      if (url === '/backup/jobs?deviceId=device-1') {
        return makeJsonResponse({ data: [] });
      }

      if (url === '/backup/snapshots?deviceId=device-1' && method === 'GET') {
        return makeJsonResponse({ data: [] });
      }

      return makeJsonResponse({}, false, 404);
    });

    render(<DeviceBackupTab deviceId="device-1" />);

    const runButton = await screen.findByRole('button', { name: /Run backup now/i });
    fireEvent.click(runButton);

    expect(await screen.findByText(/A backup is already running for this device/i)).toBeTruthy();
  });

  it('disables the run-backup button when no policy is assigned', async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init as RequestInit | undefined)?.method ?? 'GET';

      if (url === '/backup/status/device-1') {
        return makeJsonResponse({
          data: {
            protected: false,
            lastJob: { id: 'job-1', status: 'completed' },
          },
        });
      }

      if (url === '/backup/jobs?deviceId=device-1') {
        return makeJsonResponse({
          data: [{ id: 'job-1', deviceId: 'device-1', type: 'file', status: 'completed', startedAt: '2026-03-30T00:00:00Z' }],
        });
      }

      if (url === '/backup/snapshots?deviceId=device-1' && method === 'GET') {
        return makeJsonResponse({ data: [] });
      }

      return makeJsonResponse({}, false, 404);
    });

    render(<DeviceBackupTab deviceId="device-1" />);

    const runButton = await screen.findByRole('button', { name: /Run backup now/i });
    expect(runButton).toBeDisabled();
  });

  it('shows, as visible text, why Run backup now is disabled on an unprotected device (#7213)', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/backup/status/device-1') return makeJsonResponse({ data: { protected: false } });
      if (url === '/backup/jobs?deviceId=device-1') return makeJsonResponse({ data: [] });
      if (url === '/backup/snapshots?deviceId=device-1') return makeJsonResponse({ data: [] });
      return makeJsonResponse({}, false, 404);
    });

    render(<DeviceBackupTab deviceId="device-1" />);

    expect(await screen.findByRole('button', { name: /Run backup now/i })).toBeDisabled();
    // A title tooltip is invisible on a disabled button — the reason must be text.
    expect(screen.getByText(/Assign a backup policy to protect this device/i, { selector: 'p,span' })).toBeTruthy();
  });

  describe('failure category (#11027)', () => {
    const baseJob = {
      id: 'job-bad',
      deviceId: 'device-1',
      type: 'file',
      startedAt: '2026-03-30T00:00:00Z',
      completedAt: '2026-03-30T00:10:00Z',
      errorCount: 0,
    };
    const mockTab = ({ lastJob, jobs }: { lastJob?: unknown; jobs?: unknown[] }) =>
      fetchMock.mockImplementation(async (input) => {
        const url = String(input);
        if (url === '/backup/status/device-1') {
          return makeJsonResponse({ data: { protected: true, lastJob: lastJob ?? null } });
        }
        if (url === '/backup/jobs?deviceId=device-1') return makeJsonResponse({ data: jobs ?? [] });
        if (url === '/backup/snapshots?deviceId=device-1') return makeJsonResponse({ data: [] });
        return makeJsonResponse({}, false, 404);
      });
    const historyRow = async () => {
      const card = (await screen.findByText('Job History')).parentElement as HTMLElement;
      return (await within(card).findAllByRole('row'))[1] as HTMLElement;
    };

    it('job history Errors cell shows the category for failed jobs', async () => {
      const longError = `[stale-backup-reaper] ${'x'.repeat(80)}`;
      mockTab({ jobs: [{ ...baseJob, status: 'failed', errorLog: longError, failureCategory: 'timeout' }] });

      render(<DeviceBackupTab deviceId="device-1" />);

      const row = await historyRow();
      expect(within(row).getByTestId('backup-failure-category').getAttribute('data-category')).toBe('timeout');
      const summary = within(row).getByTestId('backup-job-error-summary');
      // BackupJobList's rule: the tag is stripped, 57 characters plus an ellipsis, full text on hover.
      expect(summary.textContent).toBe(`${'x'.repeat(57)}...`);
      expect(summary.getAttribute('title')).toBe('x'.repeat(80));
    });

    it('job history Size cell shows uploaded vs reused bytes and the Full chip (#11027)', async () => {
      mockTab({
        jobs: [{
          ...baseJob,
          status: 'completed',
          totalSize: 10_485_760,
          dataAccounting: { protectedBytes: 10_485_760, uploadedBytes: 10_485_760, reusedBytes: 0, processedBytes: null, runKind: 'full', fullRunReason: 'unrecorded' },
        }],
      });

      render(<DeviceBackupTab deviceId="device-1" />);

      const row = await historyRow();
      expect(within(row).getByTestId('backup-job-data-summary').textContent).toContain('10.0 MB uploaded · 0 B reused');
      expect(within(row).getByTestId('backup-run-full').getAttribute('title')).toBe(
        'Reason not recorded (this backup ran before Breeze tracked it)',
      );
    });

    it.each(['running', 'pending'] as const)('job history Size cell shows a dash, not the job total, while a job is %s (#11280)', async (status) => {
      mockTab({
        jobs: [{
          ...baseJob,
          status,
          totalSize: 10_485_760,
          dataAccounting: { protectedBytes: null, uploadedBytes: null, reusedBytes: null, processedBytes: 1024, runKind: 'incremental', fullRunReason: null },
        }],
      });

      render(<DeviceBackupTab deviceId="device-1" />);

      const row = await historyRow();
      expect(within(row).queryByTestId('backup-job-data-summary')).toBeNull();
      expect(row.textContent).not.toContain('10.0 MB');
      expect(within(row).getByTestId('backup-job-size').textContent).toBe('-');
    });

    it('keeps the recoverable index drop note out of the job history Errors cell (#11026)', async () => {
      const indexNote = 'snapshot file index omitted (17950 entries): the result exceeded the 4934464 byte server result budget, so per-file restore browsing is unavailable for this snapshot';
      mockTab({ jobs: [{ ...baseJob, status: 'failed', errorLog: `backup stopped || bounded: ${indexNote}`, failureCategory: 'cancelled' }] });

      render(<DeviceBackupTab deviceId="device-1" />);

      const row = await historyRow();
      expect(within(row).getByTestId('backup-job-error-summary').textContent).toBe('backup stopped');
      expect(row.textContent).not.toContain('snapshot file index');
    });

    it('keeps the failed-file count next to the category', async () => {
      mockTab({ jobs: [{ ...baseJob, status: 'partial', errorCount: 4, errorLog: 'a.txt: in use', failureCategory: 'source_access' }] });

      render(<DeviceBackupTab deviceId="device-1" />);

      const row = await historyRow();
      expect(within(row).getByTestId('backup-failure-category')).toBeTruthy();
      expect(within(row).getByTestId('backup-job-error-count').textContent).toBe('4');
    });

    it('still shows 0 and no badge for a clean job', async () => {
      mockTab({ jobs: [{ ...baseJob, status: 'completed', errorLog: null, failureCategory: null }] });

      render(<DeviceBackupTab deviceId="device-1" />);

      const row = await historyRow();
      expect(within(row).queryByTestId('backup-failure-category')).toBeNull();
      expect(within(row).queryByTestId('backup-job-error-summary')).toBeNull();
      expect(within(row).getByText('0')).toBeTruthy();
    });

    it('last-run banner title uses the category label', async () => {
      mockTab({
        lastJob: { ...baseJob, status: 'failed', errorLog: 'backup helper exited unexpectedly', failureCategory: 'agent' },
      });

      render(<DeviceBackupTab deviceId="device-1" />);

      const banner = await screen.findByTestId('backup-last-job-diagnostic');
      expect(within(banner).getByText('Last backup failed: Agent problem')).toBeTruthy();
      expect(within(banner).getByText('backup helper exited unexpectedly')).toBeTruthy();
      expect(within(banner).getByText(/The backup component on the device stopped unexpectedly/)).toBeTruthy();
      expect(within(banner).getByRole('link', { name: 'Troubleshooting guide' })).toBeTruthy();
    });

    it('keeps the plain banner title when the API sends no category', async () => {
      mockTab({ lastJob: { ...baseJob, status: 'failed', errorLog: 'backup helper exited unexpectedly' } });

      render(<DeviceBackupTab deviceId="device-1" />);

      const banner = await screen.findByTestId('backup-last-job-diagnostic');
      expect(within(banner).getByText('Last backup failed')).toBeTruthy();
      expect(within(banner).queryByRole('link')).toBeNull();
    });

    it('does not put a category on a banner for a run that did not fail', async () => {
      mockTab({
        lastJob: { ...baseJob, status: 'completed_with_errors', errorCount: 2, errorLog: 'a.txt: in use', failureCategory: 'source_access' },
      });

      render(<DeviceBackupTab deviceId="device-1" />);

      const banner = await screen.findByTestId('backup-last-job-diagnostic');
      expect(banner.textContent).toContain('Last backup completed with errors');
      expect(within(banner).queryByTestId('backup-failure-category')).toBeNull();
      expect(within(banner).queryByRole('link')).toBeNull();
      expect(banner.textContent).not.toContain('Some files were locked');
    });

    it('shows the diagnostic instead of 0 for a job with warning text but no category', async () => {
      mockTab({
        jobs: [{ ...baseJob, status: 'completed', errorLog: 'VSS shadow copy could not be created', failureCategory: null }],
      });

      render(<DeviceBackupTab deviceId="device-1" />);

      const row = await historyRow();
      expect(within(row).getByTestId('backup-job-error-summary').textContent).toBe('VSS shadow copy could not be created');
      expect(within(row).queryByTestId('backup-failure-category')).toBeNull();
      expect(within(row).queryByText('0')).toBeNull();
    });

    it('still shows 0 for a job whose only note is skipped reparse points', async () => {
      const reparseOnly =
        '1 reparse point(s) were not backed up (junctions and mount points are skipped, not followed; 1 other): ' +
        'C:\\a.exe (other reparse point, tag 0x8000001B)';
      mockTab({ jobs: [{ ...baseJob, status: 'completed', errorLog: reparseOnly, failureCategory: null }] });

      render(<DeviceBackupTab deviceId="device-1" />);

      const row = await historyRow();
      expect(within(row).queryByTestId('backup-job-error-summary')).toBeNull();
      expect(within(row).getByText('0')).toBeTruthy();
    });
  });

  it('keeps line breaks in the completed-with-errors file list (#7213)', async () => {
    const errorLog = '2 file(s) could not be read:\nC:\\a.txt: permission denied\nC:\\b.txt: in use';
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/backup/status/device-1') {
        return makeJsonResponse({
          data: {
            protected: true,
            lastJob: { id: 'j', deviceId: 'device-1', type: 'file', status: 'completed_with_errors', startedAt: '2026-03-30T00:00:00Z', errorCount: 2, errorLog },
          },
        });
      }
      if (url === '/backup/jobs?deviceId=device-1') return makeJsonResponse({ data: [] });
      if (url === '/backup/snapshots?deviceId=device-1') return makeJsonResponse({ data: [] });
      return makeJsonResponse({}, false, 404);
    });

    render(<DeviceBackupTab deviceId="device-1" />);

    const banner = await screen.findByTestId('backup-last-job-diagnostic');
    const body = banner.querySelector('p.mt-1');
    expect(body?.textContent).toContain('C:\\a.txt: permission denied\nC:\\b.txt: in use');
    expect(body?.className).toContain('whitespace-pre-line');
  });

  describe('skipped reparse points (#9543)', () => {
    const reparseNote =
      '2 reparse point(s) were not backed up (junctions and mount points are skipped, not followed; 2 other): ' +
      'C:\\a.exe (other reparse point, tag 0x8000001B); C:\\b.exe (other reparse point, tag 0x8000001B)';

    const mockLastJob = (status: string, errorLog: string) => {
      fetchMock.mockImplementation(async (input) => {
        const url = String(input);
        if (url === '/backup/status/device-1') {
          return makeJsonResponse({
            data: {
              protected: true,
              lastJob: { id: 'j', deviceId: 'device-1', type: 'file', status, startedAt: '2026-03-30T00:00:00Z', errorCount: 0, errorLog },
            },
          });
        }
        if (url === '/backup/jobs?deviceId=device-1') return makeJsonResponse({ data: [] });
        if (url === '/backup/snapshots?deviceId=device-1') return makeJsonResponse({ data: [] });
        return makeJsonResponse({}, false, 404);
      });
    };

    it('shows a completed run that only skipped reparse points as info, not a warning banner', async () => {
      mockLastJob('completed', reparseNote);

      render(<DeviceBackupTab deviceId="device-1" />);

      expect((await screen.findByTestId('backup-job-reparse-skipped')).textContent).toContain('2 reparse points skipped');
      expect(screen.queryByTestId('backup-last-job-diagnostic')).toBeNull();
    });

    it('keeps the failure banner to the real reason when the run also skipped reparse points', async () => {
      mockLastJob('failed', `backup stopped; ${reparseNote}`);

      render(<DeviceBackupTab deviceId="device-1" />);

      const banner = await screen.findByTestId('backup-last-job-diagnostic');
      expect(banner.querySelector('p.mt-1')?.textContent).toBe('backup stopped');
      expect(screen.getByTestId('backup-job-reparse-skipped')).toBeTruthy();
    });
  });

  it('shows the provider fallback warning on a restore point', async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init as RequestInit | undefined)?.method ?? 'GET';

      if (url === '/backup/status/device-1') {
        return makeJsonResponse({
          data: {
            protected: true,
          },
        });
      }

      if (url === '/backup/jobs?deviceId=device-1') {
        return makeJsonResponse({ data: [] });
      }

      if (url === '/backup/snapshots?deviceId=device-1' && method === 'GET') {
        return makeJsonResponse({
          data: [
            {
              id: 'snap-1',
              deviceId: 'device-1',
              label: 'Nightly Snapshot',
              createdAt: '2026-03-30T00:00:00Z',
              sizeBytes: 1024,
              fileCount: 3,
              location: 'snapshots/provider-snap-1',
              expiresAt: '2026-04-30T00:00:00Z',
              legalHold: false,
              legalHoldReason: null,
              isImmutable: true,
              immutableUntil: '2026-04-30T00:00:00Z',
              immutabilityEnforcement: 'application',
              requestedImmutabilityEnforcement: 'provider',
              immutabilityFallbackReason: 'Bucket object lock no longer enabled',
            },
          ],
        });
      }

      return makeJsonResponse({}, false, 404);
    });

    render(<DeviceBackupTab deviceId="device-1" />);

    expect(await screen.findByText(/Provider immutability was requested by policy/i)).toBeTruthy();
    expect(screen.getByText(/Bucket object lock no longer enabled/i)).toBeTruthy();
  });

  it('formats status times in the timezone passed via prop', async () => {
    // Default mock has no status.timezone, so the prop zone is used.
    render(<DeviceBackupTab deviceId="device-1" timezone="America/New_York" />);

    await screen.findByText('Job History');
    // 2026-03-30T01:00:00Z renders in US Eastern (EDT during DST).
    const easternLabels = await screen.findAllByText(/EDT/);
    expect(easternLabels.length).toBeGreaterThan(0);
  });

  it('prefers status.timezone over the prop when both are present', async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init as RequestInit | undefined)?.method ?? 'GET';

      if (url === '/backup/status/device-1') {
        return makeJsonResponse({
          data: {
            protected: true,
            lastSuccessAt: '2026-03-30T01:00:00Z',
            nextScheduledAt: '2026-04-01T01:00:00Z',
            timezone: 'America/Los_Angeles',
          },
        });
      }

      if (url === '/backup/jobs?deviceId=device-1') {
        return makeJsonResponse({ data: [] });
      }

      if (url === '/backup/snapshots?deviceId=device-1' && method === 'GET') {
        return makeJsonResponse({ data: [] });
      }

      return makeJsonResponse({}, false, 404);
    });

    render(<DeviceBackupTab deviceId="device-1" timezone="America/New_York" />);

    await screen.findByText('Job History');
    // status.timezone (Pacific) wins over the Eastern prop.
    const pacificLabels = await screen.findAllByText(/PDT/);
    expect(pacificLabels.length).toBeGreaterThan(0);
    expect(screen.queryByText(/EDT/)).toBeNull();
  });

  it('renders without crashing when the timezone is an invalid IANA id', async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init as RequestInit | undefined)?.method ?? 'GET';

      if (url === '/backup/status/device-1') {
        return makeJsonResponse({
          data: {
            protected: true,
            lastSuccessAt: '2026-03-30T01:00:00Z',
            nextScheduledAt: '2026-04-01T01:00:00Z',
            // Windows OS zone id — not a valid IANA zone, would throw RangeError.
            timezone: 'Pacific Standard Time',
          },
        });
      }

      if (url === '/backup/jobs?deviceId=device-1') {
        return makeJsonResponse({ data: [] });
      }

      if (url === '/backup/snapshots?deviceId=device-1' && method === 'GET') {
        return makeJsonResponse({ data: [] });
      }

      return makeJsonResponse({}, false, 404);
    });

    render(<DeviceBackupTab deviceId="device-1" timezone="America/New_York" />);

    // Tab still renders (falls back to browser-local instead of blanking).
    await screen.findByText('Job History');
    expect(screen.getByText(/Last success:/)).toBeTruthy();
    expect(screen.getByText(/Next:/)).toBeTruthy();
  });

  it('disables the run-backup button when the device is offline', async () => {
    // Default mock: protected policy assigned, but the device is offline.
    render(<DeviceBackupTab deviceId="device-1" deviceStatus="offline" />);

    const runButton = await screen.findByRole('button', { name: /Run backup now/i });
    expect(runButton).toBeDisabled();
  });

  it('shows the "already running" 409 message in the neutral (non-success) banner', async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init as RequestInit | undefined)?.method ?? 'GET';

      if (url === '/backup/jobs/run/device-1' && method === 'POST') {
        return makeJsonResponse({ error: 'already running' }, false, 409);
      }

      if (url === '/backup/status/device-1') {
        return makeJsonResponse({ data: { protected: true } });
      }

      if (url === '/backup/jobs?deviceId=device-1') {
        return makeJsonResponse({ data: [] });
      }

      if (url === '/backup/snapshots?deviceId=device-1' && method === 'GET') {
        return makeJsonResponse({ data: [] });
      }

      return makeJsonResponse({}, false, 404);
    });

    render(<DeviceBackupTab deviceId="device-1" />);

    const runButton = await screen.findByRole('button', { name: /Run backup now/i });
    fireEvent.click(runButton);

    const banner = await screen.findByText(/A backup is already running for this device/i);
    // Not styled as the emerald/success banner.
    expect(banner.className).not.toMatch(/emerald/);
  });

  it('labels a partial job "Partial", never "Pending"', async () => {
    // The `?? jobStatusConfig.pending` fallback silently mislabels any status
    // missing from the map — a finished-but-degraded run read as still queued.
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init as RequestInit | undefined)?.method ?? 'GET';

      if (url === '/backup/status/device-1') {
        return makeJsonResponse({ data: { protected: true } });
      }

      if (url === '/backup/jobs?deviceId=device-1') {
        return makeJsonResponse({
          data: [
            {
              id: 'job-partial',
              deviceId: 'device-1',
              type: 'file',
              status: 'partial',
              startedAt: '2026-03-30T00:00:00Z',
              completedAt: '2026-03-30T00:10:00Z',
              totalSize: 1024,
              errorCount: 21,
            },
          ],
        });
      }

      if (url === '/backup/snapshots?deviceId=device-1' && method === 'GET') {
        return makeJsonResponse({ data: [] });
      }

      return makeJsonResponse({}, false, 404);
    });

    render(<DeviceBackupTab deviceId="device-1" />);

    const jobHistoryTable = (await screen.findByText('Job History')).parentElement?.querySelector('table');
    expect(jobHistoryTable).toBeTruthy();
    expect(within(jobHistoryTable as HTMLTableElement).getByText('Partial')).toBeTruthy();
    expect(within(jobHistoryTable as HTMLTableElement).queryByText('Pending')).toBeNull();
  });

  it('labels a completed_with_errors job "Completed with errors", never "Pending" or "Completed", and surfaces the failed-file summary (#5396)', async () => {
    // completed_with_errors contains "complete", so a naive `.includes('complete')`
    // check (or the `?? jobStatusConfig.pending` fallback) would launder it into
    // a clean green "Completed" or an unlabelled "Pending".
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init as RequestInit | undefined)?.method ?? 'GET';

      if (url === '/backup/status/device-1') {
        return makeJsonResponse({
          data: {
            protected: true,
            lastJob: {
              id: 'job-cwe',
              deviceId: 'device-1',
              type: 'file',
              status: 'completed_with_errors',
              startedAt: '2026-03-30T00:00:00Z',
              completedAt: '2026-03-30T00:10:00Z',
              totalSize: 1024,
              errorCount: 3,
              errorLog: "3 file(s) could not be read during collection: C:\\x: permission denied",
            },
          },
        });
      }

      if (url === '/backup/jobs?deviceId=device-1') {
        return makeJsonResponse({
          data: [
            {
              id: 'job-cwe',
              deviceId: 'device-1',
              type: 'file',
              status: 'completed_with_errors',
              startedAt: '2026-03-30T00:00:00Z',
              completedAt: '2026-03-30T00:10:00Z',
              totalSize: 1024,
              errorCount: 3,
            },
          ],
        });
      }

      if (url === '/backup/snapshots?deviceId=device-1' && method === 'GET') {
        return makeJsonResponse({ data: [] });
      }

      return makeJsonResponse({}, false, 404);
    });

    render(<DeviceBackupTab deviceId="device-1" />);

    const jobHistoryTable = (await screen.findByText('Job History')).parentElement?.querySelector('table');
    expect(jobHistoryTable).toBeTruthy();
    expect(within(jobHistoryTable as HTMLTableElement).getByText('Completed with errors')).toBeTruthy();
    expect(within(jobHistoryTable as HTMLTableElement).queryByText('Pending')).toBeNull();
    expect(within(jobHistoryTable as HTMLTableElement).queryByText('Completed')).toBeNull();
    expect(within(jobHistoryTable as HTMLTableElement).getByText('3')).toBeTruthy();

    const diagnostic = await screen.findByTestId('backup-last-job-diagnostic');
    expect(diagnostic.textContent).toContain('Last backup completed with errors');
    expect(diagnostic.textContent).toContain('permission denied');
  });

  describe('VSS status panel (#3027)', () => {
    function mockStatusWithVss(vssMetadata: unknown, lastJobExtra: Record<string, unknown> = {}) {
      fetchMock.mockImplementation(async (input, init) => {
        const url = String(input);
        const method = (init as RequestInit | undefined)?.method ?? 'GET';

        if (url === '/backup/status/device-1') {
          return makeJsonResponse({
            data: {
              protected: true,
              lastJob: {
                id: 'job-vss',
                status: 'completed',
                createdAt: '2026-03-30T00:00:00Z',
                completedAt: '2026-03-30T00:10:00Z',
                vssMetadata,
                ...lastJobExtra,
              },
            },
          });
        }
        if (url === '/backup/jobs?deviceId=device-1') return makeJsonResponse({ data: [] });
        if (url === '/backup/snapshots?deviceId=device-1' && method === 'GET') {
          return makeJsonResponse({ data: [] });
        }
        return makeJsonResponse({}, false, 404);
      });
    }

    it('renders the writer table once the API actually returns vssMetadata', async () => {
      // The panel existed but was unreachable: lastJob's projection omitted
      // vssMetadata, so showVssStatus was permanently false and this whole
      // branch was dead code.
      mockStatusWithVss({
        shadowCopyId: 'set-1',
        writers: [
          { name: 'SqlServerWriter', state: 'stable' },
          { name: 'NTDS', state: 'failed' },
        ],
      });

      render(<DeviceBackupTab deviceId="device-1" />);

      expect(await screen.findByText('SqlServerWriter')).toBeTruthy();
      expect(screen.getByText('NTDS')).toBeTruthy();
      // A non-stable writer still raises the existing writer banner.
      expect(screen.getByText(/writers are not stable/i)).toBeTruthy();
    });

    it('flags unprotected volumes on a SUCCESSFUL run — "backed up" vs "backed up but read live"', async () => {
      // The signal that motivated the issue: every writer stable, job green,
      // and yet a whole volume was read off the live filesystem.
      mockStatusWithVss({
        shadowCopyId: 'set-1',
        writers: [{ name: 'SqlServerWriter', state: 'stable' }],
        unprotectedVolumes: ['D:\\'],
      });

      render(<DeviceBackupTab deviceId="device-1" />);

      const banner = await screen.findByTestId('backup-vss-unprotected-volumes');
      expect(banner.textContent).toContain('D:\\');
      // Not merely the writer banner, which stays silent here.
      expect(screen.queryByText(/writers are not stable/i)).toBeNull();
    });

    it('lists provider warnings carried on the metadata', async () => {
      mockStatusWithVss({
        shadowCopyId: 'set-1',
        writers: [{ name: 'SqlServerWriter', state: 'stable' }],
        warnings: ['volume D:\\ has no shadow copy (0x80042308)'],
      });

      render(<DeviceBackupTab deviceId="device-1" />);

      const warnings = await screen.findByTestId('backup-vss-warnings');
      expect(warnings.textContent).toContain('0x80042308');
    });

    it('hides the panel entirely when the run reported no VSS metadata (non-Windows / VSS off)', async () => {
      mockStatusWithVss(null);

      render(<DeviceBackupTab deviceId="device-1" />);

      await screen.findByText('Job History');
      expect(screen.queryByText('VSS Status')).toBeNull();
      expect(screen.queryByTestId('backup-vss-unprotected-volumes')).toBeNull();
    });

    it('surfaces a total VSS failure, which has NO vssMetadata and so no panel', async () => {
      // The worst outcome and previously the most invisible: the shadow copy
      // never started, so there is nothing for the VSS panel to render, and
      // this tab used to ignore errorLog entirely — a run that read every file
      // off the live volume displayed as a clean, green backup.
      mockStatusWithVss(null, {
        status: 'completed',
        errorLog: 'VSS shadow copy could not be created, so every path was read from the live volume',
      });

      render(<DeviceBackupTab deviceId="device-1" />);

      const banner = await screen.findByTestId('backup-last-job-diagnostic');
      expect(banner.textContent).toContain('read from the live volume');
      // A successful-but-degraded run is a WARNING, not an error.
      expect(banner.textContent).toContain('completed with warnings');
      expect(banner.className).not.toMatch(/destructive/);
    });

    it('does not frame a historic run as "completed with warnings" over the recoverable index drop note (#11026)', async () => {
      mockStatusWithVss(null, {
        status: 'completed',
        errorLog: 'bounded: snapshot file index omitted (17950 entries): the result exceeded the 4934464 byte server result budget, so per-file restore browsing is unavailable for this snapshot',
      });

      render(<DeviceBackupTab deviceId="device-1" />);

      await screen.findByText('Job History');
      expect(screen.queryByTestId('backup-last-job-diagnostic')).toBeNull();
      expect(document.body.textContent).not.toContain('snapshot file index');
    });

    it('styles the diagnostic as an error when the run actually failed', async () => {
      mockStatusWithVss(null, { status: 'failed', errorLog: 'upload destination unreachable' });

      render(<DeviceBackupTab deviceId="device-1" />);

      const banner = await screen.findByTestId('backup-last-job-diagnostic');
      expect(banner.textContent).toContain('Last backup failed');
      expect(banner.className).toMatch(/destructive/);
    });

    it('renders no diagnostic banner for a clean run', async () => {
      mockStatusWithVss(null, { errorLog: null });

      render(<DeviceBackupTab deviceId="device-1" />);

      await screen.findByText('Job History');
      expect(screen.queryByTestId('backup-last-job-diagnostic')).toBeNull();
    });
  });

  it('renders the external backup card above the first-party sections', async () => {
    externalPresent = true;
    render(<DeviceBackupTab deviceId="device-1" />);
    expect(await screen.findByTestId('stub-external-backup')).toBeInTheDocument();
  });

  it('points at third-party connections from the empty state when neither source has anything', async () => {
    externalPresent = false;
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/backup/status/device-1') return makeJsonResponse({ data: { protected: false } });
      return makeJsonResponse({ data: [] });
    });
    render(<DeviceBackupTab deviceId="device-1" />);
    expect(await screen.findByTestId('device-backup-empty-external-hint')).toBeInTheDocument();
  });

  describe('backup in progress (#11027)', () => {
    const activeJob = (overrides: Record<string, unknown> = {}) => ({
      id: 'job-live',
      status: 'running',
      backupMode: 'file',
      backupType: 'file',
      createdAt: '2026-11-05T11:00:00.000Z',
      startedAt: '2026-11-05T11:00:30.000Z',
      totalSize: 4000,
      transferredSize: 1000,
      fileCount: 1,
      totalFiles: 4,
      lastProgressAt: '2026-11-05T11:59:50.000Z',
      lastKeepaliveAt: '2026-11-05T11:59:50.000Z',
      resumedAt: null,
      ...overrides,
    });

    // Flush fetch → json → setState without timer-based helpers, which do not
    // compose with fake timers.
    const flush = async () => {
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    };

    const mockStatus = (activeJobsFor: (call: number) => unknown[]) => {
      const calls = { status: 0 };
      fetchMock.mockImplementation(async (input, init) => {
        const url = String(input);
        const method = (init as RequestInit | undefined)?.method ?? 'GET';
        if (url === '/backup/status/device-1') {
          calls.status += 1;
          return makeJsonResponse({ data: { protected: true, lastJob: null, activeJobs: activeJobsFor(calls.status) } });
        }
        if (url === '/backup/jobs?deviceId=device-1') return makeJsonResponse({ data: [] });
        if (url === '/backup/snapshots?deviceId=device-1') return makeJsonResponse({ data: [] });
        if (url === '/backup/jobs/job-live/cancel' && method === 'POST') {
          return makeJsonResponse({ id: 'job-live', status: 'cancelled' });
        }
        return makeJsonResponse({}, false, 404);
      });
      return calls;
    };

    afterEach(() => {
      vi.useRealTimers();
    });

    it('polls while activeJobs is non-empty and stops when it empties', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-11-05T12:00:00.000Z'));
      const calls = mockStatus((call) => (call < 3 ? [activeJob()] : []));

      render(<DeviceBackupTab deviceId="device-1" />);
      await act(async () => {
        await flush();
      });
      expect(calls.status).toBe(1);
      expect(screen.getAllByTestId('device-backup-active-job')).toHaveLength(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
        await flush();
      });
      expect(calls.status).toBe(2);

      // The third fetch reports nothing in flight: the card goes and polling stops.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
        await flush();
      });
      expect(calls.status).toBe(3);
      expect(screen.queryByTestId('device-backup-active-job')).toBeNull();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(15000);
        await flush();
      });
      expect(calls.status).toBe(3);
    });

    it('does not stack polls while one is still in flight', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-11-05T12:00:00.000Z'));
      const calls = { status: 0 };
      fetchMock.mockImplementation(async (input) => {
        const url = String(input);
        if (url === '/backup/status/device-1') {
          calls.status += 1;
          // First answer starts the polling; the poll's own request never returns.
          if (calls.status > 1) return new Promise<Response>(() => {});
          return makeJsonResponse({ data: { protected: true, lastJob: null, activeJobs: [activeJob()] } });
        }
        if (url === '/backup/jobs?deviceId=device-1') return makeJsonResponse({ data: [] });
        if (url === '/backup/snapshots?deviceId=device-1') return makeJsonResponse({ data: [] });
        return makeJsonResponse({}, false, 404);
      });

      render(<DeviceBackupTab deviceId="device-1" />);
      await act(async () => {
        await flush();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20000);
        await flush();
      });
      expect(calls.status).toBe(2);
    });

    it('keeps the error banner steady across failing polls, so the page does not scroll every tick', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-11-05T12:00:00.000Z'));
      const scrollIntoView = vi.fn();
      const original = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = scrollIntoView;
      try {
        let statusCalls = 0;
        let releasePoll: (res: Response) => void = () => {};
        const failed = () => makeJsonResponse({ error: 'boom' }, false, 500);
        fetchMock.mockImplementation(async (input) => {
          const url = String(input);
          if (url === '/backup/status/device-1') {
            statusCalls += 1;
            if (statusCalls === 1) {
              return makeJsonResponse({ data: { protected: true, lastJob: null, activeJobs: [activeJob()] } });
            }
            if (statusCalls === 2) return failed();
            // Held open across a commit, as a real network gap is. act() would
            // otherwise batch a clear and a re-set into one render.
            return new Promise<Response>((resolve) => { releasePoll = resolve; });
          }
          if (url === '/backup/jobs?deviceId=device-1') return makeJsonResponse({ data: [] });
          if (url === '/backup/snapshots?deviceId=device-1') return makeJsonResponse({ data: [] });
          return makeJsonResponse({}, false, 404);
        });

        render(<DeviceBackupTab deviceId="device-1" />);
        await act(async () => {
          await flush();
        });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(5000);
          await flush();
        });
        expect(screen.getByText('Failed to load some data (500)')).toBeTruthy();
        expect(scrollIntoView).toHaveBeenCalledTimes(1);

        // The next poll is in flight: the banner must not blink off.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(5000);
          await flush();
        });
        expect(statusCalls).toBe(3);
        expect(screen.getByText('Failed to load some data (500)')).toBeTruthy();

        await act(async () => {
          releasePoll(failed());
          await flush();
          await flush();
        });
        expect(scrollIntoView).toHaveBeenCalledTimes(1);
      } finally {
        Element.prototype.scrollIntoView = original;
      }
    });

    it('clears the error banner once a later poll succeeds', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-11-05T12:00:00.000Z'));
      let statusCalls = 0;
      fetchMock.mockImplementation(async (input) => {
        const url = String(input);
        if (url === '/backup/status/device-1') {
          statusCalls += 1;
          if (statusCalls === 2) return makeJsonResponse({ error: 'boom' }, false, 500);
          return makeJsonResponse({ data: { protected: true, lastJob: null, activeJobs: [activeJob()] } });
        }
        if (url === '/backup/jobs?deviceId=device-1') return makeJsonResponse({ data: [] });
        if (url === '/backup/snapshots?deviceId=device-1') return makeJsonResponse({ data: [] });
        return makeJsonResponse({}, false, 404);
      });

      render(<DeviceBackupTab deviceId="device-1" />);
      await act(async () => {
        await flush();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
        await flush();
      });
      expect(screen.getByText('Failed to load some data (500)')).toBeTruthy();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
        await flush();
      });
      expect(screen.queryByText('Failed to load some data (500)')).toBeNull();
    });

    it('does not let an older poll response bring back a job that Stop already removed', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-11-05T12:00:00.000Z'));
      let statusCalls = 0;
      let releasePoll: (res: Response) => void = () => {};
      fetchMock.mockImplementation(async (input, init) => {
        const url = String(input);
        const method = (init as RequestInit | undefined)?.method ?? 'GET';
        if (url === '/backup/status/device-1') {
          statusCalls += 1;
          // Call 2 is the poll, held open across the whole stop.
          if (statusCalls === 2) return new Promise<Response>((resolve) => { releasePoll = resolve; });
          return makeJsonResponse({
            data: { protected: true, lastJob: null, activeJobs: statusCalls === 1 ? [activeJob()] : [] },
          });
        }
        if (url === '/backup/jobs?deviceId=device-1') return makeJsonResponse({ data: [] });
        if (url === '/backup/snapshots?deviceId=device-1') return makeJsonResponse({ data: [] });
        if (url === '/backup/jobs/job-live/cancel' && method === 'POST') {
          return makeJsonResponse({ id: 'job-live', status: 'cancelled' });
        }
        return makeJsonResponse({}, false, 404);
      });

      render(<DeviceBackupTab deviceId="device-1" />);
      await act(async () => {
        await flush();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
        await flush();
      });
      expect(statusCalls).toBe(2);

      await act(async () => {
        fireEvent.click(screen.getByTestId('device-backup-active-job-stop'));
        await vi.advanceTimersByTimeAsync(0);
        await flush();
        await flush();
      });
      expect(statusCalls).toBe(3);
      expect(screen.queryByTestId('device-backup-active-job')).toBeNull();

      await act(async () => {
        releasePoll(makeJsonResponse({ data: { protected: true, lastJob: null, activeJobs: [activeJob()] } }));
        await flush();
        await flush();
      });
      expect(screen.queryByTestId('device-backup-active-job')).toBeNull();
    });

    it('surfaces the partial-delivery warning from a cancel that could not reach the agent', async () => {
      mockStatus(() => [activeJob()]);
      const base = fetchMock.getMockImplementation()!;
      fetchMock.mockImplementation(async (input, init) => {
        if (String(input) === '/backup/jobs/job-live/cancel') {
          return makeJsonResponse({ id: 'job-live', status: 'cancelled', warning: 'Stop signal not delivered' });
        }
        return base(input, init);
      });

      render(<DeviceBackupTab deviceId="device-1" />);
      fireEvent.click(await screen.findByTestId('device-backup-active-job-stop'));

      await waitFor(() => {
        expect(showToast).toHaveBeenCalledWith({ message: 'Stop signal not delivered', type: 'warning' });
      });
    });

    it('re-enables Stop and refetches nothing when the cancel fails', async () => {
      const calls = mockStatus(() => [activeJob()]);
      const base = fetchMock.getMockImplementation()!;
      fetchMock.mockImplementation(async (input, init) => {
        if (String(input) === '/backup/jobs/job-live/cancel') {
          return makeJsonResponse({ error: 'Nope' }, false, 500);
        }
        return base(input, init);
      });

      render(<DeviceBackupTab deviceId="device-1" />);
      const stop = (await screen.findByTestId('device-backup-active-job-stop')) as HTMLButtonElement;
      fireEvent.click(stop);

      await waitFor(() => {
        expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
      });
      await waitFor(() => {
        expect((screen.getByTestId('device-backup-active-job-stop') as HTMLButtonElement).disabled).toBe(false);
      });
      expect(calls.status).toBe(1);
    });

    it('refreshes after a successful stop', async () => {
      const calls = mockStatus((call) => (call === 1 ? [activeJob()] : []));

      render(<DeviceBackupTab deviceId="device-1" />);
      fireEvent.click(await screen.findByTestId('device-backup-active-job-stop'));

      await waitFor(() => {
        expect(screen.queryByTestId('device-backup-active-job')).toBeNull();
      });
      expect(calls.status).toBe(2);
    });

    it('does not poll when nothing is in flight', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-11-05T12:00:00.000Z'));
      const calls = mockStatus(() => []);

      render(<DeviceBackupTab deviceId="device-1" />);
      await act(async () => {
        await flush();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15000);
        await flush();
      });
      expect(calls.status).toBe(1);
      expect(screen.queryByTestId('device-backup-active-jobs')).toBeNull();
    });

    it('renders the in-progress cards above Job History and stops a job through the cancel route', async () => {
      mockStatus(() => [activeJob()]);

      render(<DeviceBackupTab deviceId="device-1" />);
      const section = await screen.findByTestId('device-backup-active-jobs');
      const history = screen.getByText('Job History');
      expect(section.compareDocumentPosition(history) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

      fireEvent.click(within(section).getByTestId('device-backup-active-job-stop'));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith('/backup/jobs/job-live/cancel', { method: 'POST' });
      });
    });
  });
});
