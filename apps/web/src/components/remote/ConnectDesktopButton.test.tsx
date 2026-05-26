import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ConnectDesktopButton from './ConnectDesktopButton';
import { fetchWithAuth } from '../../stores/auth';
import { showToast, _resetToastQueueForTests } from '../shared/Toast';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

vi.mock('../shared/Toast', async () => {
  const actual = await vi.importActual<typeof import('../shared/Toast')>('../shared/Toast');
  return {
    ...actual,
    showToast: vi.fn(),
  };
});

const fetchMock = vi.mocked(fetchWithAuth);
const toastMock = vi.mocked(showToast);

const jsonRes = (body: unknown, ok = true): Response =>
  ({
    ok,
    status: ok ? 200 : 500,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(body),
  }) as unknown as Response;

describe('ConnectDesktopButton — launcher skip-reason toast', () => {
  beforeEach(() => {
    _resetToastQueueForTests();
    fetchMock.mockReset();
    toastMock.mockReset();
  });

  it('toasts an explanation when partner has a launcher but THIS device is missing the identifier', async () => {
    // GET /devices/:id returns hasRemoteAccessLauncher=false WITH a skip reason
    // — the partner config exists but this device can't use it. Without the
    // toast the user would silently get WebRTC instead of their RustDesk
    // default and wonder why.
    fetchMock.mockResolvedValueOnce(jsonRes({
      desktopAccess: null,
      hasRemoteAccessLauncher: false,
      remoteAccessLaunchSkipReason: 'missing_device_identifier',
    }));
    // Subsequent calls (sessions/stale, sessions POST, connect-code POST) — we
    // don't care about their detail for this test; just make them succeed
    // enough that handleConnect doesn't error before the toast is checked.
    fetchMock.mockResolvedValue(jsonRes({ id: 'sess-1', code: 'code-1' }));

    render(<ConnectDesktopButton deviceId="dev-1" />);
    fireEvent.click(screen.getByRole('button', { name: /connect desktop/i }));

    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'error',
          message: expect.stringContaining('per-device identifier'),
        }),
      );
    });
  });

  it('does NOT toast when the partner has no launcher configured at all (no_provider_configured)', async () => {
    // The "expected empty" case — no partner config means nothing surprising
    // is happening, so we proceed silently to WebRTC.
    fetchMock.mockResolvedValueOnce(jsonRes({
      desktopAccess: null,
      hasRemoteAccessLauncher: false,
      remoteAccessLaunchSkipReason: 'no_provider_configured',
    }));
    fetchMock.mockResolvedValue(jsonRes({ id: 'sess-1', code: 'code-1' }));

    render(<ConnectDesktopButton deviceId="dev-2" />);
    fireEvent.click(screen.getByRole('button', { name: /connect desktop/i }));

    // Give the click handler time to run; if a toast was going to fire, it
    // would have by this point.
    await new Promise((r) => setTimeout(r, 20));
    expect(toastMock).not.toHaveBeenCalled();
  });

  it('toasts a different message for provider_disabled', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({
      desktopAccess: null,
      hasRemoteAccessLauncher: false,
      remoteAccessLaunchSkipReason: 'provider_disabled',
    }));
    fetchMock.mockResolvedValue(jsonRes({ id: 'sess-1', code: 'code-1' }));

    render(<ConnectDesktopButton deviceId="dev-3" />);
    fireEvent.click(screen.getByRole('button', { name: /connect desktop/i }));

    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'error',
          message: expect.stringContaining('disabled'),
        }),
      );
    });
  });

  it('does NOT toast when the launcher fires normally (hasRemoteAccessLauncher=true)', async () => {
    // Normal launcher path — no toast.
    fetchMock.mockResolvedValueOnce(jsonRes({
      desktopAccess: null,
      hasRemoteAccessLauncher: true,
      remoteAccessLaunchSkipReason: null,
    }));
    fetchMock.mockResolvedValueOnce(jsonRes({
      launchUrl: 'rustdesk://12345?password=x',
      scheme: 'rustdesk',
    }));

    render(<ConnectDesktopButton deviceId="dev-4" />);
    fireEvent.click(screen.getByRole('button', { name: /connect desktop/i }));

    await new Promise((r) => setTimeout(r, 20));
    expect(toastMock).not.toHaveBeenCalled();
  });
});
