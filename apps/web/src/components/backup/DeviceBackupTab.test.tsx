import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DeviceBackupTab from './DeviceBackupTab';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
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

  it('shows restore-point protection controls for the selected snapshot', async () => {
    render(<DeviceBackupTab deviceId="device-1" />);

    await screen.findByText('Restore Points');
    expect(screen.getByText('Protection Controls')).toBeTruthy();
    expect(screen.getAllByText('Nightly Snapshot').length).toBeGreaterThan(0);
    const jobHistoryHeading = screen.getByText('Job History');
    const jobHistoryCard = jobHistoryHeading.parentElement;
    const jobHistoryTable = jobHistoryCard?.querySelector('table');

    expect(jobHistoryTable).toBeTruthy();
    expect(within(jobHistoryTable as HTMLTableElement).getByText('1 KB')).toBeTruthy();
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
});
