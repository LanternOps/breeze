import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import BackupDashboard from './BackupDashboard';
import { fetchWithAuth } from '../../stores/auth';
import { installAstroClientRouterStandIn, type ClientRouterStandIn } from '../../__tests__/astroClientRouterStandIn';

// Org scope, so the fleet-view gate stays open and the data paths under test run.
const scopeState = vi.hoisted(() => ({ scope: 'org' as 'org' | 'all', orgId: 'org-1' as string | null }));
vi.mock('@/hooks/useOrgScope', () => ({
  useOrgScope: () => (scopeState.scope === 'all'
    ? { ready: true, status: 'resolved', scope: 'all', orgId: null, org: null, error: null }
    : { ready: true, status: 'resolved', scope: 'org', orgId: scopeState.orgId, org: null, error: null }),
  getOrgScope: () => (scopeState.scope === 'all'
    ? { ready: true, status: 'resolved', scope: 'all', orgId: null, org: null, error: null }
    : { ready: true, status: 'resolved', scope: 'org', orgId: scopeState.orgId, org: null, error: null }),
}));
vi.mock('./BackupHealthOverview', () => ({ default: () => <div data-testid="stub-health-overview" /> }));
vi.mock('../../stores/auth', () => ({
  registerOrgIdProvider: vi.fn(),
  fetchWithAuth: vi.fn()
}));
vi.mock('./HypervDashboard', () => ({
  default: () => <div>Hyper-V Dashboard Stub</div>,
}));
vi.mock('./VMRestoreWizard', () => ({
  default: () => <div>VM Restore Wizard</div>,
}));
vi.mock('./InstantBootStatus', () => ({
  default: () => <div>Instant Boot Status Stub</div>,
}));
// #6349: the file RestoreWizard shipped fully built but was never mounted, so
// file restores were API-only. This stub proves the Restore tab reaches it.
vi.mock('./RestoreWizard', () => ({
  default: () => <div>File Restore Wizard Stub</div>,
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload)
  }) as unknown as Response;

