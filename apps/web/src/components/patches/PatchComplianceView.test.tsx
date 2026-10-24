import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@/lib/i18n';

// Mock showToast so runAction (used by handleExport) writes to the spy.
const showToast = vi.fn();
vi.mock('../../components/shared/Toast', () => ({ showToast: (a: unknown) => showToast(a) }));

// The completed-report download is saved through the shared blob helper; spy on
// it so the export tests can assert the file name without jsdom object URLs.
const downloadBlobMock = vi.fn();
vi.mock('@/lib/downloadBlob', () => ({
  downloadBlob: (...a: unknown[]) => downloadBlobMock(...a),
}));

import PatchComplianceView from './PatchComplianceView';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

// Two orgs in store. currentOrgId defaults to org-1, but the multi-org scan
// confirm test relies on devices spanning both orgs (the message must name
// both — not just "Acme Corp" from currentOrgId). currentOrgId is mutable so
// the export tests can model All-orgs mode (null) vs. a specific org selected.
const orgState = vi.hoisted(() => ({ currentOrgId: 'org-1' as string | null }));
vi.mock('../../stores/orgStore', () => {
  const organizations = [
    { id: 'org-1', name: 'Acme Corp' },
    { id: 'org-2', name: 'Globex' },
  ];
  const read = () => ({ organizations, currentOrgId: orgState.currentOrgId });
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

// #9791 C: the view reads one page of device rows, the device percentage and
// every count from GET /patches/compliance (no more /devices?limit=200 merge).
type ApiRow = {
  id: string;
  hostname: string;
  displayName: string | null;
  osType: string;
  lastSeenAt: string | null;
  status: string | null;
  orgId: string | null;
  pendingPatches: number;
  approvedMissing: number;
  unapprovedMissing: number;
  failedMissing: number;
  criticalMissing: number;
  importantMissing: number;
  osMissing: number;
  thirdPartyMissing: number;
  staleImages: number;
  pendingReboot: boolean;
  lastInstalledAt: string | null;
  lastScannedAt: string | null;
  compliant: boolean;
};

const apiRow = (over: Partial<ApiRow> & Pick<ApiRow, 'id' | 'hostname'>): ApiRow => {
  const row: ApiRow = {
    displayName: null, osType: 'windows', lastSeenAt: null, status: 'online', orgId: 'org-1',
    pendingPatches: 0, approvedMissing: 0, unapprovedMissing: 0, failedMissing: 0,
    criticalMissing: 0, importantMissing: 0, osMissing: 0, thirdPartyMissing: 0, staleImages: 0,
    pendingReboot: false, lastInstalledAt: null, lastScannedAt: null, compliant: true, ...over,
  };
  if (over.compliant === undefined) row.compliant = row.pendingPatches === 0 && row.staleImages === 0;
  return row;
};

/** A /patches/compliance payload whose summary fields agree with `rows`. */
const compliancePayload = (rows: ApiRow[], extra: Record<string, unknown> = {}) => {
  const n = (p: (r: ApiRow) => boolean) => rows.filter(p).length;
  const sum = (p: (r: ApiRow) => number) => rows.reduce((a, r) => a + p(r), 0);
  const compliant = n((r) => r.compliant);
  return {
    data: {
      totalDevices: rows.length,
      compliantDevices: compliant,
      devicePercent: rows.length ? Math.round((compliant / rows.length) * 100) : 0,
      failedDevices: n((r) => r.failedMissing > 0),
      deviceCounts: {
        all: rows.length, compliant, needsPatches: rows.length - compliant,
        failed: n((r) => r.failedMissing > 0), critical: n((r) => r.criticalMissing > 0),
        reboot: n((r) => r.pendingReboot), thirdParty: n((r) => r.thirdPartyMissing > 0),
      },
      outstandingTotals: {
        patches: sum((r) => r.pendingPatches), approved: sum((r) => r.approvedMissing),
        unapproved: sum((r) => r.unapprovedMissing), failed: sum((r) => r.failedMissing),
        critical: sum((r) => r.criticalMissing),
      },
      devices: rows,
      devicesPage: { status: 'all', search: null, limit: 50, offset: 0, total: rows.length },
      ...extra,
    },
  };
};

// The view clears its selection in a passive effect keyed on the loaded rows.
// `findBy*` can resolve on the commit before that effect has run (under CPU
// load it runs later), and the late clear then wipes a box the test just
// ticked. Flush it before the first interaction so the order is deterministic.
const settleLoadedRows = () => act(async () => { await Promise.resolve(); });

const isComplianceList = (url: string) =>
  url.startsWith('/patches/compliance') && !url.startsWith('/patches/compliance/report');

describe('PatchComplianceView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    orgState.currentOrgId = 'org-1';
  });

  // Minimal compliance + devices payloads for the export tests (no devices need).
  const emptyComplianceImpl = (extra: (url: string) => Response | null) =>
    async (input: unknown) => {
      const url = String(input);
      if (url === '/patches/compliance') {
        return makeJsonResponse({ data: { totalDevices: 0, compliantDevices: 0, devicesNeedingPatches: [] } });
      }
      if (url === '/devices?limit=200') return makeJsonResponse({ devices: [] });
      const e = extra(url);
      if (e) return e;
      return makeJsonResponse({}, false, 404);
    };

  it('gives the compliance status filter select an accessible name', async () => {
    fetchMock.mockImplementation(emptyComplianceImpl(() => null));
    render(<PatchComplianceView ringId={null} />);
    expect(await screen.findByRole('combobox', { name: 'Compliance status filter' })).toBeInTheDocument();
  });

  it('disables Export in All-orgs mode (no org, no ring) with a select-an-org hint', async () => {
    orgState.currentOrgId = null;
    fetchMock.mockImplementation(emptyComplianceImpl(() => null));

    render(<PatchComplianceView ringId={null} />);

    const exportBtn = await screen.findByRole('button', { name: /Export/i });
    expect(exportBtn).toBeDisabled();
    expect(exportBtn).toHaveAttribute('title', expect.stringMatching(/select an organization/i));
  });

  it('exports (orgId auto-injected) and surfaces a queued banner when an org is selected', async () => {
    orgState.currentOrgId = 'org-1';
    fetchMock.mockImplementation(
      emptyComplianceImpl((url) =>
        url.startsWith('/patches/compliance/report?')
          ? makeJsonResponse({ reportId: 'rep-1' })
          : null
      )
    );

    render(<PatchComplianceView ringId={null} />);

    fireEvent.click(await screen.findByRole('button', { name: /Export/i }));

    await waitFor(() => {
      const exportCall = fetchMock.mock.calls.find((c) =>
        String(c[0]).startsWith('/patches/compliance/report?')
      );
      expect(exportCall).toBeTruthy();
    });
    expect(await screen.findByText(/Compliance report rep-1 queued/i)).toBeTruthy();
  });

  it('stops polling and shows the expired state when the report file has expired', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      orgState.currentOrgId = 'org-1';
      fetchMock.mockImplementation(
        emptyComplianceImpl((url) => {
          if (url.startsWith('/patches/compliance/report?')) return makeJsonResponse({ reportId: 'rep-1' });
          if (url === '/patches/compliance/report/rep-1') {
            return makeJsonResponse({ data: { id: 'rep-1', status: 'expired', downloadUrl: null } });
          }
          return null;
        })
      );

      render(<PatchComplianceView ringId={null} />);
      fireEvent.click(await screen.findByRole('button', { name: /Export/i }));
      await screen.findByText(/Compliance report rep-1 queued/i);

      await vi.advanceTimersByTimeAsync(3100);

      expect(await screen.findByText(/Compliance report rep-1 has expired/i)).toBeTruthy();
      const statusCalls = () => fetchMock.mock.calls.filter((c) => String(c[0]) === '/patches/compliance/report/rep-1').length;
      const callsAfterExpiry = statusCalls();
      await vi.advanceTimersByTimeAsync(6100);
      expect(statusCalls()).toBe(callsAfterExpiry);
    } finally {
      vi.useRealTimers();
    }
  });

  it('surfaces an error toast when the export request fails (HTTP 500)', async () => {
    orgState.currentOrgId = 'org-1';
    fetchMock.mockImplementation(
      emptyComplianceImpl((url) =>
        url.startsWith('/patches/compliance/report?')
          ? makeJsonResponse({ error: 'report engine down' }, false, 500)
          : null
      )
    );

    render(<PatchComplianceView ringId={null} />);

    fireEvent.click(await screen.findByRole('button', { name: /Export/i }));

    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error', message: 'report engine down' })
      );
    });
  });

  describe('completed report download (#8306)', () => {
    const originalLocation = window.location;
    let assign: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      assign = vi.fn();
      Object.defineProperty(window, 'location', {
        value: { ...originalLocation, assign, href: originalLocation.href },
        writable: true,
        configurable: true,
      });
    });

    afterEach(() => {
      vi.useRealTimers();
      Object.defineProperty(window, 'location', {
        value: originalLocation,
        writable: true,
        configurable: true,
      });
    });

    const csvBlob = new Blob(['device,status\n'], { type: 'text/csv' });
    const makeBlobResponse = (ok = true, status = ok ? 200 : 500): Response =>
      ({
        ok,
        status,
        statusText: ok ? 'OK' : 'ERROR',
        blob: vi.fn().mockResolvedValue(csvBlob),
        json: vi.fn().mockResolvedValue({ error: 'download failed' }),
      }) as unknown as Response;

    const exportImpl = (download: () => Response) =>
      emptyComplianceImpl((url) => {
        if (url.startsWith('/patches/compliance/report?')) return makeJsonResponse({ reportId: 'rep-1' });
        if (url === '/patches/compliance/report/rep-1') {
          return makeJsonResponse({ data: { id: 'rep-1', status: 'completed' } });
        }
        if (url === '/patches/compliance/report/rep-1/download') return download();
        return null;
      });

    it('fetches the download with the session (fetchWithAuth) and saves the CSV without navigating', async () => {
      orgState.currentOrgId = 'org-1';
      fetchMock.mockImplementation(exportImpl(() => makeBlobResponse()));

      render(<PatchComplianceView ringId={null} />);
      fireEvent.click(await screen.findByRole('button', { name: /Export/i }));
      expect(await screen.findByText(/Compliance report rep-1 queued/i)).toBeTruthy();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });

      await waitFor(() => {
        expect(downloadBlobMock).toHaveBeenCalledWith(csvBlob, 'patch-compliance-rep-1.csv');
      });
      expect(fetchMock).toHaveBeenCalledWith('/patches/compliance/report/rep-1/download');
      expect(assign).not.toHaveBeenCalled();
    });

    it('surfaces an error and saves nothing when the download request fails', async () => {
      orgState.currentOrgId = 'org-1';
      fetchMock.mockImplementation(exportImpl(() => makeBlobResponse(false, 500)));

      render(<PatchComplianceView ringId={null} />);
      fireEvent.click(await screen.findByRole('button', { name: /Export/i }));
      expect(await screen.findByText(/Compliance report rep-1 queued/i)).toBeTruthy();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });

      expect(await screen.findByText(/Failed to download compliance report rep-1/i)).toBeTruthy();
      expect(downloadBlobMock).not.toHaveBeenCalled();
      expect(assign).not.toHaveBeenCalled();
    });

    it('a superseded export whose download fails does not stop the newer export poll', async () => {
      orgState.currentOrgId = 'org-1';
      let queued = 0;
      let failStaleDownload: (r: Response) => void = () => {};
      const staleDownload = new Promise<Response>((resolve) => { failStaleDownload = resolve; });
      fetchMock.mockImplementation(async (input: unknown) => {
        const url = String(input);
        if (url.startsWith('/patches/compliance/report?')) {
          queued += 1;
          return makeJsonResponse({ reportId: queued === 1 ? 'rep-1' : 'rep-2' });
        }
        if (url === '/patches/compliance/report/rep-1') {
          return makeJsonResponse({ data: { id: 'rep-1', status: 'completed' } });
        }
        if (url === '/patches/compliance/report/rep-1/download') return staleDownload;
        if (url === '/patches/compliance/report/rep-2') {
          return makeJsonResponse({ data: { id: 'rep-2', status: 'pending' } });
        }
        return emptyComplianceImpl(() => null)(input);
      });

      render(<PatchComplianceView ringId={null} />);
      const exportBtn = await screen.findByRole('button', { name: /Export/i });
      fireEvent.click(exportBtn);
      expect(await screen.findByText(/Compliance report rep-1 queued/i)).toBeTruthy();

      // rep-1 completes; its download is now in flight (held open).
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith('/patches/compliance/report/rep-1/download');
      });

      // The user exports again while rep-1's download is still pending.
      fireEvent.click(exportBtn);
      expect(await screen.findByText(/Compliance report rep-2 queued/i)).toBeTruthy();

      // The stale rep-1 download now fails.
      await act(async () => {
        failStaleDownload(makeBlobResponse(false, 500));
        await Promise.resolve();
      });

      const rep2Polls = () =>
        fetchMock.mock.calls.filter((c) => String(c[0]) === '/patches/compliance/report/rep-2').length;
      const before = rep2Polls();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(rep2Polls()).toBeGreaterThan(before);
      expect(screen.queryByText(/Failed to download compliance report rep-1/i)).toBeNull();
      expect(screen.getByText(/Compliance report rep-2 queued/i)).toBeTruthy();
    });
  });

  it('resolves approved pending patch ids before queuing bulk install', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (isComplianceList(url)) {
        return makeJsonResponse(compliancePayload([
          apiRow({
            id: '11111111-1111-1111-1111-111111111111',
            hostname: 'Workstation-1',
            pendingPatches: 2,
            approvedMissing: 2,
            criticalMissing: 1,
            importantMissing: 1,
            osMissing: 2,
            lastSeenAt: '2026-04-01T18:00:00.000Z',
          }),
        ]));
      }

      if (url === '/devices/11111111-1111-1111-1111-111111111111/patches') {
        return makeJsonResponse({
          data: {
            pending: [
              { id: '22222222-2222-2222-2222-222222222222', title: 'KB5050001', approvalStatus: 'approved' },
              { id: '33333333-3333-3333-3333-333333333333', title: 'KB5050002', approvalStatus: 'approved' },
            ],
          },
        });
      }

      if (url === '/devices/11111111-1111-1111-1111-111111111111/patches/install') {
        return makeJsonResponse({
          success: true,
          commandId: 'cmd-install-1',
          commandStatus: 'sent',
          patchCount: 2,
        });
      }

      return makeJsonResponse({}, false, 404);
    });

    render(<PatchComplianceView ringId={null} />);

    await screen.findByText('Workstation-1');

    await settleLoadedRows();
    fireEvent.click(screen.getByRole('button', { name: 'Select Workstation-1' }));
    fireEvent.click(screen.getByRole('button', { name: /Install \(1\)/i }));
    fireEvent.click(screen.getByTestId('confirm-fleet-action'));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/devices/11111111-1111-1111-1111-111111111111/patches/install',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            patchIds: [
              '22222222-2222-2222-2222-222222222222',
              '33333333-3333-3333-3333-333333333333',
            ],
          }),
        })
      );
    });

    expect(await screen.findByText('Patch install queued on 1 device')).toBeTruthy();
  });

  it('sends only approved patch ids when a device has mixed approval state', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (isComplianceList(url)) {
        return makeJsonResponse(compliancePayload([
          apiRow({
            id: '11111111-1111-1111-1111-111111111111',
            hostname: 'Workstation-1',
            pendingPatches: 2,
            approvedMissing: 1,
            unapprovedMissing: 1,
            osMissing: 2,
            lastSeenAt: '2026-04-01T18:00:00.000Z',
          }),
        ]));
      }

      if (url === '/devices/11111111-1111-1111-1111-111111111111/patches') {
        return makeJsonResponse({
          data: {
            pending: [
              { id: '22222222-2222-2222-2222-222222222222', title: 'KB5050001', approvalStatus: 'approved' },
              { id: '33333333-3333-3333-3333-333333333333', title: 'KB5050002', approvalStatus: 'pending' },
            ],
          },
        });
      }

      if (url === '/devices/11111111-1111-1111-1111-111111111111/patches/install') {
        return makeJsonResponse({
          success: true,
          commandId: 'cmd-install-1',
          commandStatus: 'sent',
          patchCount: 1,
        });
      }

      return makeJsonResponse({}, false, 404);
    });

    render(<PatchComplianceView ringId={null} />);

    await screen.findByText('Workstation-1');

    await settleLoadedRows();
    fireEvent.click(screen.getByRole('button', { name: 'Select Workstation-1' }));
    fireEvent.click(screen.getByRole('button', { name: /Install \(1\)/i }));
    fireEvent.click(screen.getByTestId('confirm-fleet-action'));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/devices/11111111-1111-1111-1111-111111111111/patches/install',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            patchIds: ['22222222-2222-2222-2222-222222222222'],
          }),
        })
      );
    });

    // The unapproved patch was dropped — surface that in the result message.
    expect(
      await screen.findByText(/skipped pending approval/i)
    ).toBeTruthy();
  });

  it('scan confirmation names the selected devices\' true orgs — not the stale currentOrgId (multi-org regression)', async () => {
    // currentOrgId is 'org-1' (Acme Corp) in the store mock, but we have devices
    // from both org-1 and org-2. The confirmation for a bulk scan on those two
    // devices must name BOTH orgs, not just "Acme Corp".
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (isComplianceList(url)) {
        // Each row's orgId comes from the compliance API itself (#9791 C).
        return makeJsonResponse(compliancePayload([
          apiRow({
            id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
            hostname: 'Acme-Device',
            osType: 'windows',
            orgId: 'org-1', // belongs to Acme Corp (currentOrgId)
            pendingPatches: 1,
            unapprovedMissing: 1,
            osMissing: 1,
          }),
          apiRow({
            id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
            hostname: 'Globex-Device',
            osType: 'macos',
            orgId: 'org-2', // belongs to Globex — different org
            pendingPatches: 1,
            unapprovedMissing: 1,
            osMissing: 1,
          }),
        ]));
      }

      return makeJsonResponse({}, false, 404);
    });

    render(<PatchComplianceView ringId={null} />);

    await screen.findByText('Acme-Device');
    await screen.findByText('Globex-Device');

    // Select both devices
    await settleLoadedRows();
    fireEvent.click(screen.getByRole('button', { name: 'Select Acme-Device' }));
    fireEvent.click(screen.getByRole('button', { name: 'Select Globex-Device' }));

    // Click Scan — should open confirm dialog
    fireEvent.click(screen.getByRole('button', { name: /^Scan$/i }));

    const confirmBtn = await screen.findByTestId('confirm-fleet-action');
    const dialogText = confirmBtn.closest('[role="dialog"]')?.textContent ?? document.body.textContent ?? '';

    // Must mention both orgs — "across 2 organizations (Acme Corp, Globex)"
    expect(dialogText).toMatch(/across \d+ organizations/i);
    expect(dialogText).toMatch(/Acme Corp/i);
    expect(dialogText).toMatch(/Globex/i);

    // Must NOT claim this is scoped to Acme Corp alone (which is what currentOrgId
    // would have incorrectly said before this fix)
    expect(dialogText).not.toMatch(/on \d+ device[s]? in Acme Corp/i);
  });

  it('mutes the pending-reboot badge with an "as of" qualifier for offline devices and explains the column semantics (#2219)', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (isComplianceList(url)) {
        const outstanding = { pendingPatches: 1, unapprovedMissing: 1, osMissing: 1, pendingReboot: true };
        return makeJsonResponse(compliancePayload([
          apiRow({
            id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', hostname: 'Online-Box', ...outstanding,
            status: 'online', lastSeenAt: '2026-04-01T18:00:00.000Z',
          }),
          apiRow({
            id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', hostname: 'Offline-Box', ...outstanding,
            status: 'offline', lastSeenAt: '2026-04-01T18:00:00.000Z',
          }),
          // Offline with no last-seen anywhere: badge must be muted but
          // must not render "as of Invalid Date" or a dangling "as of".
          apiRow({ id: 'cccccccc-cccc-cccc-cccc-cccccccccccc', hostname: 'Offline-NoLastSeen', ...outstanding, status: 'offline' }),
          // A row with no status: fail open to the unqualified live badge
          // (pre-#2219 behavior), never to stale.
          apiRow({ id: 'dddddddd-dddd-dddd-dddd-dddddddddddd', hostname: 'Legacy-NoStatus', ...outstanding, status: null }),
        ]));
      }
      return makeJsonResponse({}, false, 404);
    });

    render(<PatchComplianceView ringId={null} />);

    await screen.findByText('Online-Box');

    // Online device: unqualified orange "Yes" badge.
    const liveBadge = screen.getByTestId('compliance-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa-pending-reboot');
    expect(liveBadge.textContent).toBe('Yes');
    expect(liveBadge.className).toContain('text-orange-700');

    // Offline device: muted badge qualified with "as of <last seen>", not an
    // unqualified "Yes" — and not hidden outright.
    const staleBadge = screen.getByTestId('compliance-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb-pending-reboot-stale');
    expect(staleBadge.textContent).toMatch(/^Yes · as of /);
    expect(staleBadge.className).toContain('text-muted-foreground');
    expect(staleBadge.className).not.toContain('text-orange-700');
    expect(staleBadge).toHaveAttribute('title', expect.stringMatching(/offline.*last check-in.*stale/i));
    expect(
      screen.queryByTestId('compliance-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb-pending-reboot')
    ).toBeNull();

    // Offline with no last-seen anywhere: still muted, but a bare "Yes" —
    // no dangling "as of" and no "Invalid Date".
    const noLastSeenBadge = screen.getByTestId('compliance-cccccccc-cccc-cccc-cccc-cccccccccccc-pending-reboot-stale');
    expect(noLastSeenBadge.textContent).toBe('Yes');
    expect(noLastSeenBadge.className).toContain('text-muted-foreground');

    // Older API payload without a status field: fail open to the unqualified
    // live badge (pre-#2219 behavior) — never misclassified as stale.
    const legacyBadge = screen.getByTestId('compliance-dddddddd-dddd-dddd-dddd-dddddddddddd-pending-reboot');
    expect(legacyBadge.textContent).toBe('Yes');
    expect(legacyBadge.className).toContain('text-orange-700');
    expect(
      screen.queryByTestId('compliance-dddddddd-dddd-dddd-dddd-dddddddddddd-pending-reboot-stale')
    ).toBeNull();

    // Column header explains what REBOOT actually means (agent-reported OS
    // pending-reboot signal, any cause — not "reboot to install patches").
    const rebootHeader = screen.getByRole('columnheader', { name: 'Reboot' });
    expect(rebootHeader).toHaveAttribute(
      'title',
      expect.stringMatching(/OS reports a pending reboot.*reported by the agent/i)
    );
  });

  it('surfaces a distinct message when the install endpoint returns 409 approval failure', async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (isComplianceList(url)) {
        return makeJsonResponse(compliancePayload([
          apiRow({
            id: '11111111-1111-1111-1111-111111111111',
            hostname: 'Workstation-1',
            pendingPatches: 1,
            approvedMissing: 1,
            osMissing: 1,
            lastSeenAt: '2026-04-01T18:00:00.000Z',
          }),
        ]));
      }

      if (url === '/devices/11111111-1111-1111-1111-111111111111/patches' && !init) {
        return makeJsonResponse({
          data: {
            pending: [
              { id: '22222222-2222-2222-2222-222222222222', title: 'KB5050001', approvalStatus: 'approved' },
            ],
          },
        });
      }

      if (url === '/devices/11111111-1111-1111-1111-111111111111/patches/install') {
        return makeJsonResponse(
          {
            error: 'Only approved patches can be installed',
            unapprovedPatchIds: ['22222222-2222-2222-2222-222222222222'],
          },
          false,
          409
        );
      }

      return makeJsonResponse({}, false, 404);
    });

    render(<PatchComplianceView ringId={null} />);

    await screen.findByText('Workstation-1');

    await settleLoadedRows();
    fireEvent.click(screen.getByRole('button', { name: 'Select Workstation-1' }));
    fireEvent.click(screen.getByRole('button', { name: /Install \(1\)/i }));
    fireEvent.click(screen.getByTestId('confirm-fleet-action'));

    expect(await screen.findByText(/pending approval/i)).toBeTruthy();
    expect(screen.queryByText(/^Install failed/)).toBeNull();
  });
});

