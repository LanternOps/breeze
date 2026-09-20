import userEvent from '@testing-library/user-event';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DeviceFilesystemTab from './DeviceFilesystemTab';
import { fetchWithAuth } from '../../stores/auth';

const showToast = vi.fn();

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  registerOrgIdProvider: vi.fn(),
}));

vi.mock('../shared/Toast', () => ({
  showToast: (input: unknown) => showToast(input),
}));

vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

const DEVICE_ID = '11111111-1111-1111-1111-111111111111';

const jsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERROR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const SNAPSHOT = {
  id: 'snap-1',
  capturedAt: '2026-09-18T00:00:00Z',
  trigger: 'on_demand',
  partial: false,
  summary: { filesScanned: 10 },
  cleanupCandidates: [],
  topLargestFiles: [{ path: '/tmp/a', sizeBytes: 10 }, { sizeBytes: 5 }],
  topLargestDirectories: [{ path: '/tmp', sizeBytes: 10 }],
  oldDownloads: [],
  unrotatedLogs: [],
  trashUsage: [],
  duplicateCandidates: [],
  errors: [],
};

function routeFetch(handler: (url: string, init?: RequestInit) => Response) {
  fetchWithAuthMock.mockImplementation(((url: string, init?: RequestInit) =>
    Promise.resolve(handler(url, init))) as typeof fetchWithAuth);
}

describe('DeviceFilesystemTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    showToast.mockClear();
  });

  it('renders the error banner with role="alert" so a screen reader announces it', async () => {
    routeFetch((url) => {
      if (url.includes('/filesystem')) return jsonResponse({ success: false, error: 'boom' }, false, 500);
      return jsonResponse({ data: [] });
    });

    render(<DeviceFilesystemTab deviceId={DEVICE_ID} osType="linux" />);
    const banner = await screen.findByTestId('filesystem-error-banner');
    expect(banner).toHaveAttribute('role', 'alert');
  });

  it('toasts through runAction when the scan POST fails instead of failing silently', async () => {
    routeFetch((url, init) => {
      if (init?.method === 'POST' && url.includes('/filesystem/scan')) {
        return jsonResponse({ success: false, error: 'agent offline' }, false, 500);
      }
      if (url.includes('/filesystem')) return jsonResponse({ data: SNAPSHOT });
      return jsonResponse({ data: [] });
    });

    render(<DeviceFilesystemTab deviceId={DEVICE_ID} osType="linux" />);
    fireEvent.click(await screen.findByTestId('filesystem-analyze'));

    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'agent offline' }));
    });
  });

  it('toasts through runAction when the cleanup-preview POST fails', async () => {
    routeFetch((url, init) => {
      if (init?.method === 'POST' && url.includes('/filesystem/cleanup-preview')) {
        return jsonResponse({ success: false, error: 'no snapshot' }, false, 404);
      }
      if (url.includes('/filesystem')) return jsonResponse({ data: SNAPSHOT });
      return jsonResponse({ data: [] });
    });

    render(<DeviceFilesystemTab deviceId={DEVICE_ID} osType="linux" />);
    await waitFor(() => expect(screen.getByTestId('filesystem-cleanup-preview')).toBeEnabled());
    fireEvent.click(screen.getByTestId('filesystem-cleanup-preview'));

    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'no snapshot' }));
    });
  });

  it('shows the running banner with role="status" and aborts the poll on unmount', async () => {
    routeFetch((url, init) => {
      if (init?.method === 'POST' && url.includes('/filesystem/scan')) {
        return jsonResponse({ success: true, data: { commandId: 'cmd-1', status: 'pending' } }, true, 202);
      }
      if (url.includes('/commands/cmd-1')) return jsonResponse({ data: { id: 'cmd-1', status: 'pending' } });
      if (url.includes('/filesystem')) return jsonResponse({ data: SNAPSHOT });
      return jsonResponse({ data: [] });
    });

    const { unmount } = render(<DeviceFilesystemTab deviceId={DEVICE_ID} osType="linux" />);
    fireEvent.click(await screen.findByTestId('filesystem-analyze'));

    const banner = await screen.findByTestId('filesystem-scan-banner');
    expect(banner).toHaveAttribute('role', 'status');

    // The poll loop outlived unmount, so a scan started and then navigated away
    // from kept fetching for minutes and setting state on a dead component.
    const pollCall = fetchWithAuthMock.mock.calls.find(([url]) => String(url).includes('/commands/cmd-1'));
    expect(pollCall).toBeDefined();
    const signal = (pollCall?.[1] as RequestInit | undefined)?.signal as AbortSignal | undefined;
    expect(signal).toBeDefined();
    expect(signal?.aborted).toBe(false);

    unmount();
    expect(signal?.aborted).toBe(true);
  });

  it('renders a row whose path is missing without a duplicate React key', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    routeFetch((url) => {
      if (url.includes('/filesystem')) return jsonResponse({ data: SNAPSHOT });
      return jsonResponse({ data: [] });
    });

    render(<DeviceFilesystemTab deviceId={DEVICE_ID} osType="linux" />);
    await screen.findByTestId('filesystem-analyze');

    const keyWarnings = errorSpy.mock.calls.filter((call) => String(call[0]).includes('key'));
    expect(keyWarnings).toEqual([]);
    errorSpy.mockRestore();
  });
  it('shows a product heading, not an internal ticket id', async () => {
    routeFetch((url) => {
      if (url.includes('/filesystem')) return jsonResponse({ data: SNAPSHOT });
      return jsonResponse({ data: [] });
    });

    render(<DeviceFilesystemTab deviceId={DEVICE_ID} osType="linux" />);
    // "BE-1" is the internal tracking id of the original epic. It shipped to
    // customers in the tab heading and in the empty state.
    const heading = await screen.findByTestId('filesystem-heading');
    expect(heading.textContent).toBe('Disk Cleanup');
    expect(document.body.textContent).not.toContain('BE-1');
  });
});

