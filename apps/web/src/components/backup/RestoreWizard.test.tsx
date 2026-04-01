import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import RestoreWizard from './RestoreWizard';
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
});
