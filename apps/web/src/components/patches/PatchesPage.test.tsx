import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock showToast before importing PatchesPage so runAction uses the mock
const showToast = vi.fn();
vi.mock('../../components/shared/Toast', () => ({ showToast: (a: unknown) => showToast(a) }));

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

    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'success',
          message: expect.stringContaining('3 devices'),
        })
      );
    });
  });

  it('uses singular "device" when exactly 1 device is queued for scan', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);

      if (url === '/update-rings') return makeJsonResponse({ data: [] });
      if (url === '/patches') return makeJsonResponse({ data: [] });

      if (url === '/devices?limit=100&page=1') {
        return makeJsonResponse({
          data: [{ id: 'device-1', hostname: 'Workstation-1' }],
          pagination: { page: 1, limit: 100, total: 1 },
        });
      }

      if (url === '/patches/scan') {
        return makeJsonResponse({ queuedCommandIds: ['cmd-1'] });
      }

      return makeJsonResponse({}, false, 404);
    });

    render(<PatchesPage />);

    await screen.findByText('No patches found. Try adjusting your search or filters.');
    fireEvent.click(screen.getByRole('button', { name: 'Run Scan' }));

    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'success',
          message: expect.stringContaining('1 device'),
        })
      );
    });
    // Must NOT say "1 devices"
    expect(showToast).not.toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('1 devices'),
      })
    );
  });

  it('shows error toast and does NOT call scan POST when device-paging GET fails with HTTP 500', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);

      if (url === '/update-rings') return makeJsonResponse({ data: [] });
      if (url === '/patches') return makeJsonResponse({ data: [] });

      if (url === '/devices?limit=100&page=1') {
        return makeJsonResponse({ error: 'internal server error' }, false, 500);
      }

      return makeJsonResponse({}, false, 404);
    });

    render(<PatchesPage />);

    await screen.findByText('No patches found. Try adjusting your search or filters.');
    fireEvent.click(screen.getByRole('button', { name: 'Run Scan' }));

    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'error',
          message: expect.stringContaining('Failed to load devices'),
        })
      );
    });
    // Scan POST must NOT have been called
    expect(fetchMock).not.toHaveBeenCalledWith(
      '/patches/scan',
      expect.anything()
    );
  });

  it('shows error toast and does NOT call scan POST when device list is empty', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);

      if (url === '/update-rings') return makeJsonResponse({ data: [] });
      if (url === '/patches') return makeJsonResponse({ data: [] });

      if (url === '/devices?limit=100&page=1') {
        return makeJsonResponse({
          data: [],
          pagination: { page: 1, limit: 100, total: 0 },
        });
      }

      return makeJsonResponse({}, false, 404);
    });

    render(<PatchesPage />);

    await screen.findByText('No patches found. Try adjusting your search or filters.');
    fireEvent.click(screen.getByRole('button', { name: 'Run Scan' }));

    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'error',
          message: expect.stringContaining('No devices available for scanning'),
        })
      );
    });
    // Scan POST must NOT have been called
    expect(fetchMock).not.toHaveBeenCalledWith(
      '/patches/scan',
      expect.anything()
    );
  });

  it('surfaces an error toast (not a success toast) when the backend returns success:false', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);

      if (url === '/update-rings') return makeJsonResponse({ data: [] });
      if (url === '/patches') return makeJsonResponse({ data: [] });

      if (url === '/devices?limit=100&page=1') {
        return makeJsonResponse({
          data: [{ id: 'device-1', hostname: 'Workstation-1' }],
          pagination: { page: 1, limit: 100, total: 1 },
        });
      }

      if (url === '/patches/scan') {
        // Backend returns success:false (e.g. no eligible devices — #727/#734 fix)
        return makeJsonResponse(
          { success: false, error: 'no eligible devices' },
          true, // HTTP 200 but body signals failure
          200
        );
      }

      return makeJsonResponse({}, false, 404);
    });

    render(<PatchesPage />);

    await screen.findByText('No patches found. Try adjusting your search or filters.');
    fireEvent.click(screen.getByRole('button', { name: 'Run Scan' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/patches/scan',
        expect.objectContaining({ method: 'POST' })
      );
    });

    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error' })
      );
    });
    // Must NOT have emitted a success toast
    expect(showToast).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success' })
    );
  });

  it('surfaces an error toast (not a success toast) when the scan POST fails with HTTP 500', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);

      if (url === '/update-rings') return makeJsonResponse({ data: [] });
      if (url === '/patches') return makeJsonResponse({ data: [] });

      if (url === '/devices?limit=100&page=1') {
        return makeJsonResponse({
          data: [{ id: 'device-1', hostname: 'Workstation-1' }],
          pagination: { page: 1, limit: 100, total: 1 },
        });
      }

      if (url === '/patches/scan') {
        return makeJsonResponse({ error: 'internal server error' }, false, 500);
      }

      return makeJsonResponse({}, false, 404);
    });

    render(<PatchesPage />);

    await screen.findByText('No patches found. Try adjusting your search or filters.');
    fireEvent.click(screen.getByRole('button', { name: 'Run Scan' }));

    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error' })
      );
    });
    expect(showToast).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success' })
    );
  });

  // ─── C1 regression: aggregate / partial-success scan outcomes ──────────────

  it('reports a PARTIAL scan honestly (some queued, some failed) — error toast, not generic failure or false success', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/update-rings') return makeJsonResponse({ data: [] });
      if (url === '/patches') return makeJsonResponse({ data: [] });
      if (url === '/devices?limit=100&page=1') {
        return makeJsonResponse({
          data: [
            { id: 'device-1', hostname: 'W1' },
            { id: 'device-2', hostname: 'W2' },
            { id: 'device-3', hostname: 'W3' },
          ],
          pagination: { page: 1, limit: 100, total: 3 },
        });
      }
      if (url === '/patches/scan') {
        // success:false but 2 of 3 genuinely queued — must NOT collapse to a
        // generic "Patch scan failed", and must NOT be a clean success.
        return makeJsonResponse({
          success: false,
          queuedCommandIds: ['c1', 'c2'],
          dispatchedCommandIds: ['c1'],
          failedDeviceIds: ['device-3'],
          skipped: { missingDeviceIds: [], inaccessibleDeviceIds: [] },
        });
      }
      return makeJsonResponse({}, false, 404);
    });

    render(<PatchesPage />);
    await screen.findByText('No patches found. Try adjusting your search or filters.');
    fireEvent.click(screen.getByRole('button', { name: 'Run Scan' }));

    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'error',
          message: expect.stringContaining('2 of 3'),
        })
      );
    });
    expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('1 failed to queue') })
    );
    // Not the generic fallback, not a success.
    expect(showToast).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success' })
    );
    expect(showToast).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Patch scan failed' })
    );
  });

  it('does NOT report a clean success when devices were silently skipped (false-negative regression)', async () => {
    // The original defect: 1 queued + 9 skipped → API success:true → green
    // "queued for 1 device" toast while 9 devices were silently dropped.
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/update-rings') return makeJsonResponse({ data: [] });
      if (url === '/patches') return makeJsonResponse({ data: [] });
      if (url === '/devices?limit=100&page=1') {
        return makeJsonResponse({
          data: Array.from({ length: 10 }, (_, i) => ({ id: `device-${i + 1}`, hostname: `W${i + 1}` })),
          pagination: { page: 1, limit: 100, total: 10 },
        });
      }
      if (url === '/patches/scan') {
        return makeJsonResponse({
          success: true, // backend does NOT flip success for skipped devices
          queuedCommandIds: ['c1'],
          dispatchedCommandIds: [],
          failedDeviceIds: [],
          skipped: {
            missingDeviceIds: ['device-2', 'device-3', 'device-4'],
            inaccessibleDeviceIds: ['device-5', 'device-6', 'device-7', 'device-8', 'device-9', 'device-10'],
          },
        });
      }
      return makeJsonResponse({}, false, 404);
    });

    render(<PatchesPage />);
    await screen.findByText('No patches found. Try adjusting your search or filters.');
    fireEvent.click(screen.getByRole('button', { name: 'Run Scan' }));

    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'error',
          message: expect.stringContaining('1 of 10'),
        })
      );
    });
    expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('9 skipped') })
    );
    // The whole point: NO clean success toast despite API success:true.
    expect(showToast).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success' })
    );
  });

  it('reports total failure with skipped breakdown when zero devices queued', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/update-rings') return makeJsonResponse({ data: [] });
      if (url === '/patches') return makeJsonResponse({ data: [] });
      if (url === '/devices?limit=100&page=1') {
        return makeJsonResponse({
          data: Array.from({ length: 5 }, (_, i) => ({ id: `device-${i + 1}`, hostname: `W${i + 1}` })),
          pagination: { page: 1, limit: 100, total: 5 },
        });
      }
      if (url === '/patches/scan') {
        return makeJsonResponse({
          success: false,
          queuedCommandIds: [],
          skipped: {
            missingDeviceIds: ['device-1', 'device-2'],
            inaccessibleDeviceIds: ['device-3', 'device-4', 'device-5'],
          },
        });
      }
      return makeJsonResponse({}, false, 404);
    });

    render(<PatchesPage />);
    await screen.findByText('No patches found. Try adjusting your search or filters.');
    fireEvent.click(screen.getByRole('button', { name: 'Run Scan' }));

    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'error',
          message: expect.stringContaining('0 of 5'),
        })
      );
    });
    expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('5 skipped') })
    );
    expect(showToast).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success' })
    );
  });
});