const fetchMock = vi.mocked(fetchWithAuth);

const RUN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const json = (payload: unknown, status = 200): Response =>
  ({ ok: status >= 200 && status < 300, status, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

/** A Windows device with two fixed volumes, one scanned snapshot and history. */
function windowsFixture(): void {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (url.includes('/filesystem/volumes')) {
      return Promise.resolve(json({ data: [
        { mountPoint: 'C:\\', scanPath: 'C:\\', fsType: 'NTFS', totalGb: 500, usedGb: 400, freeGb: 100, usedPercent: 80, isOsRoot: true, scanState: null, latestSnapshot: { id: 'snap-1', capturedAt: '2026-09-19T10:00:00.000Z', partial: false, cleanupEstimateBytes: 3072 } },
        { mountPoint: 'D:\\', scanPath: 'D:\\', fsType: 'NTFS', totalGb: 1000, usedGb: 200, freeGb: 800, usedPercent: 20, isOsRoot: false, scanState: null, latestSnapshot: null },
      ] }));
    }
    if (url.includes('/filesystem/cleanup-runs')) {
      return Promise.resolve(json({ success: true, data: { runs: [
        { id: 'r1', kind: 'files', status: 'executed', scanPath: 'C:\\', requestedAt: '2026-09-18T10:00:00.000Z', approvedAt: '2026-09-18T10:01:00.000Z', bytesReclaimed: 2048, error: null, candidateCount: 3, estimatedBytes: 4096, actionCount: 2 },
      ], nextCursor: null } }));
    }
    if (url.includes('/filesystem/cleanup-preview') && method === 'POST') {
      return Promise.resolve(json({ success: true, data: {
        cleanupRunId: RUN_ID, snapshotId: 'snap-1', scanPath: 'C:\\',
        estimatedBytes: 3072, candidateCount: 2,
        categories: [{ category: 'temp_files', count: 2, estimatedBytes: 3072 }],
        candidates: [
          { path: 'C:\\Windows\\Temp\\big', category: 'temp_files', sizeBytes: 2048 },
          { path: 'C:\\Windows\\Temp\\small', category: 'temp_files', sizeBytes: 1024 },
        ],
      } }));
    }
    if (url.includes('/filesystem?path=')) {
      return Promise.resolve(json({ data: {
        id: 'snap-1', capturedAt: '2026-09-19T10:00:00.000Z', trigger: 'on_demand',
        partial: false, scanPath: 'C:\\', scanMode: 'baseline',
        summary: { filesScanned: 1250, dirsScanned: 85, bytesScanned: 1024, maxDepthReached: 24, permissionDeniedCount: 0 },
        topLargestFiles: [{ path: 'C:\\big.iso', sizeBytes: 4096 }],
        topLargestDirectories: [{ path: 'C:\\Windows', sizeBytes: 8192 }],
        tempAccumulation: [{ category: 'temp_files', bytes: 3072 }],
        oldDownloads: [], unrotatedLogs: [], trashUsage: [], duplicateCandidates: [],
        cleanupCandidates: [{ path: 'C:\\Windows\\Temp\\big', sizeBytes: 2048 }], errors: [],
      } }));
    }
    if (url.includes('/commands?limit=')) {
      return Promise.resolve(json({ data: [] }));
    }
    return Promise.resolve(json({}, 404));
  });
}

