import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock showToast so runAction (used by handleExport) writes to the spy.
const showToast = vi.fn();
vi.mock('../../components/shared/Toast', () => ({ showToast: (a: unknown) => showToast(a) }));

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

  it('resolves approved pending patch ids before queuing bulk install', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/patches/compliance') {
        return makeJsonResponse({
          data: {
            summary: { total: 3, pending: 2, installed: 1, failed: 0, missing: 0 },
            compliancePercent: 50,
            totalDevices: 1,
            compliantDevices: 0,
            criticalSummary: { total: 1, patched: 0, pending: 1 },
            importantSummary: { total: 1, patched: 0, pending: 1 },
            devicesNeedingPatches: [
              {
                id: '11111111-1111-1111-1111-111111111111',
                name: 'Workstation-1',
                os: 'windows',
                missingCount: 2,
                approvedMissing: 2,
                unapprovedMissing: 0,
                criticalCount: 1,
                importantCount: 1,
                osMissing: 2,
                thirdPartyMissing: 0,
                pendingReboot: false,
                lastSeen: '2026-04-01T18:00:00.000Z',
              },
            ],
          },
        });
      }

      if (url === '/devices?limit=200') {
        return makeJsonResponse({
          devices: [
            {
              id: '11111111-1111-1111-1111-111111111111',
              hostname: 'Workstation-1',
              osType: 'windows',
              lastSeenAt: '2026-04-01T18:00:00.000Z',
            },
          ],
        });
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
      if (url === '/patches/compliance') {
        return makeJsonResponse({
          data: {
            totalDevices: 1,
            compliantDevices: 0,
            devicesNeedingPatches: [
              {
                id: '11111111-1111-1111-1111-111111111111',
                name: 'Workstation-1',
                os: 'windows',
                missingCount: 2,
                approvedMissing: 1,
                unapprovedMissing: 1,
                criticalCount: 0,
                importantCount: 0,
                osMissing: 2,
                thirdPartyMissing: 0,
                pendingReboot: false,
                lastSeen: '2026-04-01T18:00:00.000Z',
              },
            ],
          },
        });
      }

      if (url === '/devices?limit=200') {
        return makeJsonResponse({
          devices: [
            {
              id: '11111111-1111-1111-1111-111111111111',
              hostname: 'Workstation-1',
              osType: 'windows',
              lastSeenAt: '2026-04-01T18:00:00.000Z',
            },
          ],
        });
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
      if (url === '/patches/compliance') {
        return makeJsonResponse({
          data: {
            totalDevices: 2,
            compliantDevices: 0,
            devicesNeedingPatches: [
              {
                id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
                name: 'Acme-Device',
                os: 'windows',
                missingCount: 1,
                approvedMissing: 0,
                unapprovedMissing: 1,
                criticalCount: 0,
                importantCount: 0,
                osMissing: 1,
                thirdPartyMissing: 0,
                pendingReboot: false,
              },
              {
                id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
                name: 'Globex-Device',
                os: 'macos',
                missingCount: 1,
                approvedMissing: 0,
                unapprovedMissing: 1,
                criticalCount: 0,
                importantCount: 0,
                osMissing: 1,
                thirdPartyMissing: 0,
                pendingReboot: false,
              },
            ],
          },
        });
      }

      if (url === '/devices?limit=200') {
        return makeJsonResponse({
          devices: [
            {
              id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
              hostname: 'Acme-Device',
              osType: 'windows',
              orgId: 'org-1', // belongs to Acme Corp (currentOrgId)
            },
            {
              id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
              hostname: 'Globex-Device',
              osType: 'macos',
              orgId: 'org-2', // belongs to Globex — different org
            },
          ],
        });
      }

      return makeJsonResponse({}, false, 404);
    });

    render(<PatchComplianceView ringId={null} />);

    await screen.findByText('Acme-Device');
    await screen.findByText('Globex-Device');

    // Select both devices
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

  it('surfaces a distinct message when the install endpoint returns 409 approval failure', async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/patches/compliance') {
        return makeJsonResponse({
          data: {
            totalDevices: 1,
            compliantDevices: 0,
            devicesNeedingPatches: [
              {
                id: '11111111-1111-1111-1111-111111111111',
                name: 'Workstation-1',
                os: 'windows',
                missingCount: 1,
                approvedMissing: 1,
                unapprovedMissing: 0,
                criticalCount: 0,
                importantCount: 0,
                osMissing: 1,
                thirdPartyMissing: 0,
                pendingReboot: false,
                lastSeen: '2026-04-01T18:00:00.000Z',
              },
            ],
          },
        });
      }

      if (url === '/devices?limit=200') {
        return makeJsonResponse({
          devices: [
            {
              id: '11111111-1111-1111-1111-111111111111',
              hostname: 'Workstation-1',
              osType: 'windows',
              lastSeenAt: '2026-04-01T18:00:00.000Z',
            },
          ],
        });
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

    fireEvent.click(screen.getByRole('button', { name: 'Select Workstation-1' }));
    fireEvent.click(screen.getByRole('button', { name: /Install \(1\)/i }));
    fireEvent.click(screen.getByTestId('confirm-fleet-action'));

    expect(await screen.findByText(/pending approval/i)).toBeTruthy();
    expect(screen.queryByText(/^Install failed/)).toBeNull();
  });
});
