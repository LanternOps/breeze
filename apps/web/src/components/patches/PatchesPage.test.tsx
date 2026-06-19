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

// Mutable org-shell state so individual tests can model an org-scoped user
// (currentOrgId set) vs. a partner on the global /patches view (currentOrgId null).
const orgState = vi.hoisted(() => ({ currentOrgId: null as string | null }));

vi.mock('../../stores/orgStore', () => {
  const organizations = [
    { id: 'org-1', name: 'Acme Corp' },
    { id: 'org-2', name: 'Globex' },
  ];
  const read = () => ({ currentOrgId: orgState.currentOrgId, organizations });
  return { useOrgStore: Object.assign(read, { getState: read }) };
});

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
    orgState.currentOrgId = null;
    window.history.replaceState({}, '', '/?tab=patches');
  });

  it('keeps failed bulk approvals pending when the API only approves some patches', async () => {
    // Org-scoped session: the API derives the target org from auth.orgId, so the
    // bulk-approve request fires without an explicit org/ring selection.
    orgState.currentOrgId = 'org-1';
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);

      if (url === '/update-rings') {
        return makeJsonResponse({ data: [] });
      }

      if (url === '/patches?limit=200') {
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

  it('blocks bulk approve and prompts for an update ring when there is no org context', async () => {
    // Partner on the global /patches view: no current org and no ring selected.
    // Approval is ring-scoped, so the request would 400 ('orgId is required for
    // partner/system scope') — guard it client-side with a clear prompt instead.
    orgState.currentOrgId = null;
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/update-rings') return makeJsonResponse({ data: [] });
      if (url === '/patches?limit=200') {
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
          ],
        });
      }
      return makeJsonResponse({}, false, 404);
    });

    render(<PatchesPage />);

    await screen.findByText('Critical Security Update');
    fireEvent.click(screen.getByRole('button', { name: 'Select Critical Security Update' }));
    fireEvent.click(screen.getByRole('button', { name: 'Approve 1' }));

    await screen.findByText(/select an organization or update ring/i);
    expect(fetchMock).not.toHaveBeenCalledWith('/patches/bulk-approve', expect.anything());
  });

  it('Deploy on an approved patch routes to the Compliance tab with feedback (no dead click)', async () => {
    orgState.currentOrgId = 'org-1';
    window.history.replaceState({}, '', '/?tab=patches');
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/update-rings') return makeJsonResponse({ data: [] });
      if (url === '/patches?limit=200') {
        return makeJsonResponse({
          data: [
            {
              id: 'patch-1',
              title: 'Approved Update',
              severity: 'critical',
              source: 'microsoft',
              os: 'windows',
              releaseDate: '2026-04-01T00:00:00.000Z',
              approvalStatus: 'approved',
            },
          ],
        });
      }
      // Compliance tab data (rendered after Deploy switches tabs).
      if (url === '/patches/compliance') {
        return makeJsonResponse({ data: { totalDevices: 0, compliantDevices: 0, devicesNeedingPatches: [] } });
      }
      if (url === '/devices?limit=200') return makeJsonResponse({ devices: [] });
      return makeJsonResponse({}, false, 404);
    });

    render(<PatchesPage />);

    const deploy = await screen.findByRole('button', { name: 'Deploy' });
    fireEvent.click(deploy);

    // Feedback toast fires and the Compliance tab content renders.
    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'success', message: expect.stringMatching(/Compliance tab/i) })
      );
    });
  });

  it('disables New Ring in All-orgs mode (currentOrgId null) with a select-an-org hint', async () => {
    orgState.currentOrgId = null;
    window.history.replaceState({}, '', '/?tab=rings');
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/update-rings') return makeJsonResponse({ data: [] });
      if (url === '/patches?limit=200') return makeJsonResponse({ data: [] });
      return makeJsonResponse({}, false, 404);
    });

    render(<PatchesPage />);

    const newRing = await screen.findByRole('button', { name: /New Ring/i });
    expect(newRing).toBeDisabled();
    expect(newRing).toHaveAttribute('title', expect.stringMatching(/select an organization/i));
  });

  it('enables New Ring when a specific org is selected and creates the ring (orgId auto-injected) with a success toast', async () => {
    orgState.currentOrgId = 'org-1';
    window.history.replaceState({}, '', '/?tab=rings');
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/update-rings' && (!init || init.method === undefined)) {
        return makeJsonResponse({ data: [] });
      }
      if (url === '/patches?limit=200') return makeJsonResponse({ data: [] });
      if (url === '/update-rings' && init?.method === 'POST') {
        return makeJsonResponse({ data: { id: 'ring-new' } });
      }
      return makeJsonResponse({}, false, 404);
    });

    render(<PatchesPage />);

    const newRing = await screen.findByRole('button', { name: /New Ring/i });
    expect(newRing).not.toBeDisabled();
    fireEvent.click(newRing);

    // Fill the minimal ring form and submit.
    fireEvent.change(await screen.findByPlaceholderText(/Pilot, Broad/i), { target: { value: 'Pilot' } });
    fireEvent.click(screen.getByRole('button', { name: /Create Ring/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/update-rings',
        expect.objectContaining({ method: 'POST' })
      );
    });
    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'success', message: 'Update ring created' })
      );
    });
  });

  it('surfaces a failure toast (and keeps the dialog open) when create-ring fails', async () => {
    orgState.currentOrgId = 'org-1';
    window.history.replaceState({}, '', '/?tab=rings');
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/update-rings' && (!init || init.method === undefined)) {
        return makeJsonResponse({ data: [] });
      }
      if (url === '/patches?limit=200') return makeJsonResponse({ data: [] });
      if (url === '/update-rings' && init?.method === 'POST') {
        return makeJsonResponse({ error: 'Ring name already in use' }, false, 409);
      }
      return makeJsonResponse({}, false, 404);
    });

    render(<PatchesPage />);

    fireEvent.click(await screen.findByRole('button', { name: /New Ring/i }));
    fireEvent.change(await screen.findByPlaceholderText(/Pilot, Broad/i), { target: { value: 'Pilot' } });
    fireEvent.click(screen.getByRole('button', { name: /Create Ring/i }));

    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error', message: 'Ring name already in use' })
      );
    });
    // Dialog remains open + actionable (the form's submit button is still there).
    expect(screen.getByRole('button', { name: /Create Ring/i })).toBeTruthy();
  });

  it('does NOT fire the scan POST until the confirm button is clicked', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);

      if (url === '/update-rings') return makeJsonResponse({ data: [] });
      if (url === '/patches?limit=200') return makeJsonResponse({ data: [] });

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

    // Click "Run Scan" — this should NOT yet fire the POST
    fireEvent.click(screen.getByRole('button', { name: 'Run Scan' }));

    // The confirmation dialog must appear with a message naming the organizations.
    // scopeConfirmMessage formats multi-org as "across N organizations (Acme Corp, Globex)?"
    const confirmMsg = await screen.findByText(/Scan for patches on \d+ device/i);
    expect(confirmMsg).toBeTruthy();
    expect(confirmMsg.textContent).toMatch(/Acme Corp|Globex|organizations/i);

    // Scan POST must NOT have been called yet
    expect(fetchMock).not.toHaveBeenCalledWith('/patches/scan', expect.anything());

    // Now click the confirm button
    fireEvent.click(screen.getByTestId('confirm-fleet-action'));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/patches/scan',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ deviceIds: ['device-1'] }),
        })
      );
    });
  });

  it('queues scans for every device page instead of only the first 100 devices', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);

      if (url === '/update-rings') {
        return makeJsonResponse({ data: [] });
      }

      if (url === '/patches?limit=200') {
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

    // Wait for confirm dialog and click confirm
    await screen.findByTestId('confirm-fleet-action');
    fireEvent.click(screen.getByTestId('confirm-fleet-action'));

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
      if (url === '/patches?limit=200') return makeJsonResponse({ data: [] });

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

    // Wait for confirm dialog and click confirm
    await screen.findByTestId('confirm-fleet-action');
    fireEvent.click(screen.getByTestId('confirm-fleet-action'));

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
      if (url === '/patches?limit=200') return makeJsonResponse({ data: [] });

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
      if (url === '/patches?limit=200') return makeJsonResponse({ data: [] });

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
      if (url === '/patches?limit=200') return makeJsonResponse({ data: [] });

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

    // Wait for confirm dialog and click confirm
    await screen.findByTestId('confirm-fleet-action');
    fireEvent.click(screen.getByTestId('confirm-fleet-action'));

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
      if (url === '/patches?limit=200') return makeJsonResponse({ data: [] });

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

    // Wait for confirm dialog and click confirm
    await screen.findByTestId('confirm-fleet-action');
    fireEvent.click(screen.getByTestId('confirm-fleet-action'));

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
      if (url === '/patches?limit=200') return makeJsonResponse({ data: [] });
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

    // Wait for confirm dialog and click confirm
    await screen.findByTestId('confirm-fleet-action');
    fireEvent.click(screen.getByTestId('confirm-fleet-action'));

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
      if (url === '/patches?limit=200') return makeJsonResponse({ data: [] });
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

    // Wait for confirm dialog and click confirm
    await screen.findByTestId('confirm-fleet-action');
    fireEvent.click(screen.getByTestId('confirm-fleet-action'));

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

  it('names the devices\' true orgs in the scan confirmation — not the stale shell selection (multi-org regression)', async () => {
    // The user shell has currentOrgId=null (global view). Devices belong to two
    // different orgs. The scan confirmation must name both orgs and must NOT name
    // a single stale org from currentOrgId.
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/update-rings') return makeJsonResponse({ data: [] });
      if (url === '/patches?limit=200') return makeJsonResponse({ data: [] });

      if (url === '/devices?limit=100&page=1') {
        return makeJsonResponse({
          data: [
            { id: 'device-1', hostname: 'W1', orgId: 'org-1' },
            { id: 'device-2', hostname: 'W2', orgId: 'org-2' },
          ],
          pagination: { page: 1, limit: 100, total: 2 },
        });
      }

      if (url === '/patches/scan') {
        return makeJsonResponse({ queuedCommandIds: ['cmd-1', 'cmd-2'] });
      }

      return makeJsonResponse({}, false, 404);
    });

    render(<PatchesPage />);
    await screen.findByText('No patches found. Try adjusting your search or filters.');
    fireEvent.click(screen.getByRole('button', { name: 'Run Scan' }));

    // Confirmation must reflect the two actual target orgs
    const confirmDialog = await screen.findByTestId('confirm-fleet-action');
    const dialogText = confirmDialog.closest('[role="dialog"]')?.textContent ?? document.body.textContent ?? '';
    // Must mention multiple organizations (scopeConfirmMessage: "across N organizations (Acme Corp, Globex)")
    expect(dialogText).toMatch(/across \d+ organizations/i);
    expect(dialogText).toMatch(/Acme Corp/i);
    expect(dialogText).toMatch(/Globex/i);
    // Must NOT name a single org that was stale from the shell selection
    // (currentOrgId is null in this mock, so neither should appear alone)
    expect(dialogText).not.toMatch(/^.*in Acme Corp\?.*$/);

    // Cancel — don't actually scan in this assertion-focused test
    const cancelButton = screen.getAllByRole('button').find(b => b.textContent === 'Cancel');
    if (cancelButton) fireEvent.click(cancelButton);
  });

  it('reports total failure with skipped breakdown when zero devices queued', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/update-rings') return makeJsonResponse({ data: [] });
      if (url === '/patches?limit=200') return makeJsonResponse({ data: [] });
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

    // Wait for confirm dialog and click confirm
    await screen.findByTestId('confirm-fleet-action');
    fireEvent.click(screen.getByTestId('confirm-fleet-action'));

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