describe('DeviceFilesystemTab (composition)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('mounts the whole §8 layout for a Windows device: picker, panels, cleanup, history', async () => {
    windowsFixture();

    render(<DeviceFilesystemTab deviceId="dev-1" osType="windows" />);

    // Volume picker (W02) — both fixed volumes, OS root badged.
    expect(await screen.findByTestId('volume-picker')).toBeInTheDocument();
    // Snapshot panels (Task 10).
    expect(await screen.findByTestId('filesystem-snapshot-panels')).toBeInTheDocument();
    expect(screen.getByTestId('filesystem-temp-accumulation')).toBeInTheDocument();
    // Cleanup panel (Task 11) — present, prompting for a preview.
    expect(screen.getByTestId('cleanup-panel')).toBeInTheDocument();
    expect(screen.getByText('Run Cleanup Preview to choose what to delete.')).toBeInTheDocument();
    // Run history (Task 12).
    expect(await screen.findByTestId('cleanup-run-r1')).toBeInTheDocument();
  });

  it('runs a preview and hands the pinned run to the cleanup panel', async () => {
    windowsFixture();

    render(<DeviceFilesystemTab deviceId="dev-1" osType="windows" />);
    await screen.findByTestId('filesystem-snapshot-panels');

    await userEvent.click(screen.getByTestId('filesystem-cleanup-preview'));

    // The candidate table replaced the "run a preview" prompt.
    const panel = await screen.findByTestId('cleanup-panel');
    expect(within(panel).getByTestId('cleanup-candidate-C:\\Windows\\Temp\\big')).toBeInTheDocument();

    const previewCall = fetchMock.mock.calls.find(([u]) => String(u).includes('cleanup-preview'));
    expect(previewCall).toBeDefined();
    // The preview is scoped to the SELECTED volume, not to a hardcoded C:\.
    expect(JSON.parse(String(previewCall![1]?.body))).toEqual({ path: 'C:\\' });
  });

  it('scopes the snapshot request to the volume the picker selected', async () => {
    windowsFixture();

    render(<DeviceFilesystemTab deviceId="dev-1" osType="windows" />);
    await screen.findByTestId('filesystem-snapshot-panels');

    await userEvent.click(screen.getAllByTestId('volume-chip').find((chip) => chip.dataset.volume === 'D:\\')!);

    await waitFor(() => {
      const urls = fetchMock.mock.calls.map(([u]) => String(u));
      expect(urls.some((u) => u.includes('/filesystem?path=D%3A%5C'))).toBe(true);
    });
  });

  it('shows a role=status banner while a scan is queued and a role=alert banner on failure', async () => {
    windowsFixture();
    render(<DeviceFilesystemTab deviceId="dev-1" osType="windows" />);
    await screen.findByTestId('filesystem-snapshot-panels');

    fetchMock.mockImplementationOnce(() => Promise.resolve(json({ success: false, error: 'agent offline' }, 500)));
    await userEvent.click(screen.getByTestId('filesystem-analyze'));

    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent('agent offline');
  });

  it('renders the empty state for a volume that has never been scanned', async () => {
    windowsFixture();
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/filesystem/volumes')) {
        return Promise.resolve(json({ data: [
          { mountPoint: 'C:\\', scanPath: 'C:\\', fsType: 'NTFS', totalGb: 500, usedGb: 400, freeGb: 100, usedPercent: 80, isOsRoot: true, scanState: null, latestSnapshot: null },
        ] }));
      }
      if (url.includes('/filesystem/cleanup-runs')) {
        return Promise.resolve(json({ success: true, data: { runs: [], nextCursor: null } }));
      }
      if (url.includes('/filesystem?path=')) return Promise.resolve(json({ error: 'none' }, 404));
      if (url.includes('/commands?limit=')) return Promise.resolve(json({ data: [] }));
      return Promise.resolve(json({}, 404));
    });

    render(<DeviceFilesystemTab deviceId="dev-1" osType="windows" />);

    expect(await screen.findByTestId('filesystem-empty-state')).toBeInTheDocument();
    expect(screen.queryByTestId('filesystem-snapshot-panels')).not.toBeInTheDocument();
  });

  it('never renders the retired BE-1 heading', async () => {
    windowsFixture();
    render(<DeviceFilesystemTab deviceId="dev-1" osType="windows" />);
    await screen.findByTestId('filesystem-snapshot-panels');
    expect(screen.queryByText(/BE-1/)).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Disk Cleanup' })).toBeInTheDocument();
  });
  it('keeps the execution result visible after refreshing the snapshot and history', async () => {
    windowsFixture();
    const fixture = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url, init) => {
      if (String(url).includes('/filesystem/cleanup-execute')) {
        return Promise.resolve(json({ success: true, data: {
          cleanupRunId: RUN_ID, status: 'executed', bytesReclaimed: 3072,
          selectedCount: 2, failedCount: 0, rejectedPaths: [], partial: false, budgetMs: 240_000,
          actions: [{ path: 'C:\\Windows\\Temp\\big', sizeBytes: 3072, status: 'completed' }],
        } }));
      }
      return fixture(url, init);
    });
    render(<DeviceFilesystemTab deviceId="dev-1" osType="windows" />);
    await screen.findByTestId('filesystem-snapshot-panels');
    await userEvent.click(screen.getByTestId('filesystem-cleanup-preview'));
    await userEvent.click(await screen.findByTestId('cleanup-category-select-all-temp_files'));
    await userEvent.click(screen.getByTestId('cleanup-execute'));
    await userEvent.click(await screen.findByTestId('cleanup-confirm-button'));
    expect(await screen.findByTestId('cleanup-result')).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/filesystem/cleanup-runs')).length).toBeGreaterThan(2);
  });

});
