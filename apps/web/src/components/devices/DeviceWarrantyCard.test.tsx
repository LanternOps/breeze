import '@/lib/i18n';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import DeviceWarrantyCard from './DeviceWarrantyCard';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';
import { navigateTo } from '@/lib/navigation';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

// runAction calls showToast; mock it so we can assert feedback surfaces without
// rendering a real toast.
vi.mock('../shared/Toast', () => ({
  showToast: vi.fn(),
}));

vi.mock('@/lib/navigation', () => ({
  navigateTo: vi.fn(),
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);
const showToastMock = vi.mocked(showToast);
const navigateToMock = vi.mocked(navigateTo);

const deviceId = '22222222-2222-2222-2222-222222222222';

function jsonResponse(payload: unknown, ok = true, status = ok ? 200 : 500): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  } as unknown as Response;
}

function warrantyPayload(overrides: Record<string, unknown> = {}) {
  return {
    warranty: {
      id: 'w1',
      deviceId,
      manufacturer: 'dell',
      serialNumber: 'ABC123',
      status: 'unknown',
      warrantyStartDate: null,
      warrantyEndDate: null,
      entitlements: [],
      dataSource: 'provider',
      lastSyncAt: '2026-06-20T00:00:00.000Z',
      lastSyncError: null,
      ...overrides,
    },
  };
}

