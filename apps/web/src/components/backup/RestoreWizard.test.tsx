import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import RestoreWizard from './RestoreWizard';
import { formatDateTime } from '@/lib/dateTimeFormat';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));
const showToastMock = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (input: unknown) => showToastMock(input) }));

const fetchMock = vi.mocked(fetchWithAuth);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

describe('RestoreWizard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows restore history and renders the latest restore job after creation', async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (url === '/backup/snapshots') {
        return makeJsonResponse({
          data: [
            {
              id: 'snap-1',
              label: 'Server snapshot',
              status: 'Ready',
              size: '4 GB',
            },
          ],
        });
      }

      if (url === '/backup/snapshots/snap-1/browse') {
        return makeJsonResponse({ data: [] });
      }

      if (url === '/backup/restore?limit=6') {
        return makeJsonResponse({
          data: [
            {
              id: 'restore-1',
              snapshotId: 'snap-1',
              deviceId: 'device-1',
              restoreType: 'full',
              status: 'completed',
              targetPath: null,
              createdAt: '2026-03-31T10:00:00.000Z',
              updatedAt: '2026-03-31T10:10:00.000Z',
              startedAt: '2026-03-31T10:01:00.000Z',
              completedAt: '2026-03-31T10:10:00.000Z',
              restoredSize: 2048,
              restoredFiles: 3,
              errorSummary: null,
              resultDetails: { status: 'completed' },
            },
          ],
        });
      }

      if (url === '/backup/restore' && method === 'POST') {
        return makeJsonResponse({
          id: 'restore-2',
          snapshotId: 'snap-1',
          deviceId: 'device-1',
          restoreType: 'full',
          status: 'pending',
          targetPath: null,
          createdAt: '2026-03-31T11:00:00.000Z',
          updatedAt: '2026-03-31T11:00:00.000Z',
          startedAt: null,
          completedAt: null,
          restoredSize: null,
          restoredFiles: null,
          commandId: 'cmd-1',
          errorSummary: null,
          resultDetails: null,
        });
      }

      return makeJsonResponse({}, false, 404);
    });

    render(<RestoreWizard />);

    await screen.findByText('Restore Wizard');
    expect(await screen.findByText('Recent restore history')).toBeTruthy();
    expect(screen.getByText('restore-1')).toBeTruthy();

    for (let index = 0; index < 4; index += 1) {
      fireEvent.click(screen.getByRole('button', { name: /Continue/i }));
    }

    fireEvent.click(screen.getByRole('button', { name: /Start restore/i }));

    await waitFor(() => {
      expect(screen.getByText(/Restore job restore-2 queued successfully/i)).toBeTruthy();
    });
    expect(screen.getByText('Latest restore job')).toBeTruthy();
    expect(screen.getByText(/pending/i)).toBeTruthy();
  });

  it('surfaces the restore API error when restore startup fails', async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (url === '/backup/snapshots') {
        return makeJsonResponse({
          data: [
            {
              id: 'snap-1',
              label: 'Server snapshot',
              status: 'Ready',
              size: '4 GB',
            },
          ],
        });
      }

      if (url === '/backup/snapshots/snap-1/browse') {
        return makeJsonResponse({ data: [] });
      }

      if (url === '/backup/restore?limit=6') {
        return makeJsonResponse({ data: [] });
      }

      if (url === '/backup/restore' && method === 'POST') {
        return makeJsonResponse({
          error: 'Device is offline, cannot execute command',
        }, false, 409);
      }

      return makeJsonResponse({}, false, 404);
    });

    render(<RestoreWizard />);

    await screen.findByText('Restore Wizard');

    for (let index = 0; index < 4; index += 1) {
      fireEvent.click(screen.getByRole('button', { name: /Continue/i }));
    }

    fireEvent.click(screen.getByRole('button', { name: /Start restore/i }));

    await waitFor(() => {
      expect(screen.getByText('Device is offline, cannot execute command')).toBeTruthy();
    });
  });

  it('hydrates the latest restore job from restore history before a new restore is started', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);

      if (url === '/backup/snapshots') {
        return makeJsonResponse({
          data: [
            {
              id: 'snap-1',
              label: 'Server snapshot',
              status: 'Ready',
              size: '4 GB',
            },
          ],
        });
      }

      if (url === '/backup/snapshots/snap-1/browse') {
        return makeJsonResponse({ data: [] });
      }

      if (url === '/backup/restore?limit=6') {
        return makeJsonResponse({
          data: [
            {
              id: 'restore-history-1',
              snapshotId: 'snap-1',
              deviceId: 'device-1',
              restoreType: 'full',
              status: 'running',
              targetPath: '/restore-target',
              createdAt: '2026-03-31T11:00:00.000Z',
              updatedAt: '2026-03-31T11:05:00.000Z',
              startedAt: '2026-03-31T11:01:00.000Z',
              completedAt: null,
              restoredSize: 1024,
              restoredFiles: 2,
              commandId: 'cmd-history-1',
              errorSummary: null,
              resultDetails: { status: 'running' },
            },
          ],
        });
      }

      return makeJsonResponse({}, false, 404);
    });

    render(<RestoreWizard />);

    await screen.findByText('Latest restore job');
    expect(screen.getAllByText('running').length).toBeGreaterThan(0);
    expect(screen.getByText(/Command: cmd-history-1/i)).toBeTruthy();
    expect(screen.getByText(/Target path: \/restore-target/i)).toBeTruthy();
  });

  it('blocks the restore until an alternate destination path is typed (#6349)', async () => {
    // The wizard shipped with the demo path '/restore/nyc-db-14' pre-filled.
    // It was unreachable so nobody saw it; mounted, that is a restore pointed
    // at the wrong directory one click away.
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/backup/snapshots') {
        return makeJsonResponse({ data: [{ id: 'snap-1', label: 'Server snapshot', status: 'Ready', size: '4 GB' }] });
      }
      if (url === '/backup/snapshots/snap-1/browse') return makeJsonResponse({ data: [] });
      if (url === '/backup/restore?limit=6') return makeJsonResponse({ data: [] });
      return makeJsonResponse({}, false, 404);
    });

    render(<RestoreWizard />);
    await screen.findByText('Restore Wizard');

    for (let index = 0; index < 3; index += 1) {
      fireEvent.click(screen.getByRole('button', { name: /Continue/i }));
    }

    fireEvent.click(screen.getByRole('button', { name: /Alternate path/i }));

    const input = screen.getByLabelText('Alternate path') as HTMLInputElement;
    expect(input.value).toBe('');

    fireEvent.click(screen.getByRole('button', { name: /Continue/i }));
    const start = screen.getByRole('button', { name: /Start restore/i }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: /Back/i }));
    fireEvent.change(screen.getByLabelText('Alternate path'), { target: { value: '/var/restore' } });
    fireEvent.click(screen.getByRole('button', { name: /Continue/i }));

    expect((screen.getByRole('button', { name: /Start restore/i }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('toasts a failed restore through runAction, not just the inline banner (#6349)', async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === '/backup/snapshots') {
        return makeJsonResponse({ data: [{ id: 'snap-1', label: 'Server snapshot', status: 'Ready', size: '4 GB' }] });
      }
      if (url === '/backup/snapshots/snap-1/browse') return makeJsonResponse({ data: [] });
      if (url === '/backup/restore?limit=6') return makeJsonResponse({ data: [] });
      if (url === '/backup/restore' && method === 'POST') {
        return makeJsonResponse({ error: 'Device is offline, cannot execute command' }, false, 409);
      }
      return makeJsonResponse({}, false, 404);
    });

    render(<RestoreWizard />);
    await screen.findByText('Restore Wizard');

    for (let index = 0; index < 4; index += 1) {
      fireEvent.click(screen.getByRole('button', { name: /Continue/i }));
    }
    fireEvent.click(screen.getByRole('button', { name: /Start restore/i }));

    await waitFor(() => {
      expect(showToastMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error', message: 'Device is offline, cannot execute command' }),
      );
    });
  });

  it('pre-populates the snapshot + selective-file selection carried from SnapshotBrowser (#6456)', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/backup/snapshots') {
        return makeJsonResponse({
          data: [
            { id: 'snap-1', label: 'Server snapshot', status: 'Ready', size: '4 GB' },
            { id: 'snap-2', label: 'Other snapshot', status: 'Ready', size: '2 GB' },
          ],
        });
      }
      if (url === '/backup/snapshots/snap-2/browse') {
        return makeJsonResponse({
          data: [
            { name: 'report.txt', path: '/Documents/report.txt', type: 'file', sizeBytes: 10 },
            { name: 'notes.txt', path: '/Documents/notes.txt', type: 'file', sizeBytes: 20 },
          ],
        });
      }
      if (url === '/backup/restore?limit=6') return makeJsonResponse({ data: [] });
      return makeJsonResponse({}, false, 404);
    });

    render(
      <RestoreWizard
        initialSnapshotId="snap-2"
        initialSelectedPaths={['/Documents/report.txt']}
      />
    );

    await screen.findByText('Restore Wizard');

    // Step 0: the carried snapshot is selected, not the first one in the list.
    expect(screen.getByRole('button', { name: /Other snapshot/i }).className).toContain('border-primary');

    fireEvent.click(screen.getByRole('button', { name: /Continue/i }));
    // Step 1: restore type defaults to selective because paths were carried.
    expect(screen.getByRole('button', { name: /Selective Restore/i }).className).toContain('border-primary');

    fireEvent.click(screen.getByRole('button', { name: /Continue/i }));
    // Step 2: the carried file is pre-checked without the operator re-selecting it.
    const checkbox = await screen.findByRole('checkbox', { name: /report\.txt/i });
    expect((checkbox as HTMLInputElement).checked).toBe(true);
  });

  it('formats the snapshot size from the real API field (sizeBytes) instead of showing "--" (#6496)', async () => {
    // The real /backup/snapshots response carries `sizeBytes` (a number), never
    // a pre-formatted `size` string — reading `snapshot.size` always fell back
    // to '--' in production.
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/backup/snapshots') {
        return makeJsonResponse({
          data: [{ id: 'snap-1', label: 'Server snapshot', sizeBytes: 1181116006 }],
        });
      }
      if (url === '/backup/snapshots/snap-1/browse') return makeJsonResponse({ data: [] });
      if (url === '/backup/restore?limit=6') return makeJsonResponse({ data: [] });
      return makeJsonResponse({}, false, 404);
    });

    render(<RestoreWizard />);
    await screen.findByText('Restore Wizard');

    expect(await screen.findByText('1.10 GB')).toBeTruthy();
    expect(screen.queryByText('--')).toBeNull();
  });

  it('shows the snapshot capture time instead of a hard-coded "Ready" status (#6496)', async () => {
    // /backup/snapshots carries no status field; the card used to print a
    // fabricated "Ready" for every row. It now shows the real createdAt.
    const createdAt = '2026-09-20T14:08:00.000Z';
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/backup/snapshots') {
        return makeJsonResponse({
          data: [{ id: 'snap-1', label: 'Server snapshot', sizeBytes: 1024, createdAt }],
        });
      }
      if (url === '/backup/snapshots/snap-1/browse') return makeJsonResponse({ data: [] });
      if (url === '/backup/restore?limit=6') return makeJsonResponse({ data: [] });
      return makeJsonResponse({}, false, 404);
    });

    render(<RestoreWizard />);
    await screen.findByText('Server snapshot');

    expect(screen.queryByText('Ready')).toBeNull();
    expect(screen.getByText(formatDateTime(createdAt))).toBeTruthy();
  });

  it('formats snapshot file sizes as bytes/KB/MB instead of raw byte counts (#6496)', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/backup/snapshots') {
        return makeJsonResponse({
          data: [{ id: 'snap-1', label: 'Server snapshot', sizeBytes: 2097152 }],
        });
      }
      if (url === '/backup/snapshots/snap-1/browse') {
        return makeJsonResponse({
          data: [{ name: 'db.bak', path: '/db.bak', type: 'file', sizeBytes: 2097152 }],
        });
      }
      if (url === '/backup/restore?limit=6') return makeJsonResponse({ data: [] });
      return makeJsonResponse({}, false, 404);
    });

    render(<RestoreWizard />);
    await screen.findByText('Restore Wizard');

    fireEvent.click(screen.getByRole('button', { name: /Continue/i }));
    fireEvent.click(screen.getByRole('button', { name: /Selective restore/i }));
    fireEvent.click(screen.getByRole('button', { name: /Continue/i }));

    expect(await screen.findByText('2.00 MB')).toBeTruthy();
    expect(screen.queryByText('2097152 B')).toBeNull();
  });

  it('echoes the typed alternate destination path on the Review step (#6496)', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/backup/snapshots') {
        return makeJsonResponse({ data: [{ id: 'snap-1', label: 'Server snapshot', sizeBytes: 4 * 1024 ** 3 }] });
      }
      if (url === '/backup/snapshots/snap-1/browse') return makeJsonResponse({ data: [] });
      if (url === '/backup/restore?limit=6') return makeJsonResponse({ data: [] });
      return makeJsonResponse({}, false, 404);
    });

    render(<RestoreWizard />);
    await screen.findByText('Restore Wizard');

    for (let index = 0; index < 3; index += 1) {
      fireEvent.click(screen.getByRole('button', { name: /Continue/i }));
    }
    fireEvent.click(screen.getByRole('button', { name: /Alternate path/i }));
    fireEvent.change(screen.getByLabelText('Alternate path'), { target: { value: '/var/restore/target' } });
    fireEvent.click(screen.getByRole('button', { name: /Continue/i }));

    expect(await screen.findByText(/\/var\/restore\/target/)).toBeTruthy();
  });

  it('leaves a 401 to the auth redirect instead of banner-ing "Unauthorized" (#6349)', async () => {
    // fetchWithAuth has already kicked off the session-expired redirect by the
    // time runAction sees a 401, so the wizard must stay quiet rather than
    // flashing a meaningless error under a navigating page.
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === '/backup/snapshots') {
        return makeJsonResponse({ data: [{ id: 'snap-1', label: 'Server snapshot', status: 'Ready', size: '4 GB' }] });
      }
      if (url === '/backup/snapshots/snap-1/browse') return makeJsonResponse({ data: [] });
      if (url === '/backup/restore?limit=6') return makeJsonResponse({ data: [] });
      if (url === '/backup/restore' && method === 'POST') {
        return makeJsonResponse({ error: 'Unauthorized' }, false, 401);
      }
      return makeJsonResponse({}, false, 404);
    });

    render(<RestoreWizard />);
    await screen.findByText('Restore Wizard');

    for (let index = 0; index < 4; index += 1) {
      fireEvent.click(screen.getByRole('button', { name: /Continue/i }));
    }
    const start = screen.getByRole('button', { name: /Start restore/i }) as HTMLButtonElement;
    fireEvent.click(start);

    // The button un-disables once the in-flight flag clears, which is the
    // observable signal that the catch/finally ran.
    await waitFor(() => expect(start.disabled).toBe(false));
    expect(showToastMock).not.toHaveBeenCalled();
    expect(screen.queryByText('Unauthorized')).toBeNull();
  });
});
