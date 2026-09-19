import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
    fireEvent.click(await screen.findByTestId('filesystem-analyze-button'));

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
    fireEvent.click(await screen.findByTestId('filesystem-preview-button'));

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
    fireEvent.click(await screen.findByTestId('filesystem-analyze-button'));

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
    await screen.findByTestId('filesystem-analyze-button');

    const keyWarnings = errorSpy.mock.calls.filter((call) => String(call[0]).includes('key'));
    expect(keyWarnings).toEqual([]);
    errorSpy.mockRestore();
  });
});