describe('DeviceWarrantyCard — refresh feedback (#1723)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('surfaces a queued toast on Refresh click', async () => {
    fetchWithAuthMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/warranty/refresh') && method === 'POST') {
        return jsonResponse({ message: 'Warranty refresh queued' });
      }
      return jsonResponse(warrantyPayload());
    });

    render(<DeviceWarrantyCard deviceId={deviceId} />);
    const refreshBtn = await screen.findByRole('button', { name: /refresh/i });
    fireEvent.click(refreshBtn);

    await waitFor(() => {
      expect(showToastMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'success', message: 'Refreshing warranty…' })
      );
    });
    // POST was sent to the refresh route.
    expect(fetchWithAuthMock).toHaveBeenCalledWith(
      `/devices/${deviceId}/warranty/refresh`,
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('shows the in-progress "Checking…" label after click, then settles once a newer sync arrives', async () => {
    let syncStamp = '2026-06-20T00:00:00.000Z';
    fetchWithAuthMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/warranty/refresh') && method === 'POST') {
        return jsonResponse({ message: 'Warranty refresh queued' });
      }
      return jsonResponse(warrantyPayload({ lastSyncAt: syncStamp }));
    });

    render(<DeviceWarrantyCard deviceId={deviceId} />);
    const refreshBtn = await screen.findByRole('button', { name: /refresh/i });
    fireEvent.click(refreshBtn);

    // The card flips to the in-progress label as soon as the refresh is queued.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /checking/i })).toBeInTheDocument();
    });

    // Worker stamps a newer lastSyncAt; the poll detects it and the card settles
    // back to "Refresh" on its own (no manual reload). Default poll is 2s.
    syncStamp = '2026-06-21T00:00:00.000Z';
    await waitFor(
      () => {
        expect(screen.getByRole('button', { name: /^refresh$/i })).toBeInTheDocument();
      },
      { timeout: 8000 }
    );
    // A successful refresh surfaces a success toast.
    expect(showToastMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', message: 'Warranty information updated.' })
    );
  }, 12000);

  it('surfaces an error toast when the worker reports a failure (lastSyncError) despite advancing lastSyncAt', async () => {
    let payload = warrantyPayload({ lastSyncAt: '2026-06-20T00:00:00.000Z' });
    fetchWithAuthMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/warranty/refresh') && method === 'POST') {
        return jsonResponse({ message: 'Warranty refresh queued' });
      }
      return jsonResponse(payload);
    });

    render(<DeviceWarrantyCard deviceId={deviceId} />);
    const refreshBtn = await screen.findByRole('button', { name: /refresh/i });
    fireEvent.click(refreshBtn);

    // Worker advances lastSyncAt but stamps a failure — this must NOT read as success.
    payload = warrantyPayload({
      lastSyncAt: '2026-06-21T00:00:00.000Z',
      lastSyncError: 'Dell API returned 500',
    });
    await waitFor(
      () => {
        expect(showToastMock).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'error', message: expect.stringContaining('Dell API returned 500') })
        );
      },
      { timeout: 8000 }
    );
    expect(showToastMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', message: 'Warranty information updated.' })
    );
  }, 12000);

  it('surfaces an in-progress toast and stops the spinner when the poll times out', async () => {
    // GET always returns the same lastSyncAt → the poll never detects an advance
    // and must settle on the timeout branch. A tiny pollTimeoutMs makes it fast.
    fetchWithAuthMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/warranty/refresh') && method === 'POST') {
        return jsonResponse({ message: 'Warranty refresh queued' });
      }
      return jsonResponse(warrantyPayload({ lastSyncAt: '2026-06-20T00:00:00.000Z' }));
    });

    render(<DeviceWarrantyCard deviceId={deviceId} pollTimeoutMs={1} />);
    const refreshBtn = await screen.findByRole('button', { name: /refresh/i });
    fireEvent.click(refreshBtn);

    await waitFor(
      () => {
        expect(showToastMock).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'warning', message: expect.stringContaining('still in progress') })
        );
      },
      { timeout: 8000 }
    );
    // Spinner cleared even though no fresher sync ever arrived.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^refresh$/i })).toBeInTheDocument();
    });
  }, 12000);

  it('cleans up the poll timer on unmount without erroring', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchWithAuthMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/warranty/refresh') && method === 'POST') {
        return jsonResponse({ message: 'Warranty refresh queued' });
      }
      // Never advances → poll keeps scheduling until unmount.
      return jsonResponse(warrantyPayload({ lastSyncAt: '2026-06-20T00:00:00.000Z' }));
    });

    const { unmount } = render(<DeviceWarrantyCard deviceId={deviceId} />);
    const refreshBtn = await screen.findByRole('button', { name: /refresh/i });
    fireEvent.click(refreshBtn);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /checking/i })).toBeInTheDocument();
    });

    const callsBefore = fetchWithAuthMock.mock.calls.length;
    unmount();
    // Give a poll interval a chance to fire; the cleared timer must not run.
    await new Promise((r) => setTimeout(r, 2500));
    expect(fetchWithAuthMock.mock.calls.length).toBe(callsBefore);
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  }, 12000);

  it('surfaces an error toast when the queue request fails', async () => {
    fetchWithAuthMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/warranty/refresh') && method === 'POST') {
        return jsonResponse({ error: 'boom' }, false, 500);
      }
      return jsonResponse(warrantyPayload());
    });

    render(<DeviceWarrantyCard deviceId={deviceId} />);
    const refreshBtn = await screen.findByRole('button', { name: /refresh/i });
    fireEvent.click(refreshBtn);

    await waitFor(() => {
      expect(showToastMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error' })
      );
    });
    // Spinner resets after the failure (button returns to Refresh).
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^refresh$/i })).toBeInTheDocument();
    });
    expect(navigateToMock).not.toHaveBeenCalled();
  });

  it('redirects to login on a 401 from the refresh route', async () => {
    fetchWithAuthMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/warranty/refresh') && method === 'POST') {
        return jsonResponse({ error: 'unauthorized' }, false, 401);
      }
      return jsonResponse(warrantyPayload());
    });

    render(<DeviceWarrantyCard deviceId={deviceId} />);
    const refreshBtn = await screen.findByRole('button', { name: /refresh/i });
    fireEvent.click(refreshBtn);

    await waitFor(() => {
      expect(navigateToMock).toHaveBeenCalled();
    });
  });
});
