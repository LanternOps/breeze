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
});