describe('BackupDashboard usage history chart', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    scopeState.scope = 'org';
    scopeState.orgId = 'org-1';
    window.location.hash = '';
    HTMLDialogElement.prototype.showModal = vi.fn(function showModal(this: HTMLDialogElement) {
      this.setAttribute('open', '');
    });
    HTMLDialogElement.prototype.close = vi.fn(function close(this: HTMLDialogElement) {
      this.removeAttribute('open');
    });
  });

  it('renders provider usage timeline from API history payload', async () => {
    fetchWithAuthMock.mockImplementation(async (input) => {
      const url = String(input);

      if (url === '/backup/dashboard') {
        return makeJsonResponse({
          data: {
            stats: [{ id: 'storage_used', name: 'Storage Used', value: '1.5 TB', change: '+4.2%' }],
            recentJobs: [
              {
                id: 'job-1',
                device: 'edge-01',
                config: 'Primary S3',
                status: 'completed',
                started: '10m ago',
                duration: '2m',
                size: '1.2 GB',
                errorLog: 'Chunk retry exceeded threshold'
              }
            ],
            storageProviders: [
              { id: 's3', name: 'S3', used: '1.2 TB', total: '2 TB', percent: 60 },
              { id: 'local', name: 'Local', used: '300 GB', total: '1 TB', percent: 30 }
            ],
            attentionItems: []
          }
        });
      }

      if (url === '/backup/usage-history?days=14') {
        return makeJsonResponse({
          data: {
            points: [
              {
                timestamp: '2026-02-01T00:00:00.000Z',
                totalBytes: 1000,
                providers: [
                  { provider: 's3', bytes: 700 },
                  { provider: 'local', bytes: 300 }
                ]
              },
              {
                timestamp: '2026-02-02T00:00:00.000Z',
                totalBytes: 2000,
                providers: [
                  { provider: 's3', bytes: 1300 },
                  { provider: 'local', bytes: 700 }
                ]
              }
            ]
          }
        });
      }

      return makeJsonResponse({}, false, 404);
    });

    render(<BackupDashboard />);

    await screen.findByText('Storage by Provider');
    expect(await screen.findByLabelText('Storage usage trend by provider over time')).not.toBeNull();
    expect(screen.getByText(/Chunk retry exceeded threshold/i)).toBeTruthy();
    expect(screen.queryByText('Chart placeholder: integrate provider usage history.')).toBeNull();

    // G3-4 (#6496): with real provider rows present, the "no storage
    // providers configured" empty state must not render alongside them.
    expect(screen.getByText('S3')).toBeTruthy();
    expect(screen.getByText('Local')).toBeTruthy();
    expect(screen.queryByText(/No storage providers configured yet/i)).toBeNull();

    // #6496: the chart axis dates must use the app's own long date format
    // (e.g. "Feb 1, 2026"), not the runtime default short-numeric US locale
    // (e.g. "2/1/2026"). Assert the shape rather than an exact day, since the
    // UTC timestamps land on different local calendar days depending on the
    // test runner's timezone.
    const longDatePattern = /^[A-Z][a-z]{2} \d{1,2}, 2026$/;
    const shortNumericPattern = /^\d{1,2}\/\d{1,2}\/2026$/;
    const axisLabels = screen.getAllByText(longDatePattern);
    expect(axisLabels.length).toBe(2);
    expect(screen.queryByText(shortNumericPattern)).toBeNull();
  });

  it('shows the recovery bootstrap tab', async () => {
    fetchWithAuthMock.mockImplementation(async (input) => {
      const url = String(input);

      if (url === '/backup/dashboard') {
        return makeJsonResponse({ data: { stats: [], recentJobs: [], storageProviders: [], attentionItems: [] } });
      }

      if (url === '/backup/usage-history?days=14') {
        return makeJsonResponse({ data: { points: [] } });
      }

      return makeJsonResponse({}, false, 404);
    });

    render(<BackupDashboard />);

    expect(await screen.findByRole('button', { name: /Recovery Bootstrap/i })).toBeTruthy();
  });

  it('mounts the file restore wizard on the Restore tab (#6349)', async () => {
    fetchWithAuthMock.mockImplementation(async (input) => {
      const url = String(input);

      if (url === '/backup/dashboard') {
        return makeJsonResponse({ data: { stats: [], recentJobs: [], storageProviders: [], attentionItems: [] } });
      }

      if (url === '/backup/usage-history?days=14') {
        return makeJsonResponse({ data: { points: [] } });
      }

      return makeJsonResponse({}, false, 404);
    });

    render(<BackupDashboard />);

    const restoreTab = (await screen.findByText('Restore')).closest('button');
    fireEvent.click(restoreTab!);

    expect(await screen.findByText('File Restore Wizard Stub')).toBeTruthy();
    expect(window.location.hash).toBe('#restore');
  });

  it('deep-links to the Restore tab from the #restore hash (#6349)', async () => {
    window.location.hash = '#restore';
    fetchWithAuthMock.mockImplementation(async (input) => {
      const url = String(input);

      if (url === '/backup/dashboard') {
        return makeJsonResponse({ data: { stats: [], recentJobs: [], storageProviders: [], attentionItems: [] } });
      }

      if (url === '/backup/usage-history?days=14') {
        return makeJsonResponse({ data: { points: [] } });
      }

      return makeJsonResponse({}, false, 404);
    });

    render(<BackupDashboard />);

    expect(await screen.findByText('File Restore Wizard Stub')).toBeTruthy();
  });

  it('follows the Snapshots tab restore link to the Restore tab under Astro (G3-2)', async () => {
    // jsdom has no Astro runtime, so a naive fireEvent.click would follow the
    // browser default (hash updated, hashchange fired) even if the app were
    // broken in production. This stand-in reproduces Astro's ClientRouter
    // anchor interception so the test fails for the same reason the real
    // click does. See astroClientRouterStandIn.ts and shared/HashLink.tsx.
    const router: ClientRouterStandIn = installAstroClientRouterStandIn();
    window.location.hash = '#snapshots';

    fetchWithAuthMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init as RequestInit | undefined)?.method ?? 'GET';

      if (url === '/backup/dashboard') {
        return makeJsonResponse({ data: { stats: [], recentJobs: [], storageProviders: [], attentionItems: [] } });
      }

      if (url === '/backup/usage-history?days=14') {
        return makeJsonResponse({ data: { points: [] } });
      }

      if (url === '/backup/snapshots' && method === 'GET') {
        return makeJsonResponse({
          data: [
            {
              id: 'snap-1',
              label: 'Nightly Snapshot',
              createdAt: '2026-03-31T00:00:00Z',
              sizeBytes: 1048576,
              fileCount: 5,
              location: 'snapshots/provider-snap-1',
              expiresAt: '2026-04-30T00:00:00Z',
              legalHold: false,
              legalHoldReason: null,
              isImmutable: false,
              immutableUntil: null,
              immutabilityEnforcement: null,
              requestedImmutabilityEnforcement: null,
              immutabilityFallbackReason: null
            }
          ]
        });
      }

      if (url === '/backup/snapshots/snap-1/browse' && method === 'GET') {
        return makeJsonResponse({ data: [] });
      }

      return makeJsonResponse({}, false, 404);
    });

    try {
      render(<BackupDashboard />);

      const link = await screen.findByTestId('snapshot-browser-restore-link');
      fireEvent.click(link);

      expect(await screen.findByText('File Restore Wizard Stub')).toBeTruthy();
      // #6456: the snapshot being browsed is carried into the Restore tab's
      // hash so the wizard doesn't make the operator re-pick it.
      expect(window.location.hash).toBe('#restore?snapshot=snap-1');
    } finally {
      router.uninstall();
    }
  });

  it('mounts VM restore and instant boot status within the Hyper-V tab', async () => {
    fetchWithAuthMock.mockImplementation(async (input) => {
      const url = String(input);

      if (url === '/backup/dashboard') {
        return makeJsonResponse({ data: { stats: [], recentJobs: [], storageProviders: [], attentionItems: [] } });
      }

      if (url === '/backup/usage-history?days=14') {
        return makeJsonResponse({ data: { points: [] } });
      }

      return makeJsonResponse({}, false, 404);
    });

    render(<BackupDashboard />);

    fireEvent.click(await screen.findByRole('button', { name: /Hyper-V/i }));

    expect(await screen.findByText('Hyper-V Dashboard Stub')).toBeTruthy();
    expect(screen.getByText('VM Restore Wizard')).toBeTruthy();
    expect(screen.getByText('Active instant boots')).toBeTruthy();
    expect(screen.getByText('Instant Boot Status Stub')).toBeTruthy();
  });

  it('reports offline and already-running devices separately in run-all flows', async () => {
    fetchWithAuthMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init as RequestInit | undefined)?.method ?? 'GET';

      if (url === '/backup/dashboard') {
        return makeJsonResponse({ data: { stats: [], recentJobs: [], storageProviders: [], attentionItems: [] } });
      }

      if (url === '/backup/usage-history?days=14') {
        return makeJsonResponse({ data: { points: [] } });
      }

      if (url === '/backup/jobs/run-all/preview' && method === 'GET') {
        return makeJsonResponse({ data: { deviceCount: 1, alreadyRunning: 2, offline: 3 } });
      }

      if (url === '/backup/jobs/run-all' && method === 'POST') {
        return makeJsonResponse({
          data: {
            created: 1,
            skipped: 5,
            skippedRunning: 2,
            skippedOffline: 3,
            failed: 1,
            jobIds: ['job-1'],
            failedJobIds: ['job-2'],
          },
        }, true, 201);
      }

      return makeJsonResponse({}, false, 404);
    });

    render(<BackupDashboard />);

    const runAllButton = await screen.findByRole('button', { name: /Run all backups/i });
    fireEvent.click(runAllButton);

    expect(await screen.findByText(/1 device/i)).toBeTruthy();
    expect(screen.getByText(/2 already running devices will be skipped/i)).toBeTruthy();
    expect(screen.getByText(/3 offline devices will be skipped/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Run backups/i }));

    await waitFor(() =>
      expect(
        screen.getByText(/Started 1 backup job\. 2 skipped \(already running\)\. 3 skipped \(offline\)\. 1 failed to dispatch/i)
      ).toBeTruthy()
    );
  });

  it('runs overdue backups from the overview card', async () => {
    fetchWithAuthMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init as RequestInit | undefined)?.method ?? 'GET';

      if (url === '/backup/dashboard') {
        return makeJsonResponse({
          data: {
            stats: [],
            recentJobs: [],
            storageProviders: [],
            attentionItems: [],
            overdueDevices: [
              { id: 'device-1', name: 'Alpha', lastBackup: 'Yesterday' },
              { id: 'device-2', name: 'Beta', lastBackup: '2 days ago' },
              { id: 'device-3', name: 'Gamma', lastBackup: '3 days ago' },
            ],
          },
        });
      }

      if (url === '/backup/usage-history?days=14') {
        return makeJsonResponse({ data: { points: [] } });
      }

      if (url === '/backup/jobs/run/device-1' && method === 'POST') {
        return makeJsonResponse({ id: 'job-1' }, true, 201);
      }

      if (url === '/backup/jobs/run/device-2' && method === 'POST') {
        return makeJsonResponse({ error: 'A backup job is already pending or running for this device' }, false, 409);
      }

      if (url === '/backup/jobs/run/device-3' && method === 'POST') {
        return makeJsonResponse({ error: 'Dispatch failed' }, false, 502);
      }

      return makeJsonResponse({}, false, 404);
    });

    render(<BackupDashboard />);

    const runOverdueButton = await screen.findByRole('button', { name: /Run overdue backups/i });
    fireEvent.click(runOverdueButton);

    await waitFor(() =>
      expect(screen.getByText(/Started 1 overdue backup job\. 1 skipped\. 1 failed/i)).toBeTruthy()
    );

    expect(fetchWithAuthMock).toHaveBeenCalledWith('/backup/jobs/run/device-1', { method: 'POST' });
    expect(fetchWithAuthMock).toHaveBeenCalledWith('/backup/jobs/run/device-2', { method: 'POST' });
    expect(fetchWithAuthMock).toHaveBeenCalledWith('/backup/jobs/run/device-3', { method: 'POST' });
  });

  it('counts partial jobs in the 24h success-rate denominator but not the numerator', async () => {
    // A device whose every run is partial used to read as having no runs at all
    // (0 completed + 0 failed => rate 0% off a zero denominator).
    fetchWithAuthMock.mockImplementation(async (input) => {
      const url = String(input);

      if (url === '/backup/dashboard') {
        return makeJsonResponse({
          data: {
            jobsLast24h: { completed: 1, failed: 0, partial: 1, running: 0, pending: 0 },
            recentJobs: [],
            storageProviders: [],
            attentionItems: [],
          },
        });
      }

      if (url === '/backup/usage-history?days=14') {
        return makeJsonResponse({ data: { points: [] } });
      }

      return makeJsonResponse({}, false, 404);
    });

    render(<BackupDashboard />);

    await screen.findByText('Success Rate (24h)');
    // 1 completed of (1 completed + 1 partial) = 50%, not 100%.
    expect(screen.getByText('50%')).toBeTruthy();
  });

  it('renders a partial recent job as a distinct warning state', async () => {
    fetchWithAuthMock.mockImplementation(async (input) => {
      const url = String(input);

      if (url === '/backup/dashboard') {
        return makeJsonResponse({
          data: {
            stats: [],
            recentJobs: [
              {
                id: 'job-partial',
                device: 'edge-02',
                config: 'Primary S3',
                status: 'partial',
                started: '5m ago',
                duration: '3m',
                size: '85 B',
              },
            ],
            storageProviders: [],
            attentionItems: [],
          },
        });
      }

      if (url === '/backup/usage-history?days=14') {
        return makeJsonResponse({ data: { points: [] } });
      }

      return makeJsonResponse({}, false, 404);
    });

    render(<BackupDashboard />);

    await screen.findByText('edge-02');
    expect(screen.getByText('Partial')).toBeTruthy();
    expect(screen.queryByText('Warning')).toBeNull();
  });

  it('counts completed_with_errors jobs as successful restore points in the 24h success rate (#5396)', async () => {
    // completed_with_errors is a restorable snapshot, so it belongs in the
    // numerator (like completed) as well as the denominator — not just the
    // denominator the way `partial` is.
    fetchWithAuthMock.mockImplementation(async (input) => {
      const url = String(input);

      if (url === '/backup/dashboard') {
        return makeJsonResponse({
          data: {
            jobsLast24h: { completed: 1, completedWithErrors: 1, failed: 0, partial: 0, running: 0, pending: 0 },
            recentJobs: [],
            storageProviders: [],
            attentionItems: [],
          },
        });
      }

      if (url === '/backup/usage-history?days=14') {
        return makeJsonResponse({ data: { points: [] } });
      }

      return makeJsonResponse({}, false, 404);
    });

    render(<BackupDashboard />);

    await screen.findByText('Success Rate (24h)');
    // (1 completed + 1 completed_with_errors) of 2 total = 100%.
    expect(screen.getByText('100%')).toBeTruthy();
  });

  it('renders a completed_with_errors recent job as its own amber state, never green "Success"', async () => {
    fetchWithAuthMock.mockImplementation(async (input) => {
      const url = String(input);

      if (url === '/backup/dashboard') {
        return makeJsonResponse({
          data: {
            stats: [],
            recentJobs: [
              {
                id: 'job-cwe',
                device: 'edge-03',
                config: 'Primary S3',
                status: 'completed_with_errors',
                started: '5m ago',
                duration: '3m',
                size: '85 B',
              },
            ],
            storageProviders: [],
            attentionItems: [],
          },
        });
      }

      if (url === '/backup/usage-history?days=14') {
        return makeJsonResponse({ data: { points: [] } });
      }

      return makeJsonResponse({}, false, 404);
    });

    render(<BackupDashboard />);

    await screen.findByText('edge-03');
    expect(screen.getByText('Completed with errors')).toBeTruthy();
    expect(screen.queryByText('Success')).toBeNull();
    expect(screen.queryByText('Warning')).toBeNull();
  });

  it('renders the health view alone in all-organizations mode, calling neither org-only endpoint', async () => {
    scopeState.scope = 'all';
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ data: {} }));
    render(<BackupDashboard />);
    expect(await screen.findByTestId('stub-health-overview')).toBeInTheDocument();
    const urls = fetchWithAuthMock.mock.calls.map(([u]) => String(u));
    expect(urls).not.toContain('/backup/dashboard');
    expect(urls.some((u) => u.startsWith('/backup/usage-history'))).toBe(false);
  });

  it('renders the health view above the tiles in org mode and still loads the dashboard', async () => {
    scopeState.scope = 'org';
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ data: {} }));
    render(<BackupDashboard />);
    expect(await screen.findByTestId('stub-health-overview')).toBeInTheDocument();
    expect(fetchWithAuthMock.mock.calls.map(([u]) => String(u))).toContain('/backup/dashboard');
  });
});
