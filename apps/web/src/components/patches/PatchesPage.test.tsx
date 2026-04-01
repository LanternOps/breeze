import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import PatchesPage from './PatchesPage';
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

describe('PatchesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState({}, '', '/?tab=patches');
  });

  it('keeps failed bulk approvals pending when the API only approves some patches', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);

      if (url === '/update-rings') {
        return makeJsonResponse({ data: [] });
      }

      if (url === '/patches') {
        return makeJsonResponse({
          data: [
            {
              id: 'patch-1',
              title: 'Critical Security Update',
              severity: 'critical',
              source: 'microsoft',
              os: 'windows',
              releaseDate: '2026-04-01T00:00:00.000Z',
              approvalStatus: 'pending',
            },
            {
              id: 'patch-2',
              title: 'Feature Update',
              severity: 'important',
              source: 'microsoft',
              os: 'windows',
              releaseDate: '2026-04-02T00:00:00.000Z',
              approvalStatus: 'pending',
            },
          ],
        });
      }

      if (url === '/patches/bulk-approve') {
        return makeJsonResponse({
          success: true,
          approved: ['patch-1'],
          failed: ['patch-2'],
        });
      }

      return makeJsonResponse({}, false, 404);
    });

    render(<PatchesPage />);

    await screen.findByText('Critical Security Update');

    fireEvent.click(screen.getByRole('button', { name: 'Select Critical Security Update' }));
    fireEvent.click(screen.getByRole('button', { name: 'Select Feature Update' }));
    fireEvent.click(screen.getByRole('button', { name: 'Approve 2' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/patches/bulk-approve',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            patchIds: ['patch-1', 'patch-2'],
          }),
        })
      );
    });

    await screen.findByText('Failed to approve 1 patch');
    expect(screen.getAllByRole('button', { name: 'Deploy' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Review' })).toHaveLength(1);
  });

  it('queues scans for every device page instead of only the first 100 devices', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);

      if (url === '/update-rings') {
        return makeJsonResponse({ data: [] });
      }

      if (url === '/patches') {
        return makeJsonResponse({ data: [] });
      }

      if (url === '/devices?limit=100&page=1') {
        return makeJsonResponse({
          data: [
            { id: 'device-1', hostname: 'Workstation-1' },
            { id: 'device-2', hostname: 'Workstation-2' },
          ],
          pagination: {
            page: 1,
            limit: 100,
            total: 102,
          },
        });
      }

      if (url === '/devices?limit=100&page=2') {
        return makeJsonResponse({
          data: [
            { id: 'device-3', hostname: 'Workstation-3' },
          ],
          pagination: {
            page: 2,
            limit: 100,
            total: 102,
          },
        });
      }

      if (url === '/patches/scan') {
        return makeJsonResponse({
          queuedCommandIds: ['cmd-1', 'cmd-2', 'cmd-3'],
          dispatchedCommandIds: ['cmd-1'],
        });
      }

      return makeJsonResponse({}, false, 404);
    });

    render(<PatchesPage />);

    await screen.findByText('No patches found. Try adjusting your search or filters.');
    fireEvent.click(screen.getByRole('button', { name: 'Run Scan' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/patches/scan',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            deviceIds: ['device-1', 'device-2', 'device-3'],
          }),
        })
      );
    });

    expect(await screen.findByText('Patch scan queued for 3 devices, 1 dispatched immediately.')).toBeTruthy();
  });
});
