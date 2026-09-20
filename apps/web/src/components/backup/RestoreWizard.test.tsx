import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import RestoreWizard from './RestoreWizard';
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
});
