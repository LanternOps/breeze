import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DeviceFilesystemTab from './DeviceFilesystemTab';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  registerOrgIdProvider: vi.fn(),
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

const jsonResponse = (payload: unknown, ok = true, status = 200): Response =>
  ({ ok, status, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const VOLUMES = [
  {
    mountPoint: 'C:\\', scanPath: 'C:\\', fsType: 'NTFS',
    totalGb: 500, usedGb: 400, freeGb: 100, usedPercent: 80, isOsRoot: true,
    scanState: null, latestSnapshot: null,
  },
  {
    mountPoint: 'D:\\', scanPath: 'D:\\', fsType: 'NTFS',
    totalGb: 2000, usedGb: 100, freeGb: 1900, usedPercent: 5, isOsRoot: false,
    scanState: null,
    latestSnapshot: { id: 'snap-d', capturedAt: '2026-09-19T09:00:00.000Z', partial: false, cleanupEstimateBytes: 4096 },
  },
];

function snapshotFor(scanPath: string) {
  return {
    data: {
      id: `snap-${scanPath}`, scanPath, capturedAt: '2026-09-19T09:00:00.000Z',
      trigger: 'on_demand', partial: false, reason: null, path: scanPath, scanMode: 'baseline',
      summary: { filesScanned: 10 },
      topLargestFiles: [] as Array<{ path: string; sizeBytes: number }>, topLargestDirectories: [], tempAccumulation: [],
      oldDownloads: [], unrotatedLogs: [], trashUsage: [],
      duplicateCandidates: [], cleanupCandidates: [], errors: [],
    },
  };
}

/** Routes every request the tab makes by URL, so nothing falls through. */
function routeByUrl() {
  fetchWithAuthMock.mockImplementation(async (rawUrl: string) => {
    if (rawUrl.includes('/filesystem/volumes')) return jsonResponse({ data: VOLUMES });
    if (rawUrl.includes('/commands')) return jsonResponse({ data: [] });
    if (rawUrl.includes('/filesystem?')) {
      const path = decodeURIComponent(new URL(rawUrl, 'https://x').searchParams.get('path') ?? '');
      return jsonResponse(snapshotFor(path));
    }
    if (rawUrl.endsWith('/filesystem')) return jsonResponse(snapshotFor('C:\\'));
    return jsonResponse({ data: null }, false, 404);
  });
}

function snapshotRequestPaths(): string[] {
  return fetchWithAuthMock.mock.calls
    .map(([url]) => url as string)
    .filter((url) => url.includes('/filesystem?') || url.endsWith('/filesystem'))
    .map((url) => decodeURIComponent(new URL(url, 'https://x').searchParams.get('path') ?? ''));
}

beforeEach(() => {
  vi.clearAllMocks();
  routeByUrl();
});

describe('DeviceFilesystemTab — volume picker mount (spec §8)', () => {
  it('renders the picker inside the tab with one chip per volume', async () => {
    render(<DeviceFilesystemTab deviceId="device-1" osType="windows" />);

    await waitFor(() => expect(screen.getByTestId('volume-picker')).toBeInTheDocument());
    expect(screen.getAllByTestId('volume-chip').map((c) => c.getAttribute('data-volume')))
      .toEqual(['C:\\', 'D:\\']);
  });

  it('selects the OS volume first and reads its snapshot', async () => {
    render(<DeviceFilesystemTab deviceId="device-1" osType="windows" />);

    await waitFor(() => expect(screen.getByTestId('volume-picker')).toBeInTheDocument());
    await waitFor(() => expect(snapshotRequestPaths()).toContain('C:\\'));
    expect(screen.getAllByTestId('volume-chip')[0]!).toHaveAttribute('aria-pressed', 'true');
  });

  it('re-keys the snapshot fetch when another volume is selected', async () => {
    render(<DeviceFilesystemTab deviceId="device-1" osType="windows" />);
    await waitFor(() => expect(screen.getByTestId('volume-picker')).toBeInTheDocument());
    await waitFor(() => expect(snapshotRequestPaths()).toContain('C:\\'));

    fireEvent.click(screen.getAllByTestId('volume-chip')[1]!);

    await waitFor(() => expect(snapshotRequestPaths()).toContain('D:\\'));
    expect(screen.getAllByTestId('volume-chip')[1]!).toHaveAttribute('aria-pressed', 'true');
  });

  it('scans the selected volume, not the OS root', async () => {
    render(<DeviceFilesystemTab deviceId="device-1" osType="windows" />);
    await waitFor(() => expect(screen.getByTestId('volume-picker')).toBeInTheDocument());
    fireEvent.click(screen.getAllByTestId('volume-chip')[1]!);
    await waitFor(() => expect(snapshotRequestPaths()).toContain('D:\\'));

    fetchWithAuthMock.mockClear();
    fetchWithAuthMock.mockImplementation(async (rawUrl: string) => {
      if (rawUrl.includes('/filesystem/scan')) {
        return jsonResponse({ success: true, data: { commandId: 'cmd-1', scanPath: 'D:\\' } }, true, 202);
      }
      if (rawUrl.includes('/commands/cmd-1')) return jsonResponse({ data: { id: 'cmd-1', status: 'completed' } });
      if (rawUrl.includes('/filesystem/volumes')) return jsonResponse({ data: VOLUMES });
      if (rawUrl.includes('/commands')) return jsonResponse({ data: [] });
      return jsonResponse(snapshotFor('D:\\'));
    });

    fireEvent.click(screen.getByTestId('filesystem-analyze-button'));

    await waitFor(() => {
      const scan = fetchWithAuthMock.mock.calls.find(([url]) => (url as string).includes('/filesystem/scan'));
      expect(scan).toBeDefined();
      expect(JSON.parse((scan![1] as RequestInit).body as string).path).toBe('D:\\');
    });
  });

  it('previews cleanup for the selected volume', async () => {
    render(<DeviceFilesystemTab deviceId="device-1" osType="windows" />);
    await waitFor(() => expect(screen.getByTestId('volume-picker')).toBeInTheDocument());
    fireEvent.click(screen.getAllByTestId('volume-chip')[1]!);
    await waitFor(() => expect(snapshotRequestPaths()).toContain('D:\\'));

    fetchWithAuthMock.mockClear();
    fetchWithAuthMock.mockImplementation(async (rawUrl: string) => {
      if (rawUrl.includes('/cleanup-preview')) {
        return jsonResponse({
          success: true,
          data: { cleanupRunId: 'run-1', scanPath: 'D:\\', estimatedBytes: 4096, candidateCount: 1, categories: [], candidates: [] },
        });
      }
      return jsonResponse({ data: [] });
    });

    fireEvent.click(screen.getByTestId('filesystem-preview-button'));

    await waitFor(() => {
      const preview = fetchWithAuthMock.mock.calls.find(([url]) => (url as string).includes('/cleanup-preview'));
      expect(preview).toBeDefined();
      expect(JSON.parse((preview![1] as RequestInit).body as string).path).toBe('D:\\');
    });
  });

  it('falls back to the OS root when the volumes call fails, so the tab still works', async () => {
    fetchWithAuthMock.mockImplementation(async (rawUrl: string) => {
      if (rawUrl.includes('/filesystem/volumes')) {
        return jsonResponse({ error: 'boom' }, false, 500);
      }
      if (rawUrl.includes('/commands')) return jsonResponse({ data: [] });
      return jsonResponse(snapshotFor('C:\\'));
    });

    render(<DeviceFilesystemTab deviceId="device-1" osType="windows" />);

    await waitFor(() => expect(screen.getByTestId('volume-picker-error')).toBeInTheDocument());
    await waitFor(() => expect(snapshotRequestPaths()).toContain('C:\\'));
  });
});

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { promise, resolve };
}

function previewFor(scanPath: string) {
  return { success: true, data: {
    cleanupRunId: 'run-old', scanPath, estimatedBytes: 4096, candidateCount: 1,
    categories: [], candidates: [{ path: 'old-volume-candidate', category: 'temp_files', sizeBytes: 4096 }],
  } };
}

describe('DeviceFilesystemTab — in-flight volume isolation', () => {
  it('ignores a cleanup preview that completes after switching volumes', async () => {
    const preview = deferredResponse();
    const normal = fetchWithAuthMock.getMockImplementation()!;
    fetchWithAuthMock.mockImplementation((url, options) => url.includes('/cleanup-preview')
      ? preview.promise : normal(url, options));
    render(<DeviceFilesystemTab deviceId="device-1" osType="windows" />);
    await waitFor(() => expect(screen.getByTestId('filesystem-preview-button')).toBeEnabled());
    fireEvent.click(screen.getByTestId('filesystem-preview-button'));
    fireEvent.click(screen.getAllByTestId('volume-chip')[1]!);
    await waitFor(() => expect(snapshotRequestPaths()).toContain('D:\\'));
    await act(async () => { preview.resolve(jsonResponse(previewFor('C:\\'))); });
    expect(screen.queryByText('old-volume-candidate')).not.toBeInTheDocument();
    expect(screen.getByTestId('filesystem-preview-button')).toBeEnabled();
  });

  it('ignores a scan completion and its old-volume snapshot after switching volumes', async () => {
    const completion = deferredResponse();
    const normal = fetchWithAuthMock.getMockImplementation()!;
    fetchWithAuthMock.mockImplementation((url, options) => {
      if (url.includes('/filesystem/scan')) return Promise.resolve(jsonResponse({ data: { commandId: 'scan-old' } }));
      if (url.includes('/commands/scan-old')) return completion.promise;
      return normal(url, options);
    });
    render(<DeviceFilesystemTab deviceId="device-1" osType="windows" />);
    await waitFor(() => expect(screen.getByTestId('filesystem-analyze-button')).toBeEnabled());
    fireEvent.click(screen.getByTestId('filesystem-analyze-button'));
    await waitFor(() => expect(fetchWithAuthMock.mock.calls.some(([url]) => url.includes('/commands/scan-old'))).toBe(true));
    fireEvent.click(screen.getAllByTestId('volume-chip')[1]!);
    await waitFor(() => expect(snapshotRequestPaths()).toContain('D:\\'));
    const rootReads = snapshotRequestPaths().filter((path) => path === 'C:\\').length;
    await act(async () => { completion.resolve(jsonResponse({ data: { id: 'scan-old', status: 'completed' } })); });
    expect(snapshotRequestPaths().filter((path) => path === 'C:\\')).toHaveLength(rootReads);
    expect(screen.queryByTestId('filesystem-scan-banner')).not.toBeInTheDocument();
  });

  it('ignores an old snapshot refresh that resolves after the new volume loads', async () => {
    render(<DeviceFilesystemTab deviceId="device-1" osType="windows" />);
    await waitFor(() => expect(screen.getByTestId('volume-picker')).toBeInTheDocument());
    const oldSnapshot = deferredResponse();
    const normal = fetchWithAuthMock.getMockImplementation()!;
    fetchWithAuthMock.mockImplementation((url, options) => url.includes('/filesystem?') && url.includes('C%3A')
      ? oldSnapshot.promise : normal(url, options));
    fireEvent.click(screen.getByRole('button', { name: /^Refresh$/ }));
    fireEvent.click(screen.getAllByTestId('volume-chip')[1]!);
    await waitFor(() => expect(screen.getByTestId('volume-picker')).toBeInTheDocument());
    const stale = snapshotFor('C:\\');
    stale.data.topLargestFiles = [{ path: 'stale-root-file', sizeBytes: 1024 }];
    await act(async () => { oldSnapshot.resolve(jsonResponse(stale)); });
    expect(screen.queryByText('stale-root-file')).not.toBeInTheDocument();
  });

  it('clears the existing snapshot and cleanup preview when selecting a volume with no snapshot', async () => {
    const normal = fetchWithAuthMock.getMockImplementation()!;
    fetchWithAuthMock.mockImplementation((url, options) => {
      if (url.includes('/cleanup-preview')) return Promise.resolve(jsonResponse(previewFor('C:\\')));
      if (url.includes('/filesystem?')) {
        if (url.includes('D%3A')) return Promise.resolve(jsonResponse({ data: null }));
        const root = snapshotFor('C:\\');
        root.data.topLargestFiles = [{ path: 'root-only-file', sizeBytes: 1024 }];
        return Promise.resolve(jsonResponse(root));
      }
      return normal(url, options);
    });
    render(<DeviceFilesystemTab deviceId="device-1" osType="windows" />);
    await waitFor(() => expect(screen.getByText('root-only-file')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('filesystem-preview-button'));
    await waitFor(() => expect(screen.getByText('old-volume-candidate')).toBeInTheDocument());
    fireEvent.click(screen.getAllByTestId('volume-chip')[1]!);
    await waitFor(() => expect(screen.getByTestId('filesystem-preview-button')).toBeDisabled());
    expect(screen.queryByText('root-only-file')).not.toBeInTheDocument();
    expect(screen.queryByText('old-volume-candidate')).not.toBeInTheDocument();
  });
});
