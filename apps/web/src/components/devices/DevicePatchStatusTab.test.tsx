import '@/lib/i18n';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DevicePatchStatusTab from './DevicePatchStatusTab';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn()
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload)
  }) as unknown as Response;

const deviceId = '11111111-1111-1111-1111-111111111111';

describe('DevicePatchStatusTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders Windows-specific patch sections for Windows devices', async () => {
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse({
        data: {
          compliancePercent: 80,
          pending: [
            {
              id: 'p-1',
              title: '2026-01 Cumulative Update for Windows 11 (KB5050001)',
              source: 'microsoft',
              category: 'security',
              status: 'pending',
              severity: 'important',
              releaseDate: '2026-02-01',
              requiresReboot: true
            },
            {
              id: 'p-2',
              title: 'Google Chrome',
              source: 'third_party',
              category: 'application',
              status: 'pending',
              severity: 'low',
              releaseDate: '2026-01-30'
            }
          ],
          installed: [
            {
              id: 'i-1',
              title: 'Security Intelligence Update for Microsoft Defender',
              source: 'microsoft',
              category: 'definitions',
              status: 'installed',
              installedAt: '2026-02-01T08:30:00.000Z'
            },
            {
              id: 'i-2',
              title: 'Zoom',
              source: 'third_party',
              category: 'application',
              status: 'installed',
              installedAt: '2026-02-02T11:00:00.000Z'
            }
          ]
        }
      })
    );

    render(<DevicePatchStatusTab deviceId={deviceId} osType="windows" />);

    await screen.findByText('Pending Windows Updates');
    expect(screen.queryByText('Installed Windows Updates')).not.toBeNull();
    expect(screen.queryByText('Pending Third-Party Updates')).not.toBeNull();
    expect(screen.queryByText('Important')).not.toBeNull();
    expect(screen.queryByText('KB5050001')).not.toBeNull();
    expect(screen.queryByText('Reboot required')).not.toBeNull();
    expect(screen.queryAllByText(/Released/i).length).toBeGreaterThan(0);
    expect(screen.queryByText('Pending Apple Updates')).toBeNull();
    expect(fetchWithAuthMock).toHaveBeenCalledWith(`/devices/${deviceId}/patches`);
  });

  it('keeps Apple-specific patch sections for macOS devices', async () => {
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse({
        data: {
          compliancePercent: 100,
          pending: [
            {
              id: 'm-1',
              title: 'macOS Sonoma 14.7.1',
              source: 'apple',
              category: 'system',
              status: 'pending'
            }
          ],
          installed: [
            {
              id: 'm-2',
              title: 'XProtectPlistConfigData',
              source: 'apple',
              category: 'security',
              status: 'installed',
              installedAt: '2026-02-01T06:00:00.000Z'
            }
          ]
        }
      })
    );

    render(<DevicePatchStatusTab deviceId={deviceId} osType="macos" />);

    await screen.findByText('Pending Apple Updates');
    expect(screen.queryByText('Installed Apple Updates')).not.toBeNull();
    expect(screen.queryByText('Pending Windows Updates')).toBeNull();
  });

  it('queues OS scan with source for a Windows device', async () => {
    fetchWithAuthMock
      .mockResolvedValueOnce(
        makeJsonResponse({
          data: {
            compliancePercent: 70,
            pending: [],
            installed: []
          }
        })
      )
      // PatchInstallHistory child may also fetch; provide default responses
      .mockResolvedValue(
        makeJsonResponse({
          queuedCommandIds: ['cmd-1'],
          jobId: 'scan-123'
        })
      );

    render(<DevicePatchStatusTab deviceId={deviceId} osType="windows" />);

    const button = await screen.findByRole('button', { name: 'Run OS patch scan' });
    fireEvent.click(button);

    await waitFor(() => {
      expect(fetchWithAuthMock).toHaveBeenCalledWith(
        '/patches/scan',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            deviceIds: [deviceId],
            source: 'microsoft'
          })
        })
      );
    });

    await screen.findByText(/Run Windows patch scan queued/i);
  });

  it('queues install for pending third-party patches', async () => {
    const patchData = {
      data: {
        compliancePercent: 10,
        pending: [
          {
            id: 'f0cfbd5f-6f8d-4682-9f52-bc37f8d6edbf',
            title: 'Google Chrome',
            externalId: 'third_party:Google Chrome:122.0.6261.57',
            description: 'installed: 121.0.6167.184',
            source: 'third_party',
            category: 'application',
            status: 'pending'
          }
        ],
        installed: []
      }
    };

    // Route responses by URL to avoid PatchInstallHistory and polling
    // consuming mock slots meant for the install action
    fetchWithAuthMock.mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.includes('/patches/install')) {
        return makeJsonResponse({ success: true, commandId: 'cmd-install-1', patchCount: 1 });
      }
      // Patch data endpoint and any other fetches
      return makeJsonResponse(patchData);
    });

    render(<DevicePatchStatusTab deviceId={deviceId} osType="macos" />);

    await screen.findByText('Installed 121.0.6167.184 -> 122.0.6261.57');
    await screen.findByText('Homebrew');

    const installButton = await screen.findByRole('button', { name: /Install 3rd-party patches \(1\)/i });
    fireEvent.click(installButton);

    // Destructive batch install now requires confirmation before firing.
    fireEvent.click(await screen.findByTestId('confirm-install-patches'));

    await waitFor(() => {
      expect(fetchWithAuthMock).toHaveBeenCalledWith(
        `/devices/${deviceId}/patches/install`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            patchIds: ['f0cfbd5f-6f8d-4682-9f52-bc37f8d6edbf']
          })
        })
      );
    });

    // After install succeeds, startInstallPolling immediately replaces the
    // success notice with a polling info message.
    await screen.findByText(/Installing patches/i);
  });

  it('disables install controls when there are no pending patches', async () => {
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse({
        data: {
          compliancePercent: 100,
          pending: [],
          installed: []
        }
      })
    );

    render(<DevicePatchStatusTab deviceId={deviceId} osType="linux" />);

    const installOsButton = await screen.findByRole('button', { name: /Install pending OS patches \(0\)/i });
    const installThirdPartyButton = await screen.findByRole('button', { name: /Install 3rd-party patches \(0\)/i });

    expect((installOsButton as HTMLButtonElement).disabled).toBe(true);
    expect((installThirdPartyButton as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows Linux pending updates and recent install history without showing installed package inventory', async () => {
    fetchWithAuthMock.mockImplementation(async (url: string) => {
      if (url.includes('/patches/history?') && url.includes('type=install')) {
        return makeJsonResponse({
          history: [
            {
              type: 'install_patches',
              status: 'completed',
              completedAt: '2026-06-21T22:47:00.000Z',
              result: {
                results: [
                  {
                    id: 'installed-1',
                    title: 'bash',
                    source: 'linux',
                    externalId: 'apt:bash@5.1-6ubuntu1.1',
                    packageId: 'apt:bash',
                    installId: 'apt:bash',
                    status: 'installed',
                  },
                ],
              },
            },
            {
              type: 'software_update',
              status: 'completed',
              completedAt: '2026-06-20T18:30:00.000Z',
              result: {
                results: [
                  {
                    id: 'installed-2',
                    title: 'netbird',
                    source: 'linux',
                    externalId: 'netbird',
                    installId: 'netbird',
                    status: 'installed',
                  },
                ],
              },
            },
          ],
        });
      }
      if (url.includes('/patches/history')) {
        return makeJsonResponse({ history: [], total: 0 });
      }
      return makeJsonResponse({
        data: {
          compliancePercent: 100,
          pending: [
            {
              id: 'pending-1',
              title: 'openssl',
              source: 'linux',
              externalId: 'apt:openssl@3.0.2-0ubuntu1.20',
              packageId: 'apt:openssl',
              category: 'system',
              status: 'pending',
            },
          ],
          installed: [
            {
              id: 'pkg-1',
              title: 'zlib1g',
              source: 'linux',
              externalId: 'apt:zlib1g',
              packageId: 'apt:zlib1g',
              category: 'system',
              status: 'installed',
            },
          ],
        },
      });
    });

    render(<DevicePatchStatusTab deviceId={deviceId} osType="linux" />);

    await screen.findByText('Pending Linux Updates');
    await screen.findByText('openssl');
    await screen.findByText('Recently Installed Linux Updates');
    await screen.findByText('bash');
    await screen.findByText('netbird');
    expect(screen.queryByText('Installed Linux Updates')).toBeNull();
    expect(screen.queryByText('zlib1g')).toBeNull();
    expect(screen.queryByText('0% compliant')).not.toBeNull();
    const historyUrl = fetchWithAuthMock.mock.calls
      .map(([url]) => String(url))
      .find((url) => url.includes('/patches/history?') && url.includes('type=install'));
    expect(historyUrl).toBeTruthy();
    const historyParams = new URL(`https://test.local${historyUrl}`).searchParams;
    expect(historyParams.get('limit')).toBe('100');
    expect(historyParams.get('completedAfter')).toBeTruthy();
  });

  it('refreshes recent Linux install history when patch data is refreshed', async () => {
    let recentHistoryCalls = 0;
    fetchWithAuthMock.mockImplementation(async (url: string) => {
      if (url.includes('/patches/history?') && url.includes('type=install')) {
        recentHistoryCalls += 1;
        return makeJsonResponse({
          history: recentHistoryCalls >= 2
            ? [
                {
                  type: 'software_update',
                  status: 'completed',
                  completedAt: '2026-06-22T02:46:00.000Z',
                  result: {
                    results: [
                      {
                        id: 'netbird',
                        title: 'netbird',
                        name: 'netbird',
                        source: 'linux',
                        externalId: 'netbird',
                        installId: 'netbird',
                        status: 'installed',
                      },
                    ],
                  },
                },
              ]
            : [],
        });
      }
      if (url.includes('/patches/history')) {
        return makeJsonResponse({ history: [], total: 0 });
      }
      return makeJsonResponse({
        data: {
          compliancePercent: 100,
          pending: [],
          installed: [],
        },
      });
    });

    render(<DevicePatchStatusTab deviceId={deviceId} osType="linux" />);

    await screen.findByText('No recent Linux update installs.');
    fireEvent.click(await screen.findByRole('button', { name: /Refresh patch data/i }));

    await screen.findByText('netbird');
    expect(recentHistoryCalls).toBeGreaterThanOrEqual(2);
  });

  it('excludes missing records from pending install counts', async () => {
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse({
        data: {
          compliancePercent: 100,
          lastPatchScanAt: '2026-06-22T06:15:00.000Z',
          lastPatchScanStatus: 'completed',
          pending: [],
          missing: [
            {
              id: '34d7275b-055d-4ca2-8f42-04c61f8513d1',
              title: 'Old package record',
              source: 'third_party',
              category: 'application',
              status: 'missing'
            }
          ],
          installed: [],
          patches: [
            {
              id: '34d7275b-055d-4ca2-8f42-04c61f8513d1',
              title: 'Old package record',
              source: 'third_party',
              category: 'application',
              status: 'missing'
            }
          ]
        }
      })
    );

    render(<DevicePatchStatusTab deviceId={deviceId} osType="macos" />);

    const installOsButton = await screen.findByRole('button', { name: /Install pending OS patches \(0\)/i });
    const installThirdPartyButton = await screen.findByRole('button', { name: /Install 3rd-party patches \(0\)/i });

    expect((installOsButton as HTMLButtonElement).disabled).toBe(true);
    expect((installThirdPartyButton as HTMLButtonElement).disabled).toBe(true);
    await screen.findByText((_content, node) =>
      node?.textContent?.startsWith('Last scan:') === true &&
      node.textContent.includes('Completed')
    );
    expect(screen.queryByText(/updates? from earlier scans/i)).not.toBeInTheDocument();
  });

  it('sends only approved pending OS patch ids to the install endpoint', async () => {
    const patchData = {
      data: {
        compliancePercent: 10,
        pending: [
          {
            id: 'approved-1',
            title: '2026-01 Cumulative Update (KB5050001)',
            source: 'microsoft',
            category: 'security',
            status: 'pending',
            approvalStatus: 'approved'
          },
          {
            id: 'pending-1',
            title: '2026-01 Feature Update (KB5050099)',
            source: 'microsoft',
            category: 'security',
            status: 'pending',
            approvalStatus: 'pending'
          },
          {
            id: 'pending-third-party-1',
            title: 'Google Chrome',
            source: 'third_party',
            category: 'application',
            status: 'pending',
            approvalStatus: 'pending'
          }
        ],
        installed: []
      }
    };

    fetchWithAuthMock.mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.includes('/patches/install')) {
        return makeJsonResponse({ success: true, commandId: 'cmd-install-1', patchCount: 1 });
      }
      return makeJsonResponse(patchData);
    });

    render(<DevicePatchStatusTab deviceId={deviceId} osType="windows" />);

    // Button count reflects only the approved patch, and surfaces the pending one.
    const installButton = await screen.findByRole('button', { name: /Install pending OS patches \(1\)/i });
    expect(installButton.textContent).toMatch(/1 pending approval/i);
    expect(screen.getByText('Approved')).toBeTruthy();
    expect(screen.getAllByText('Pending Approval')).toHaveLength(2);

    const approvedRowInstall = screen.getByLabelText('Install 2026-01 Cumulative Update (KB5050001)');
    expect((approvedRowInstall as HTMLButtonElement).disabled).toBe(false);
    const unapprovedOsTitle = 'This org has not approved 2026-01 Feature Update (KB5050099). Approve the patch before installing.';
    expect(screen.getByTitle(unapprovedOsTitle)).toBeTruthy();
    const unapprovedOsRowInstall = screen.getByLabelText(unapprovedOsTitle);
    expect((unapprovedOsRowInstall as HTMLButtonElement).disabled).toBe(true);
    const unapprovedThirdPartyTitle = 'This org has not approved Google Chrome. Approve the patch before installing.';
    expect(screen.getByTitle(unapprovedThirdPartyTitle)).toBeTruthy();
    const unapprovedThirdPartyInstall = screen.getByLabelText(unapprovedThirdPartyTitle);
    expect((unapprovedThirdPartyInstall as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(installButton);
    fireEvent.click(await screen.findByTestId('confirm-install-patches'));

    await waitFor(() => {
      expect(fetchWithAuthMock).toHaveBeenCalledWith(
        `/devices/${deviceId}/patches/install`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ patchIds: ['approved-1'] })
        })
      );
    });
  });

  it('excludes user-scope pending patches from the bulk install request body', async () => {
    const patchData = {
      data: {
        compliancePercent: 10,
        pending: [
          {
            id: 'machine-scope-1',
            title: '2026-01 Cumulative Update (KB5050001)',
            source: 'microsoft',
            category: 'security',
            status: 'pending',
            approvalStatus: 'approved',
            scope: 'machine'
          },
          {
            id: 'user-scope-1',
            title: 'Google Chrome',
            source: 'microsoft',
            category: 'security',
            status: 'pending',
            approvalStatus: 'approved',
            scope: 'user'
          },
          {
            id: 'scopeless-1',
            title: '2026-01 Feature Update (KB5050099)',
            source: 'microsoft',
            category: 'security',
            status: 'pending',
            approvalStatus: 'approved'
          }
        ],
        installed: []
      }
    };

    fetchWithAuthMock.mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.includes('/patches/install')) {
        return makeJsonResponse({ success: true, commandId: 'cmd-install-1', patchCount: 2 });
      }
      return makeJsonResponse(patchData);
    });

    render(<DevicePatchStatusTab deviceId={deviceId} osType="windows" />);

    // The bulk-install count reflects only the two installable (approved,
    // non-user-scope) patches.
    const installButton = await screen.findByRole('button', { name: /Install pending OS patches \(2\)/i });
    fireEvent.click(installButton);
    fireEvent.click(await screen.findByTestId('confirm-install-patches'));

    await waitFor(() => {
      expect(fetchWithAuthMock).toHaveBeenCalledWith(
        `/devices/${deviceId}/patches/install`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ patchIds: ['machine-scope-1', 'scopeless-1'] })
        })
      );
    });

    const calledBody = fetchWithAuthMock.mock.calls.find(([url]) =>
      typeof url === 'string' && url.includes('/patches/install')
    )?.[1]?.body as string;
    expect(calledBody).toBeTruthy();
    expect(JSON.parse(calledBody).patchIds).not.toContain('user-scope-1');
  });

  it('disables the per-row install button for a user-scope patch but not a machine-scope patch', async () => {
    const patchData = {
      data: {
        compliancePercent: 10,
        pending: [
          {
            id: 'machine-scope-1',
            title: '2026-01 Cumulative Update (KB5050001)',
            source: 'microsoft',
            category: 'security',
            status: 'pending',
            approvalStatus: 'approved',
            scope: 'machine'
          },
          {
            id: 'user-scope-1',
            title: 'Zoom',
            source: 'microsoft',
            category: 'security',
            status: 'pending',
            approvalStatus: 'approved',
            scope: 'user'
          }
        ],
        installed: []
      }
    };

    fetchWithAuthMock.mockImplementation(async () => makeJsonResponse(patchData));

    render(<DevicePatchStatusTab deviceId={deviceId} osType="windows" />);

    await screen.findByText('2026-01 Cumulative Update (KB5050001)');

    const machineScopeButton = screen.getByLabelText('Install 2026-01 Cumulative Update (KB5050001)');
    expect((machineScopeButton as HTMLButtonElement).disabled).toBe(false);

    const userScopeTitle = "Zoom is installed in the logged-in user's profile. Per-user apps cannot be patched from the system context yet.";
    const userScopeButton = screen.getByLabelText(userScopeTitle);
    expect((userScopeButton as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the Per-user badge only for the user-scope pending row', async () => {
    const patchData = {
      data: {
        compliancePercent: 10,
        pending: [
          {
            id: 'machine-scope-1',
            title: '2026-01 Cumulative Update (KB5050001)',
            source: 'microsoft',
            category: 'security',
            status: 'pending',
            approvalStatus: 'approved',
            scope: 'machine'
          },
          {
            id: 'user-scope-1',
            title: 'Slack',
            source: 'microsoft',
            category: 'security',
            status: 'pending',
            approvalStatus: 'approved',
            scope: 'user'
          }
        ],
        installed: []
      }
    };

    fetchWithAuthMock.mockImplementation(async () => makeJsonResponse(patchData));

    render(<DevicePatchStatusTab deviceId={deviceId} osType="windows" />);

    await screen.findByText('Slack');
    expect(screen.getAllByText('Per-user')).toHaveLength(1);

    const machineScopeRow = screen.getByText('2026-01 Cumulative Update (KB5050001)').closest('tr');
    expect(machineScopeRow).not.toBeNull();
    expect(machineScopeRow && Array.from(machineScopeRow.querySelectorAll('span')).some(el => el.textContent === 'Per-user')).toBe(false);
  });

  it('shows the per-user-apps-not-scanned note only when lastPatchScanUserScopeScanned is explicitly false', async () => {
    const buildPatchData = (lastPatchScanUserScopeScanned?: boolean) => ({
      data: {
        compliancePercent: 100,
        ...(lastPatchScanUserScopeScanned === undefined ? {} : { lastPatchScanUserScopeScanned }),
        pending: [],
        installed: []
      }
    });

    const noteText = /Per-user apps were not scanned/i;

    // Case 1: explicitly false -- note renders.
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse(buildPatchData(false)));
    const { unmount: unmountFalse } = render(<DevicePatchStatusTab deviceId={deviceId} osType="windows" />);
    await screen.findByText('Pending Windows Updates');
    expect(screen.queryByText(noteText)).not.toBeNull();
    unmountFalse();

    // Case 2: explicitly true -- note does not render.
    vi.clearAllMocks();
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse(buildPatchData(true)));
    const { unmount: unmountTrue } = render(<DevicePatchStatusTab deviceId={deviceId} osType="windows" />);
    await screen.findByText('Pending Windows Updates');
    expect(screen.queryByText(noteText)).toBeNull();
    unmountTrue();

    // Case 3: field absent -- note does not render (absent must not be treated as false).
    vi.clearAllMocks();
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse(buildPatchData(undefined)));
    render(<DevicePatchStatusTab deviceId={deviceId} osType="windows" />);
    await screen.findByText('Pending Windows Updates');
    expect(screen.queryByText(noteText)).toBeNull();
  });

  it('surfaces unapproved patch count when install returns 409', async () => {
    const patchData = {
      data: {
        compliancePercent: 10,
        pending: [
          {
            id: 'approved-1',
            title: '2026-01 Cumulative Update (KB5050001)',
            source: 'microsoft',
            category: 'security',
            status: 'pending',
            approvalStatus: 'approved'
          }
        ],
        installed: []
      }
    };

    fetchWithAuthMock.mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.includes('/patches/install')) {
        return makeJsonResponse(
          {
            error: 'Only approved patches can be installed',
            unapprovedPatchIds: ['approved-1']
          },
          false,
          409
        );
      }
      return makeJsonResponse(patchData);
    });

    render(<DevicePatchStatusTab deviceId={deviceId} osType="windows" />);

    const installButton = await screen.findByRole('button', { name: /Install pending OS patches \(1\)/i });
    fireEvent.click(installButton);
    fireEvent.click(await screen.findByTestId('confirm-install-patches'));

    await screen.findByText(/pending approval/i);
  });

  it('links to the fleet Patches page and the device\'s assigned patch policy (#4671)', async () => {
    fetchWithAuthMock.mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.includes('/configuration-policies/effective/')) {
        return makeJsonResponse({
          deviceId,
          features: {
            patch: {
              featureType: 'patch',
              featurePolicyId: 'feature-policy-1',
              inlineSettings: null,
              sourceLevel: 'organization',
              sourceTargetId: 'org-1',
              sourcePolicyId: 'policy-abc',
              sourcePolicyName: 'Standard Patch Ring',
              sourcePriority: 1
            }
          },
          inheritanceChain: []
        });
      }
      return makeJsonResponse({
        data: {
          compliancePercent: 90,
          pending: [],
          installed: []
        }
      });
    });

    render(<DevicePatchStatusTab deviceId={deviceId} osType="windows" />);

    const manageLink = await screen.findByRole('link', { name: /manage patches/i });
    expect(manageLink.getAttribute('href')).toBe('/patches');

    const policyLink = await screen.findByRole('link', { name: 'Standard Patch Ring' });
    expect(policyLink.getAttribute('href')).toBe('/configuration-policies/policy-abc');

    expect(fetchWithAuthMock).toHaveBeenCalledWith(`/configuration-policies/effective/${deviceId}`);
  });

  it('falls back to the policy id as the link label when sourcePolicyName is missing (#4671)', async () => {
    fetchWithAuthMock.mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.includes('/configuration-policies/effective/')) {
        return makeJsonResponse({
          deviceId,
          features: {
            patch: {
              featureType: 'patch',
              featurePolicyId: 'feature-policy-1',
              inlineSettings: null,
              sourceLevel: 'organization',
              sourceTargetId: 'org-1',
              sourcePolicyId: 'policy-xyz'
              // sourcePolicyName intentionally omitted
            }
          },
          inheritanceChain: []
        });
      }
      return makeJsonResponse({
        data: { compliancePercent: 90, pending: [], installed: [] }
      });
    });

    render(<DevicePatchStatusTab deviceId={deviceId} osType="windows" />);

    const policyLink = await screen.findByRole('link', { name: 'policy-xyz' });
    expect(policyLink.getAttribute('href')).toBe('/configuration-policies/policy-xyz');
  });

  it('degrades to no policy link (without crashing) when the effective-config fetch fails (#4671)', async () => {
    fetchWithAuthMock.mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.includes('/configuration-policies/effective/')) {
        throw new Error('network error');
      }
      return makeJsonResponse({
        data: { compliancePercent: 90, pending: [], installed: [] }
      });
    });

    render(<DevicePatchStatusTab deviceId={deviceId} osType="windows" />);

    // The rest of the tab still renders normally.
    await screen.findByRole('link', { name: /manage patches/i });
    expect(screen.queryByText(/managed by policy/i)).toBeNull();
  });

  it('clears a previously-resolved policy link when the effective-config fetch returns a non-OK response (#4671)', async () => {
    let effectiveCallCount = 0;
    fetchWithAuthMock.mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.includes('/configuration-policies/effective/')) {
        effectiveCallCount += 1;
        if (effectiveCallCount === 1) {
          return makeJsonResponse({
            deviceId,
            features: {
              patch: {
                featureType: 'patch',
                featurePolicyId: 'feature-policy-1',
                inlineSettings: null,
                sourceLevel: 'organization',
                sourceTargetId: 'org-1',
                sourcePolicyId: 'policy-abc',
                sourcePolicyName: 'Standard Patch Ring'
              }
            },
            inheritanceChain: []
          });
        }
        return makeJsonResponse({ error: 'server error' }, false, 500);
      }
      return makeJsonResponse({
        data: { compliancePercent: 90, pending: [], installed: [] }
      });
    });

    const { rerender } = render(<DevicePatchStatusTab deviceId={deviceId} osType="windows" />);

    await screen.findByRole('link', { name: 'Standard Patch Ring' });

    // Re-render with a different device id to trigger a re-fetch that now 500s.
    rerender(<DevicePatchStatusTab deviceId="22222222-2222-2222-2222-222222222222" osType="windows" />);

    await waitFor(() => {
      expect(screen.queryByText(/managed by policy/i)).toBeNull();
    });
  });

  it('does not show a policy link when no patch policy is assigned to the device (#4671)', async () => {
    fetchWithAuthMock.mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.includes('/configuration-policies/effective/')) {
        return makeJsonResponse({
          deviceId,
          features: {},
          inheritanceChain: []
        });
      }
      return makeJsonResponse({
        data: {
          compliancePercent: 90,
          pending: [],
          installed: []
        }
      });
    });

    render(<DevicePatchStatusTab deviceId={deviceId} osType="windows" />);

    await screen.findByRole('link', { name: /manage patches/i });
    expect(screen.queryByText(/managed by policy/i)).toBeNull();
  });

  it('renders "Installed (date unknown)" when an installed patch has null installedAt (#3589)', async () => {
    const patchData = {
      data: {
        compliancePercent: 100,
        pending: [],
        installed: [
          {
            id: 'inst-null-date',
            title: 'Cumulative Update for Windows 11 (KB5101650)',
            source: 'microsoft',
            category: 'security',
            status: 'installed',
            installedAt: null,
            approvalStatus: 'approved'
          }
        ]
      }
    };

    fetchWithAuthMock.mockImplementation(async () => makeJsonResponse(patchData));

    render(<DevicePatchStatusTab deviceId="dev-123" osType="windows" />);

    expect(await screen.findByText('Cumulative Update for Windows 11 (KB5101650)')).toBeInTheDocument();
    expect(screen.getByText('Installed (date unknown)')).toBeInTheDocument();
  });

  it('shows a failed install attempt and its reason instead of "Pending Approval" (#4223)', async () => {
    const BATTERY = 'preflight check "battery" failed: running on battery power (battery: 76%)';
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse({
        data: {
          compliancePercent: 50,
          pending: [
            {
              id: 'failed-native-1',
              title: '2026-08 Cumulative Update for Windows 11 (KB5041585)',
              source: 'microsoft',
              category: 'security',
              status: 'pending',
              approvalStatus: 'pending',
              installFailure: { deviceCount: 1, error: BATTERY, failedAt: '2026-08-29T18:00:00.000Z' }
            },
            {
              id: 'failed-third-party-1',
              title: 'Google Chrome',
              source: 'third_party',
              category: 'application',
              status: 'pending',
              approvalStatus: 'pending',
              installFailure: { deviceCount: 1, error: null, failedAt: '2026-08-29T18:00:00.000Z' }
            },
            {
              id: 'clean-native-1',
              title: '2026-08 .NET Update (KB5041000)',
              source: 'microsoft',
              category: 'security',
              status: 'pending',
              approvalStatus: 'pending',
              installFailure: null
            }
          ],
          installed: []
        }
      })
    );

    render(<DevicePatchStatusTab deviceId={deviceId} osType="windows" />);

    const nativeBadge = await screen.findByTestId('device-patch-failed-native-1-install-failed');
    expect(nativeBadge.textContent).toContain('Install failed');
    expect(screen.getByText(BATTERY)).toBeTruthy();
    const thirdPartyBadge = screen.getByTestId('device-patch-failed-third-party-1-install-failed');
    expect(thirdPartyBadge.textContent).toContain('Install failed');
    expect(screen.getByText('No reason reported by the agent')).toBeTruthy();
    // Only the patch with no failed attempt still reads "Pending Approval".
    expect(screen.getAllByText('Pending Approval')).toHaveLength(1);
    expect(screen.queryByTestId('device-patch-clean-native-1-install-failed')).toBeNull();
    // #7214 (paper cut #24): "Patch Controls" must not count a patch whose
    // latest install attempt failed as awaiting approval — it stopped being
    // "pending approval" the moment the row shows "Install failed" above.
    // Two native patches are pending; only clean-native-1 has no failure.
    expect(screen.getByText('(1 pending approval)')).toBeInTheDocument();
    expect(screen.queryByText('(2 pending approval)')).not.toBeInTheDocument();
  });

  // #7680: Windows keeps an update that installed but needs a restart at
  // IsInstalled=0 until the device restarts, so it stays in the pending list.
  // The row must say it is installed and waiting for a reboot, not read as an
  // untouched pending (or pending-approval) patch.
  it('shows "Installed, reboot required" for a pending patch whose latest install needs a restart (#7680)', async () => {
    const installedAt = '2026-10-01T09:30:00.000Z';
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse({
        data: {
          compliancePercent: 50,
          pending: [
            {
              id: 'restart-approved', title: '2026-09 .NET Framework Security Update (KB5126052)', source: 'microsoft',
              category: 'security', status: 'pending', approvalStatus: 'approved', installFailure: null,
              awaitingRestart: { installedAt }
            },
            {
              id: 'restart-unapproved', title: '2026-09 Cumulative Update (KB5126000)', source: 'microsoft',
              category: 'security', status: 'pending', approvalStatus: 'pending', installFailure: null,
              awaitingRestart: { installedAt }
            },
            {
              id: 'clean-native-2', title: '2026-09 Servicing Stack Update (KB5126001)', source: 'microsoft',
              category: 'security', status: 'pending', approvalStatus: 'pending', installFailure: null, awaitingRestart: null
            }
          ],
          installed: []
        }
      })
    );

    render(<DevicePatchStatusTab deviceId={deviceId} osType="windows" timezone="UTC" />);

    const badge = await screen.findByTestId('device-patch-restart-approved-awaiting-restart');
    expect(badge.textContent).toContain('Installed, reboot required');
    expect(badge.getAttribute('title')).toContain('It stays listed as pending until the device restarts.');
    expect(screen.getByTestId('device-patch-restart-unapproved-awaiting-restart')).toBeInTheDocument();
    expect(screen.queryByTestId('device-patch-clean-native-2-awaiting-restart')).toBeNull();
    // An installed-awaiting-restart patch is not waiting on an approval.
    expect(screen.getAllByText('Pending Approval')).toHaveLength(1);
    expect(screen.getByText('(1 pending approval)')).toBeInTheDocument();
  });
  // #7625: a patch the linked update ring auto-approves used to read
  // "Pending Approval" because the badge only knew about manual approvals.
  it('shows the ring-aware approval state instead of "Pending Approval" for ring-managed patches (#7625)', async () => {
    const pendingPatch = (id: string, title: string, effectiveApproval: unknown) => ({
      id, title, source: 'microsoft', category: 'security', status: 'pending',
      approvalStatus: 'pending', effectiveApproval, installFailure: null
    });
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse({
        data: {
          compliancePercent: 0,
          approvalEvaluation: { available: true, ring: { id: 'ring-1', name: 'Workstations Ring' } },
          pending: [
            pendingPatch('auto-1', 'Auto Update (KB1)', { state: 'auto_approved', reason: 'ring_auto_approve', holdUntil: null }),
            pendingPatch('held-1', 'Held Update (KB2)', { state: 'deferred', reason: 'held_by_deferral', holdUntil: '2026-10-07T12:00:00.000Z' }),
            pendingPatch('manual-1', 'Manual Update (KB3)', { state: 'needs_approval', reason: 'awaiting_manual_approval', holdUntil: null }),
            pendingPatch('excl-1', 'Excluded Update (KB4)', { state: 'excluded', reason: 'blocked_by_category', holdUntil: null })
          ],
          installed: []
        }
      })
    );

    render(<DevicePatchStatusTab deviceId={deviceId} osType="windows" timezone="UTC" />);

    const auto = await screen.findByTestId('device-patch-auto-1-approval');
    expect(auto.textContent).toBe('Auto-approved');
    expect(auto.getAttribute('title')).toContain('Workstations Ring');
    expect(screen.getByTestId('device-patch-held-1-approval').textContent).toBe(
      `Auto-approves ${new Date('2026-10-07T12:00:00.000Z').toLocaleDateString([], { timeZone: 'UTC' })}`
    );
    expect(screen.getByTestId('device-patch-manual-1-approval').textContent).toBe('Pending Approval');
    expect(screen.getByTestId('device-patch-excl-1-approval').textContent).toBe('Excluded by policy');
    // Only the patch nothing will approve counts as awaiting approval.
    expect(screen.getByText('(1 pending approval)')).toBeInTheDocument();
    expect(screen.getByText(/Workstations Ring/, { selector: '[data-testid="device-patch-approval-ring"]' })).toBeInTheDocument();
    // The per-row Install action is still gated on a manual approval; its
    // title says the ring installs it on schedule.
    const installAuto = screen.getByRole('button', { name: /Auto Update \(KB1\)/ });
    expect(installAuto).toBeDisabled();
    expect(installAuto.getAttribute('aria-label')).toContain('next scheduled patch run');
  });

  it('falls back to the manual approval badge when the ring evaluation is unavailable (#7625)', async () => {
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse({
        data: {
          compliancePercent: 0,
          approvalEvaluation: { available: false, ring: null },
          pending: [
            { id: 'p-1', title: 'Some Update (KB9)', source: 'microsoft', category: 'security', status: 'pending', approvalStatus: 'pending', effectiveApproval: null, installFailure: null }
          ],
          installed: []
        }
      })
    );

    render(<DevicePatchStatusTab deviceId={deviceId} osType="windows" />);

    expect((await screen.findByTestId('device-patch-p-1-approval')).textContent).toBe('Pending Approval');
    expect(screen.getByTestId('device-patch-approval-unavailable')).toBeInTheDocument();
  });
  it('combines the ring-aware state with a failed install attempt (#7625 x #4223)', async () => {
    const failure = { deviceCount: 1, error: 'battery', failedAt: '2026-09-29T18:00:00.000Z' };
    const row = (id: string, effectiveApproval: unknown, extra: Record<string, unknown> = {}) => ({
      id, title: `Patch ${id} (KB${id.length})`, source: 'microsoft', category: 'security', status: 'pending',
      approvalStatus: 'pending', effectiveApproval, installFailure: failure, ...extra
    });
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse({
        data: {
          compliancePercent: 0,
          approvalEvaluation: { available: true, ring: { id: 'ring-1', name: 'Workstations Ring' } },
          pending: [
            row('needs', { state: 'needs_approval', reason: 'awaiting_manual_approval', holdUntil: null }),
            row('auto', { state: 'auto_approved', reason: 'ring_auto_approve', holdUntil: null }),
            row('nodate', { state: 'deferred', reason: 'held_by_deferral', holdUntil: null }, { installFailure: null }),
            row('otherring', { state: 'needs_approval', reason: 'awaiting_manual_approval', holdUntil: null }, { installFailure: null, approvalStatus: 'approved' })
          ],
          installed: []
        }
      })
    );

    render(<DevicePatchStatusTab deviceId={deviceId} osType="windows" />);

    await screen.findByTestId('device-patch-needs-install-failed');
    // #4223 suppression still holds: a failed attempt hides "Pending Approval"...
    expect(screen.queryByTestId('device-patch-needs-approval')).toBeNull();
    // ...but a real ring verdict stays visible next to the failure.
    expect(screen.getByTestId('device-patch-auto-install-failed')).toBeInTheDocument();
    expect(screen.getByTestId('device-patch-auto-approval').textContent).toBe('Auto-approved');
    // No age anchor: held with no date.
    expect(screen.getByTestId('device-patch-nodate-approval').textContent).toBe('Deferred');
    // A manual approval for another ring passes the Install gate but not the
    // ring-aware evaluator; the badge says why the two disagree.
    expect(screen.getByTestId('device-patch-otherring-approval').getAttribute('title')).toContain('different update ring');
  });
  // #7637 option B: the install poll skips the ring-aware evaluation
  // (approvalView=0) and the tab keeps the last known badges instead of
  // flashing the manual-only fallback mid-install.
  it('polls with approvalView=0 during an install and keeps the last ring-aware badges', async () => {
    const ring = { id: 'ring-1', name: 'Workstations Ring' };
    const approved = {
      id: 'appr-1', title: 'Approved Update (KB10)', source: 'microsoft', category: 'security', status: 'pending',
      approvalStatus: 'approved', effectiveApproval: { state: 'approved', reason: 'manual', holdUntil: null }, installFailure: null
    };
    const auto = {
      id: 'auto-1', title: 'Auto Update (KB11)', source: 'microsoft', category: 'security', status: 'pending',
      approvalStatus: 'pending', effectiveApproval: { state: 'auto_approved', reason: 'ring_auto_approve', holdUntil: null }, installFailure: null
    };
    const fresh = {
      id: 'new-1', title: 'Newly Seen Update (KB12)', source: 'microsoft', category: 'security', status: 'pending',
      approvalStatus: 'pending', effectiveApproval: null, installFailure: null
    };
    const fullLoad = { data: { compliancePercent: 0, approvalEvaluation: { available: true, ring }, pending: [approved, auto], installed: [] } };
    // What the server returns when the evaluation is skipped: no verdicts. A
    // third pending patch keeps the count from dropping, so polling continues,
    // and proves the poll response was applied.
    const pollLoad = {
      data: {
        compliancePercent: 0,
        approvalEvaluation: null,
        pending: [{ ...approved, effectiveApproval: null }, { ...auto, effectiveApproval: null }, fresh],
        installed: []
      }
    };
    fetchWithAuthMock.mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.includes('/patches/install')) {
        return makeJsonResponse({ success: true, commandId: 'cmd-1', patchCount: 1 });
      }
      if (typeof url === 'string' && url.startsWith(`/devices/${deviceId}/patches`) && !url.includes('/history')) {
        return makeJsonResponse(url.includes('approvalView=0') ? pollLoad : fullLoad);
      }
      return makeJsonResponse({});
    });

    render(<DevicePatchStatusTab deviceId={deviceId} osType="windows" />);

    expect((await screen.findByTestId('device-patch-auto-1-approval')).textContent).toBe('Auto-approved');
    // A normal load does not skip the evaluation.
    expect(fetchWithAuthMock).toHaveBeenCalledWith(`/devices/${deviceId}/patches`);

    fireEvent.click(screen.getByRole('button', { name: /Install pending Windows patches|Install pending OS patches/i }));
    fireEvent.click(await screen.findByTestId('confirm-install-patches'));
    await screen.findByText(/Installing patches/i);

    // First poll tick (5 s): the request skips the evaluation...
    await screen.findByText('Newly Seen Update (KB12)', {}, { timeout: 8000 });
    expect(fetchWithAuthMock).toHaveBeenCalledWith(`/devices/${deviceId}/patches?approvalView=0`);
    // ...and the badges and ring line from the last full load stay put.
    expect(screen.getByTestId('device-patch-auto-1-approval').textContent).toBe('Auto-approved');
    expect(screen.getByTestId('device-patch-appr-1-approval').textContent).toBe('Approved');
    expect(screen.getByTestId('device-patch-approval-ring').textContent).toContain('Workstations Ring');
  }, 15000);
});
