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
});