// #7214: failed installs were bucketed as "Pending approval" in this view.
describe('PatchComplianceView failed installs (#7214)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    orgState.currentOrgId = 'org-1';
  });

  it('shows a failed-install count, not a pending-approval count, for a failed install', async () => {
    fetchMock.mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (isComplianceList(url)) {
        return makeJsonResponse(compliancePayload([
          apiRow({ id: 'dev-1', hostname: 'Workstation-1', pendingPatches: 1, failedMissing: 1, osMissing: 1 }),
        ]));
      }
      return makeJsonResponse({});
    });

    render(<PatchComplianceView ringId={null} />);

    expect(await screen.findByText('1 failed install')).toBeTruthy();
    expect(screen.queryByText('1 pending approval')).toBeNull();
    expect(screen.getByRole('columnheader', { name: 'Failed' })).toBeTruthy();
    expect(screen.getByTestId('failed-installs-dev-1').textContent).toBe('1');
  });

});

describe('PatchComplianceView device names (#9533)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    orgState.currentOrgId = 'org-1';
  });

  // The rest of the app leads with the display name; the hostname stays
  // visible as secondary context.
  it('shows the display name with the hostname secondary, and searches both', async () => {
    const rows = [
      apiRow({ id: 'dev-1', hostname: 'DESKTOP-7Q2K', displayName: "Dana's laptop", pendingPatches: 1, approvedMissing: 1, osMissing: 1 }),
      apiRow({ id: 'dev-2', hostname: 'build-01', osType: 'linux', pendingPatches: 1, approvedMissing: 1, osMissing: 1 }),
    ];
    fetchMock.mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (isComplianceList(url)) {
        // Search is a server param (#9791 C): mirror the API's hostname /
        // display-name match so the assertion below exercises the round trip.
        const q = new URL(url, 'http://x').searchParams.get('search')?.toLowerCase() ?? '';
        const matching = rows.filter(
          (r) => !q || r.hostname.toLowerCase().includes(q) || (r.displayName ?? '').toLowerCase().includes(q),
        );
        return makeJsonResponse(compliancePayload(rows, {
          devices: matching,
          devicesPage: { status: 'all', search: q || null, limit: 50, offset: 0, total: matching.length },
        }));
      }
      return makeJsonResponse({});
    });

    render(<PatchComplianceView ringId={null} />);

    const link = await screen.findByRole('link', { name: /Dana's laptop/ });
    expect(link).toHaveAttribute('href', '/devices/dev-1');
    expect(screen.getByTestId('compliance-dev-1-hostname')).toHaveTextContent('DESKTOP-7Q2K');
    // No display name → hostname is the name, and is not repeated.
    expect(screen.getByRole('link', { name: /build-01/ })).toBeInTheDocument();
    expect(screen.queryByTestId('compliance-dev-2-hostname')).toBeNull();
    expect(screen.getByRole('button', { name: /Dana's laptop/ })).toBeInTheDocument(); // select checkbox label

    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: 'desktop-7q' } });
    await waitFor(() => expect(screen.queryByRole('link', { name: /build-01/ })).toBeNull());
    expect(screen.getByRole('link', { name: /Dana's laptop/ })).toBeInTheDocument();
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toContain('/patches/compliance?search=desktop-7q');
  });
});

// #9791 C: the list, the counts and the headline come from the API, the status
// filter lives in the hash, and the list pages server-side.
describe('PatchComplianceView server-side list (#9791 C)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    orgState.currentOrgId = 'org-1';
    window.history.replaceState({}, '', '/patches');
  });

  const complianceUrls = () => fetchMock.mock.calls.map((c) => String(c[0])).filter(isComplianceList);

  it('headline is the API devicePercent for a fleet larger than one page (old 200-device cap)', async () => {
    const page = Array.from({ length: 50 }, (_, i) =>
      apiRow({ id: `dev-${i}`, hostname: `host-${i}`, pendingPatches: 1, approvedMissing: 1, osMissing: 1 }),
    );
    fetchMock.mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (isComplianceList(url)) {
        return makeJsonResponse(compliancePayload(page, {
          totalDevices: 250,
          compliantDevices: 200,
          devicePercent: 80,
          deviceCounts: { all: 250, compliant: 200, needsPatches: 50, failed: 0, critical: 0, reboot: 0, thirdParty: 0 },
          devicesPage: { status: 'all', search: null, limit: 50, offset: 0, total: 250 },
        }));
      }
      // The old view also read /devices?limit=200 and computed the % from it.
      if (url === '/devices?limit=200') {
        return makeJsonResponse({ devices: page.map((r) => ({ id: r.id, hostname: r.hostname, osType: 'windows' })) });
      }
      return makeJsonResponse({}, false, 404);
    });

    render(<PatchComplianceView ringId={null} />);

    expect(await screen.findByText('80% compliant')).toBeInTheDocument();
    expect(screen.getByText('200 of 250 devices')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'All Devices (250)' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Compliant (200)' })).toBeInTheDocument();
    expect(screen.getByTestId('patch-compliance-pager')).toHaveTextContent('1–50 of 250');
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).not.toContain('/devices?limit=200');
  });

  it('#compliance&status=failed selects the failed filter and fetches only failed devices', async () => {
    window.history.replaceState({}, '', '/patches#compliance&status=failed');
    fetchMock.mockImplementation(async (input: unknown) =>
      isComplianceList(String(input))
        ? makeJsonResponse(compliancePayload([apiRow({ id: 'dev-1', hostname: 'Workstation-1', pendingPatches: 1, failedMissing: 1 })]))
        : makeJsonResponse({}, false, 404),
    );

    render(<PatchComplianceView ringId={null} />);

    const select = await screen.findByRole('combobox', { name: 'Compliance status filter' });
    await waitFor(() => expect(select).toHaveValue('failed'));
    expect(screen.getByRole('option', { name: 'Failed Installs (1)' })).toBeInTheDocument();
    await waitFor(() => expect(complianceUrls()).toContain('/patches/compliance?status=failed'));
  });

  it('changing the filter writes the hash, keeps other keys and refetches', async () => {
    window.history.replaceState({}, '', '/patches#compliance&foo=1');
    fetchMock.mockImplementation(async (input: unknown) =>
      isComplianceList(String(input)) ? makeJsonResponse(compliancePayload([])) : makeJsonResponse({}, false, 404),
    );
    render(<PatchComplianceView ringId={null} />);
    const select = await screen.findByRole('combobox', { name: 'Compliance status filter' });

    fireEvent.change(select, { target: { value: 'third-party' } });

    expect(window.location.hash).toBe('#compliance&foo=1&status=third-party');
    await waitFor(() => expect(complianceUrls()).toContain('/patches/compliance?status=third-party'));

    fireEvent.change(select, { target: { value: 'all' } });
    expect(window.location.hash).toBe('#compliance&foo=1');
  });

  it('an empty fleet shows the empty state, not 0% or 100% of nothing', async () => {
    fetchMock.mockImplementation(async (input: unknown) =>
      isComplianceList(String(input))
        ? makeJsonResponse(compliancePayload([], { compliancePercent: 100 }))
        : makeJsonResponse({}, false, 404),
    );
    render(<PatchComplianceView ringId={null} />);

    expect(await screen.findByText('No devices found.')).toBeInTheDocument();
    expect(screen.queryByTestId('patch-compliance-device-percent')).toBeNull();
    expect(screen.queryByText(/% compliant/)).toBeNull();
  });

  it('Next page asks the API for the next offset and clears the selection', async () => {
    const rowsAt = (offset: number) =>
      Array.from({ length: 2 }, (_, i) => apiRow({ id: `dev-${offset + i}`, hostname: `host-${offset + i}` }));
    fetchMock.mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (!isComplianceList(url)) return makeJsonResponse({}, false, 404);
      const offset = Number(new URL(url, 'http://x').searchParams.get('offset') ?? 0);
      return makeJsonResponse(compliancePayload(rowsAt(offset), {
        totalDevices: 4,
        compliantDevices: 4,
        devicePercent: 100,
        devicesPage: { status: 'all', search: null, limit: 2, offset, total: 4 },
      }));
    });
    render(<PatchComplianceView ringId={null} />);

    await screen.findByText('host-0');
    await settleLoadedRows();
    fireEvent.click(screen.getByRole('button', { name: 'Select host-0' }));
    expect(screen.getByText('1 selected')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));

    expect(await screen.findByText('host-2')).toBeInTheDocument();
    expect(complianceUrls()).toContain('/patches/compliance?offset=2');
    expect(screen.getByTestId('patch-compliance-pager')).toHaveTextContent('3–4 of 4');
    expect(screen.queryByText('1 selected')).toBeNull();
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();
  });

  it('a stale response never overwrites a newer one', async () => {
    window.history.replaceState({}, '', '/patches#status=critical');
    let releaseAll: (() => void) | undefined;
    fetchMock.mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (!isComplianceList(url)) return makeJsonResponse({}, false, 404);
      if (!url.includes('status=critical')) {
        // the default-state request resolves last
        await new Promise<void>((resolve) => { releaseAll = resolve; });
        return makeJsonResponse(compliancePayload([apiRow({ id: 'dev-all', hostname: 'from-all' })]));
      }
      return makeJsonResponse(compliancePayload([apiRow({ id: 'dev-crit', hostname: 'from-critical', pendingPatches: 1, criticalMissing: 1 })]));
    });
    render(<PatchComplianceView ringId={null} />);

    expect(await screen.findByText('from-critical')).toBeInTheDocument();
    await act(async () => { releaseAll?.(); });
    expect(screen.getByText('from-critical')).toBeInTheDocument();
    expect(screen.queryByText('from-all')).toBeNull();
  });

  it('select-all selects only the loaded page; a filter change clears it', async () => {
    fetchMock.mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (!isComplianceList(url)) return makeJsonResponse({}, false, 404);
      const rows = [apiRow({ id: 'dev-0', hostname: 'host-0' }), apiRow({ id: 'dev-1', hostname: 'host-1' })];
      return makeJsonResponse(compliancePayload(rows, {
        totalDevices: 4,
        compliantDevices: 4,
        devicePercent: 100,
        devicesPage: { status: 'all', search: null, limit: 2, offset: 0, total: 4 },
      }));
    });
    render(<PatchComplianceView ringId={null} />);
    await screen.findByText('host-0');

    await settleLoadedRows();
    fireEvent.click(screen.getByRole('button', { name: 'Select all' }));
    expect(screen.getByText('2 selected')).toBeInTheDocument();

    fireEvent.change(screen.getByRole('combobox', { name: 'Compliance status filter' }), { target: { value: 'reboot' } });
    await waitFor(() => expect(screen.queryByText('2 selected')).toBeNull());
  });

  it('a box ticked while the next page is in flight does not survive into it', async () => {
    let release: (() => void) | undefined;
    fetchMock.mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (!isComplianceList(url)) return makeJsonResponse({}, false, 404);
      const offset = Number(new URL(url, 'http://x').searchParams.get('offset') ?? 0);
      if (offset > 0) await new Promise<void>((resolve) => { release = resolve; });
      const rows = [apiRow({ id: `dev-${offset}`, hostname: `host-${offset}` }), apiRow({ id: `dev-${offset + 1}`, hostname: `host-${offset + 1}` })];
      return makeJsonResponse(compliancePayload(rows, {
        totalDevices: 4, compliantDevices: 4, devicePercent: 100,
        devicesPage: { status: 'all', search: null, limit: 2, offset, total: 4 },
      }));
    });
    render(<PatchComplianceView ringId={null} />);
    await screen.findByText('host-0');

    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    // old rows are still on screen while page 2 loads
    await settleLoadedRows();
    fireEvent.click(screen.getByRole('button', { name: 'Select host-0' }));
    await act(async () => { release?.(); });

    expect(await screen.findByText('host-2')).toBeInTheDocument();
    expect(screen.queryByText('1 selected')).toBeNull();
  });

  it('a page past the end snaps back to the last page with rows', async () => {
    let total = 4;
    fetchMock.mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (!isComplianceList(url)) return makeJsonResponse({}, false, 404);
      const offset = Number(new URL(url, 'http://x').searchParams.get('offset') ?? 0);
      const all = Array.from({ length: total }, (_, i) => apiRow({ id: `dev-${i}`, hostname: `host-${i}` }));
      return makeJsonResponse(compliancePayload(all.slice(offset, offset + 2), {
        totalDevices: total, compliantDevices: total, devicePercent: 100,
        devicesPage: { status: 'all', search: null, limit: 2, offset, total },
      }));
    });
    render(<PatchComplianceView ringId={null} />);
    await screen.findByText('host-0');
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(await screen.findByText('host-3')).toBeInTheDocument();

    // the fleet shrinks to 2 (e.g. after a bulk action) and the view refetches page 2
    total = 2;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh compliance data' }));

    expect(await screen.findByText('host-0')).toBeInTheDocument();
    expect(screen.getByTestId('patch-compliance-pager')).toHaveTextContent('1–2 of 2');
    const urls = fetchMock.mock.calls.map((c) => String(c[0])).filter(isComplianceList);
    expect(urls[urls.length - 1]).toBe('/patches/compliance');
  });

  it('an API response without the device list is a load failure, not an empty table', async () => {
    fetchMock.mockImplementation(async (input: unknown) =>
      isComplianceList(String(input))
        ? makeJsonResponse({ data: { totalDevices: 3, compliantDevices: 1, devicesNeedingPatches: [] } })
        : makeJsonResponse({}, false, 404),
    );
    render(<PatchComplianceView ringId={null} />);
    expect(await screen.findByText('Failed to fetch patch data')).toBeInTheDocument();
    expect(screen.queryByText(/% compliant/)).toBeNull();
  });

  it('a non-JSON body shows the localized error, never the parser message', async () => {
    fetchMock.mockImplementation(async (input: unknown) =>
      isComplianceList(String(input))
        ? ({ ok: true, status: 200, statusText: 'OK', json: vi.fn().mockRejectedValue(new SyntaxError("Unexpected token '<'")) } as unknown as Response)
        : makeJsonResponse({}, false, 404),
    );
    render(<PatchComplianceView ringId={null} />);
    expect(await screen.findByText('Failed to fetch patch data')).toBeInTheDocument();
    expect(screen.queryByText(/Unexpected token/)).toBeNull();
  });

  it('derives the headline from the counts when devicePercent is absent', async () => {
    fetchMock.mockImplementation(async (input: unknown) => {
      if (!isComplianceList(String(input))) return makeJsonResponse({}, false, 404);
      const payload = compliancePayload([
        apiRow({ id: 'dev-0', hostname: 'host-0' }),
        apiRow({ id: 'dev-1', hostname: 'host-1', pendingPatches: 1 }),
        apiRow({ id: 'dev-2', hostname: 'host-2', pendingPatches: 1 }),
      ]);
      delete (payload.data as Record<string, unknown>).devicePercent;
      return makeJsonResponse(payload);
    });
    render(<PatchComplianceView ringId={null} />);
    expect(await screen.findByText('33% compliant')).toBeInTheDocument();
  });
});
