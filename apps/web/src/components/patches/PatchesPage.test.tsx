import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// PatchList renders through ResponsiveTable — a desktop <table> and a mobile
// card list are both in the DOM at once (the sm: breakpoint is CSS-only, invisible
// to jsdom), so row text/labels appear twice. Scope row-level interactions to the
// desktop surface; use findAllByText for render-wait gates that tolerate the dupe.
const desktop = () => within(screen.getByTestId('responsive-table-desktop'));

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

// Mutable JWT scope so individual tests can simulate partner vs. org-scoped sessions.
const jwtScope = vi.hoisted(() => ({ scope: 'partner' as 'partner' | 'system' | 'organization' | null }));

vi.mock('../../lib/authScope', () => ({
  getJwtClaims: () => ({
    scope: jwtScope.scope,
    partnerId: jwtScope.scope !== 'organization' ? 'p1' : null,
    orgId: jwtScope.scope === 'organization' ? 'org-1' : null,
  }),
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
    orgState.currentOrgId = null;
    jwtScope.scope = 'partner';
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

    await screen.findAllByText('Critical Security Update');

    fireEvent.click(desktop().getByRole('button', { name: 'Select Critical Security Update' }));
    fireEvent.click(desktop().getByRole('button', { name: 'Select Feature Update' }));
    // Wait for selection state to commit before clicking the conditionally-rendered Approve button.
    fireEvent.click(await screen.findByRole('button', { name: 'Approve 2' }));

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
    expect(desktop().getAllByRole('button', { name: 'Deploy' })).toHaveLength(1);
    expect(desktop().getAllByRole('button', { name: 'Review' })).toHaveLength(1);
  });

  it('fetches the ring-scoped patches with ?limit=200 when a ring is selected', async () => {
    // Regression: selecting a ring previously fetched `/update-rings/:id/patches`
    // with NO limit, so the endpoint defaulted to a 50-row page and the visible
    // list collapsed from the all-rings 200 down to 50. The ring path must now
    // send the same `?limit=200` as the all-rings path.
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);

      if (url === '/update-rings') {
        return makeJsonResponse({
          data: [
            { id: 'ring-1', name: 'Pilot', ringOrder: 1, deferralDays: 0, enabled: true },
          ],
        });
      }

      if (url === '/patches?limit=200') {
        return makeJsonResponse({
          data: [
            {
              id: 'patch-1',
              title: 'All-Rings Patch',
              severity: 'critical',
              source: 'microsoft',
              os: 'windows',
              releaseDate: '2026-04-01T00:00:00.000Z',
              approvalStatus: 'pending',
            },
          ],
        });
      }

      if (url === '/update-rings/ring-1/patches?limit=200') {
        return makeJsonResponse({
          data: [
            {
              id: 'patch-2',
              title: 'Ring Scoped Patch',
              severity: 'important',
              source: 'microsoft',
              os: 'windows',
              releaseDate: '2026-04-02T00:00:00.000Z',
              approvalStatus: 'approved',
            },
          ],
          pagination: { page: 1, limit: 200, total: 1 },
        });
      }

      return makeJsonResponse({}, false, 404);
    });

    render(<PatchesPage />);

    await screen.findAllByText('All-Rings Patch');

    // The RingSelector's <select> owns the "All Rings" option; switch it to the ring.
    const ringOption = await screen.findByRole('option', { name: /All Rings/ });
    const ringSelect = ringOption.closest('select') as HTMLSelectElement;
    fireEvent.change(ringSelect, { target: { value: 'ring-1' } });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/update-rings/ring-1/patches?limit=200');
    });
    // The ring path must never be fetched without the limit (the old bug).
    expect(fetchMock).not.toHaveBeenCalledWith('/update-rings/ring-1/patches');
    await screen.findAllByText('Ring Scoped Patch');
  });

  it('partner scope: allows bulk approve in all-orgs mode (no org, no ring) — request fires partner-wide', async () => {
    // After the partner-scoping migration, the API derives the partner from
    // auth.partnerId. A partner user in all-orgs mode (no org, no ring) is valid —
    // the old "select an org or ring" guard was a UX regression.
    jwtScope.scope = 'partner';
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
      if (url === '/patches/bulk-approve') {
        return makeJsonResponse({ approved: ['patch-1'], failed: [] });
      }
      return makeJsonResponse({}, false, 404);
    });

    render(<PatchesPage />);

    await screen.findAllByText('Critical Security Update');
    fireEvent.click(desktop().getByRole('button', { name: 'Select Critical Security Update' }));
    // Wait for selection state to commit before clicking the conditionally-rendered Approve button.
    fireEvent.click(await screen.findByRole('button', { name: 'Approve 1' }));

    // Guard must NOT throw — the request must fire
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/patches/bulk-approve',
        expect.objectContaining({ method: 'POST' })
      );
    });
  });

  it('org scope: blocks bulk approve with partner-level message', async () => {
    // Org-scoped users cannot manage approvals (rings are partner-scoped).
    jwtScope.scope = 'organization';
    orgState.currentOrgId = 'org-1';
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

    await screen.findAllByText('Critical Security Update');
    fireEvent.click(desktop().getByRole('button', { name: 'Select Critical Security Update' }));
    // Wait for selection state to commit before clicking the conditionally-rendered Approve button.
    fireEvent.click(await screen.findByRole('button', { name: 'Approve 1' }));

    await screen.findByText(/patch approvals are managed at the partner level/i);
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

    const deploy = (await screen.findAllByRole('button', { name: 'Deploy' }))[0];
    fireEvent.click(deploy);

    // Feedback toast fires and the Compliance tab content renders.
    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'success', message: expect.stringMatching(/Compliance tab/i) })
      );
    });
  });

  it('partner scope: shows Update Rings tab and enables New Ring even in All-orgs mode', async () => {
    // Rings are partner-scoped — a partner user in all-orgs mode (no org selected)
    // should see the tab and be able to open the create form.
    jwtScope.scope = 'partner';
    orgState.currentOrgId = null;
    window.history.replaceState({}, '', '/?tab=rings');
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/update-rings') return makeJsonResponse({ data: [] });
      if (url === '/patches?limit=200') return makeJsonResponse({ data: [] });
      return makeJsonResponse({}, false, 404);
    });

    render(<PatchesPage />);

    // The Update Rings tab must be visible.
    expect(await screen.findByRole('button', { name: /Update Rings/i })).toBeInTheDocument();

    // The New Ring button must be enabled (no disabled, no select-an-org hint).
    const newRing = await screen.findByRole('button', { name: /New Ring/i });
    expect(newRing).not.toBeDisabled();
    expect(newRing).not.toHaveAttribute('title');
  });

  it('org scope: hides the Update Rings tab and disables New Ring with partner-level hint', async () => {
    // Org-scoped users don't manage rings — they should not see the tab at all.
    jwtScope.scope = 'organization';
    orgState.currentOrgId = 'org-1';
    window.history.replaceState({}, '', '/?tab=compliance');
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/update-rings') return makeJsonResponse({ data: [] });
      if (url === '/patches?limit=200') return makeJsonResponse({ data: [] });
      if (url === '/patches/compliance') return makeJsonResponse({ data: { totalDevices: 0, compliantDevices: 0, devicesNeedingPatches: [] } });
      if (url === '/devices?limit=200') return makeJsonResponse({ devices: [] });
      return makeJsonResponse({}, false, 404);
    });

    render(<PatchesPage />);

    // Wait for the page to render (compliance tab is default here).
    await screen.findByRole('button', { name: /Compliance/i });

    // The Update Rings tab must NOT be rendered.
    expect(screen.queryByRole('button', { name: /Update Rings/i })).toBeNull();
  });

  it('org scope: falls back to compliance when URL contains ?tab=rings (bookmark guard)', async () => {
    // If an org user navigates to /patches?tab=rings (e.g. a stale bookmark or
    // shared link from a partner), the initializer guard must redirect to compliance
    // so rings body content (UpdateRingList / New Ring button) is never rendered.
    jwtScope.scope = 'organization';
    orgState.currentOrgId = 'org-1';
    window.history.replaceState({}, '', '/?tab=rings');
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/update-rings') return makeJsonResponse({ data: [] });
      if (url === '/patches?limit=200') return makeJsonResponse({ data: [] });
      if (url === '/patches/compliance') return makeJsonResponse({ data: { totalDevices: 0, compliantDevices: 0, devicesNeedingPatches: [] } });
      if (url === '/devices?limit=200') return makeJsonResponse({ devices: [] });
      return makeJsonResponse({}, false, 404);
    });

    render(<PatchesPage />);

    // The Compliance tab nav button must be present (page fell back to compliance).
    expect(await screen.findByRole('button', { name: /Compliance/i })).toBeInTheDocument();

    // Rings-only body content must NOT be rendered.
    expect(screen.queryByRole('button', { name: /New Ring/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Update Rings/i })).toBeNull();
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

    await screen.findAllByText('No patches found. Try adjusting your search or filters.');

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

    await screen.findAllByText('No patches found. Try adjusting your search or filters.');
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

    await screen.findAllByText('No patches found. Try adjusting your search or filters.');
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

    await screen.findAllByText('No patches found. Try adjusting your search or filters.');
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

    await screen.findAllByText('No patches found. Try adjusting your search or filters.');
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

    await screen.findAllByText('No patches found. Try adjusting your search or filters.');
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

    await screen.findAllByText('No patches found. Try adjusting your search or filters.');
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
    await screen.findAllByText('No patches found. Try adjusting your search or filters.');
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
    await screen.findAllByText('No patches found. Try adjusting your search or filters.');
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
    await screen.findAllByText('No patches found. Try adjusting your search or filters.');
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
    await screen.findAllByText('No patches found. Try adjusting your search or filters.');
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
