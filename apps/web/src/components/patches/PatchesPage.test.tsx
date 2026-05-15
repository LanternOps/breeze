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

// Helper: set up fetchMock for rings-tab tests (rings + patches data).
// Returns the rings URL so callers can add extra cases.
function makeRingsTabMock(
  opts: {
    rings?: unknown[];
    deleteStatus?: number;
    deleteOk?: boolean;
    deletePayload?: unknown;
  } = {}
) {
  const rings: unknown[] = opts.rings ?? [
    {
      id: 'ring-1',
      name: 'Production Ring',
      ringOrder: 1,
      deferralDays: 7,
      deadlineDays: 30,
      gracePeriodHours: 24,
      enabled: true,
    },
  ];

  fetchMock.mockImplementation(async (input) => {
    const url = String(input);
    if (url === '/update-rings') return makeJsonResponse({ data: rings });
    if (url === '/patches') return makeJsonResponse({ data: [] });
    if (url.startsWith('/update-rings/') && url.includes('ring-1')) {
      const ok = opts.deleteOk ?? true;
      const status = opts.deleteStatus ?? (ok ? 200 : 500);
      return makeJsonResponse(opts.deletePayload ?? {}, ok, status);
    }
    return makeJsonResponse({}, false, 404);
  });
}

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

  // ─── handleRingDelete ────────────────────────────────────────────────────────

  describe('handleRingDelete', () => {
    async function renderAndOpenRingsTab() {
      render(<PatchesPage />);
      // Wait for initial data to load, then switch to rings tab
      await screen.findByText('No patches found. Try adjusting your search or filters.');
      fireEvent.click(screen.getByRole('button', { name: 'Update Rings' }));
      // Wait for ring name to appear in the table
      await screen.findByText('Production Ring');
    }

    it('success: shows success toast and refetches rings list', async () => {
      let deleteCallCount = 0;
      fetchMock.mockImplementation(async (input, init) => {
        const url = String(input);
        const method = (init as RequestInit | undefined)?.method ?? 'GET';
        if (url === '/update-rings') {
          // After delete, return empty list so we can confirm refetch happened
          if (deleteCallCount > 0) return makeJsonResponse({ data: [] });
          return makeJsonResponse({
            data: [
              {
                id: 'ring-1',
                name: 'Production Ring',
                ringOrder: 1,
                deferralDays: 7,
                deadlineDays: 30,
                gracePeriodHours: 24,
                enabled: true,
              },
            ],
          });
        }
        if (url === '/patches') return makeJsonResponse({ data: [] });
        if (url === '/update-rings/ring-1' && method === 'DELETE') {
          deleteCallCount++;
          return makeJsonResponse({}, true, 200);
        }
        return makeJsonResponse({}, false, 404);
      });

      await renderAndOpenRingsTab();

      // Click the delete button (Trash2 icon button, last button in the row)
      const allButtons = screen.getAllByRole('button');
      const deleteButton = allButtons.find((btn) => {
        const svg = btn.querySelector('svg');
        return svg !== null && btn.closest('td') !== null && btn.className.includes('destructive');
      });
      expect(deleteButton).toBeDefined();
      fireEvent.click(deleteButton!);

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          '/update-rings/ring-1',
          expect.objectContaining({ method: 'DELETE' })
        );
      });

      await waitFor(() => {
        expect(showToast).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'success', message: 'Update ring deleted.' })
        );
      });

      // After success, ring list is refetched and ring disappears
      await waitFor(() => {
        expect(screen.queryByText('Production Ring')).toBeNull();
      });
    });

    it('error/!ok: shows error toast, does NOT show success toast', async () => {
      makeRingsTabMock({ deleteOk: false, deleteStatus: 500 });

      await renderAndOpenRingsTab();

      const allButtons = screen.getAllByRole('button');
      const deleteButton = allButtons.find((btn) => {
        const svg = btn.querySelector('svg');
        return svg !== null && btn.closest('td') !== null && btn.className.includes('destructive');
      });
      expect(deleteButton).toBeDefined();
      fireEvent.click(deleteButton!);

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          '/update-rings/ring-1',
          expect.objectContaining({ method: 'DELETE' })
        );
      });

      await waitFor(() => {
        expect(showToast).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'error' })
        );
      });
      expect(showToast).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'success' })
      );
    });

    it('401: calls onUnauthorized (navigateTo /login), no toast, ring remains', async () => {
      fetchMock.mockImplementation(async (input, init) => {
        const url = String(input);
        const method = (init as RequestInit | undefined)?.method ?? 'GET';
        if (url === '/update-rings') return makeJsonResponse({
          data: [
            {
              id: 'ring-1',
              name: 'Production Ring',
              ringOrder: 1,
              deferralDays: 7,
              deadlineDays: 30,
              gracePeriodHours: 24,
              enabled: true,
            },
          ],
        });
        if (url === '/patches') return makeJsonResponse({ data: [] });
        if (url === '/update-rings/ring-1' && method === 'DELETE') {
          return makeJsonResponse({ error: 'Unauthorized' }, false, 401);
        }
        return makeJsonResponse({}, false, 404);
      });

      await renderAndOpenRingsTab();

      const allButtons = screen.getAllByRole('button');
      const deleteButton = allButtons.find((btn) => {
        const svg = btn.querySelector('svg');
        return svg !== null && btn.closest('td') !== null && btn.className.includes('destructive');
      });
      expect(deleteButton).toBeDefined();
      fireEvent.click(deleteButton!);

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          '/update-rings/ring-1',
          expect.objectContaining({ method: 'DELETE' })
        );
      });

      // Give a moment for any async side-effects
      await new Promise((r) => setTimeout(r, 50));

      // No toast on 401
      expect(showToast).not.toHaveBeenCalled();

      // Ring must still be visible (post-success refetch skipped)
      expect(screen.getByText('Production Ring')).toBeDefined();
    });
  });

  // ─── handleBulkApprove ───────────────────────────────────────────────────────

  describe('handleBulkApprove', () => {
    function makePatchesMock(
      approveResponse: { payload: unknown; ok?: boolean; status?: number }
    ) {
      fetchMock.mockImplementation(async (input, init) => {
        const url = String(input);
        const method = (init as RequestInit | undefined)?.method ?? 'GET';
        if (url === '/update-rings') return makeJsonResponse({ data: [] });
        if (url === '/patches') {
          return makeJsonResponse({
            data: [
              {
                id: 'patch-a',
                title: 'Security Patch Alpha',
                severity: 'critical',
                source: 'microsoft',
                os: 'windows',
                releaseDate: '2026-05-01T00:00:00.000Z',
                approvalStatus: 'pending',
              },
            ],
          });
        }
        if (url === '/patches/bulk-approve' && method === 'POST') {
          const ok = approveResponse.ok ?? true;
          const status = approveResponse.status ?? (ok ? 200 : 500);
          return makeJsonResponse(approveResponse.payload, ok, status);
        }
        return makeJsonResponse({}, false, 404);
      });
    }

    it('success: shows success toast and marks patches approved', async () => {
      makePatchesMock({
        payload: { approved: ['patch-a'], failed: [] },
      });

      render(<PatchesPage />);
      await screen.findByText('Security Patch Alpha');

      fireEvent.click(screen.getByRole('button', { name: 'Select Security Patch Alpha' }));
      fireEvent.click(screen.getByRole('button', { name: 'Approve 1' }));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          '/patches/bulk-approve',
          expect.objectContaining({ method: 'POST' })
        );
      });

      await waitFor(() => {
        expect(showToast).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'success' })
        );
      });

      // Approved patch button becomes Deploy
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Deploy' })).toBeDefined();
      });
    });

    it('error/!ok: shows error toast, no success toast', async () => {
      makePatchesMock({
        payload: { error: 'internal server error' },
        ok: false,
        status: 500,
      });

      render(<PatchesPage />);
      await screen.findByText('Security Patch Alpha');

      fireEvent.click(screen.getByRole('button', { name: 'Select Security Patch Alpha' }));
      fireEvent.click(screen.getByRole('button', { name: 'Approve 1' }));

      await waitFor(() => {
        expect(showToast).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'error' })
        );
      });
      expect(showToast).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'success' })
      );
      // Patch must remain in Review state (not approved)
      expect(screen.getByRole('button', { name: 'Review' })).toBeDefined();
    });

    it('401: no toast, no post-success effect', async () => {
      makePatchesMock({
        payload: { error: 'Unauthorized' },
        ok: false,
        status: 401,
      });

      render(<PatchesPage />);
      await screen.findByText('Security Patch Alpha');

      fireEvent.click(screen.getByRole('button', { name: 'Select Security Patch Alpha' }));
      fireEvent.click(screen.getByRole('button', { name: 'Approve 1' }));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          '/patches/bulk-approve',
          expect.objectContaining({ method: 'POST' })
        );
      });

      await new Promise((r) => setTimeout(r, 50));
      expect(showToast).not.toHaveBeenCalled();
      // Patch must NOT be marked approved
      expect(screen.getByRole('button', { name: 'Review' })).toBeDefined();
    });
  });
});
