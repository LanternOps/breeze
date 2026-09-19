import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import VMRestoreWizard from './VMRestoreWizard';
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

describe('VMRestoreWizard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/backup/snapshots') {
        return makeJsonResponse({
          data: [
            {
              id: 'snapshot-1',
              label: 'Nightly Snapshot',
              createdAt: '2026-03-28T10:00:00Z',
              sizeBytes: 2147483648,
            },
          ],
        });
      }
      if (url.startsWith('/devices/options?')) {
        return makeJsonResponse({
          data: [{ id: 'device-1', hostname: 'hyperv-01', displayName: null, osType: 'windows', status: 'online', siteId: null, siteName: null }],
          page: { nextCursor: null, returned: 1, total: 1, hasMore: false, observedAt: '2026-08-24T00:00:00.000Z' },
        });
      }
      if (url === '/backup/restore/as-vm/estimate/snapshot-1') {
        return makeJsonResponse({
          data: {
            memoryMb: 12288,
            cpuCount: 6,
            diskSizeGb: 180,
          },
        });
      }
      if (url === '/backup/restore/as-vm' || url === '/backup/restore/instant-boot') {
        return makeJsonResponse({
          data: {
            id: 'restore-1',
            status: 'pending',
          },
        });
      }
      return makeJsonResponse({});
    });
  });

  it('renders the first step for snapshot selection', async () => {
    render(<VMRestoreWizard />);

    await screen.findByText('Select backup snapshot');
    expect(screen.getByText('Nightly Snapshot')).toBeTruthy();
    expect(screen.getByText('1. Snapshot')).toBeTruthy();
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith('/devices/options?'))).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => /^\/devices(?:\?|$)/.test(String(url)))).toBe(false);
  });

  it('renders alpha banner', async () => {
    render(<VMRestoreWizard />);

    await screen.findByText('VM Restore Wizard');
    expect(
      screen.getByText(/Restoring backups as Hyper-V VMs and Instant Boot are in early access/i)
    ).toBeTruthy();
  });

  it('prefills VM specs from the estimate and submits the nested VM restore payload', async () => {
    render(<VMRestoreWizard />);

    fireEvent.click(await screen.findByRole('button', { name: /Nightly Snapshot/i }));
    fireEvent.click(screen.getByRole('button', { name: /2\. Target Host/i }));
    fireEvent.click(await screen.findByRole('radio'));
    fireEvent.click(screen.getByRole('button', { name: /3\. VM Specs/i }));

    await waitFor(() => {
      expect(screen.getByDisplayValue('12288')).toBeTruthy();
      expect(screen.getByDisplayValue('6')).toBeTruthy();
      expect(screen.getByDisplayValue('180')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: /4\. VM Name/i }));
    fireEvent.change(screen.getByLabelText(/VM Name/i), { target: { value: 'Recovered VM' } });
    fireEvent.change(screen.getByLabelText(/Virtual Switch/i), { target: { value: 'Prod Switch' } });

    fireEvent.click(screen.getByRole('button', { name: /6\. Review/i }));
    fireEvent.click(screen.getByRole('button', { name: /Start Full Restore/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/backup/restore/as-vm',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          snapshotId: 'snapshot-1',
          targetDeviceId: 'device-1',
          vmName: 'Recovered VM',
          hypervisor: 'hyperv',
          vmSpecs: {
            memoryMb: 12288,
            cpuCount: 6,
            diskSizeGb: 180,
          },
          switchName: 'Prod Switch',
        }),
      })
    ));
  });

  it('sends the nested VM spec payload for instant boot', async () => {
    render(<VMRestoreWizard />);

    fireEvent.click(await screen.findByRole('button', { name: /Nightly Snapshot/i }));
    fireEvent.click(screen.getByRole('button', { name: /2\. Target Host/i }));
    fireEvent.click(await screen.findByRole('radio'));
    fireEvent.click(screen.getByRole('button', { name: /4\. VM Name/i }));
    fireEvent.change(screen.getByLabelText(/VM Name/i), { target: { value: 'Instant VM' } });
    fireEvent.click(screen.getByRole('button', { name: /5\. Mode/i }));
    fireEvent.click(screen.getByRole('button', { name: /Instant Boot/i }));
    fireEvent.click(screen.getByRole('button', { name: /6\. Review/i }));
    fireEvent.click(screen.getByRole('button', { name: /Start Instant Boot/i }));

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => url === '/backup/restore/instant-boot')).toBe(true);
    });

    const instantBootCall = fetchMock.mock.calls.find(([url]) => url === '/backup/restore/instant-boot');
    expect(instantBootCall).toBeTruthy();
    const [, options] = instantBootCall ?? [];
    const body = JSON.parse(String((options as { body?: string } | undefined)?.body ?? '{}'));
    expect(body).toMatchObject({
      snapshotId: 'snapshot-1',
      targetDeviceId: 'device-1',
      vmName: 'Instant VM',
    });
    expect(body.vmSpecs).toEqual(
      expect.objectContaining({
        memoryMb: expect.any(Number),
        cpuCount: expect.any(Number),
        diskSizeGb: expect.any(Number),
      })
    );
  });
});
