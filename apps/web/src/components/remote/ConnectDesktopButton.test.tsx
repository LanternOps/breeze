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

describe('ConnectDesktopButton — disabled prop gating (issue #2013)', () => {
  beforeEach(() => {
    _resetToastQueueForTests();
    fetchMock.mockReset();
    toastMock.mockReset();
  });

  // The full and compact render variants previously dropped the `disabled` prop
  // on the floor (only iconOnly honored it), so an offline device's button
  // stayed clickable and fired a doomed POST /remote/sessions. These assert all
  // three variants now honor `disabled` and surface `disabledTitle`.
  for (const variant of ['full', 'compact', 'iconOnly'] as const) {
    it(`honors disabled + disabledTitle in the ${variant} variant`, () => {
      render(
        <ConnectDesktopButton
          deviceId="dev-off"
          disabled
          disabledTitle="Device is offline"
          {...(variant === 'compact' ? { compact: true } : {})}
          {...(variant === 'iconOnly' ? { iconOnly: true } : {})}
        />,
      );

      const btn = screen.getByRole('button');
      expect(btn).toBeDisabled();
      expect(btn).toHaveAttribute('title', 'Device is offline');
    });

    it(`does NOT fire a session request when clicked while disabled (${variant} variant)`, () => {
      render(
        <ConnectDesktopButton
          deviceId="dev-off"
          disabled
          disabledTitle="Device is offline"
          {...(variant === 'compact' ? { compact: true } : {})}
          {...(variant === 'iconOnly' ? { iconOnly: true } : {})}
        />,
      );

      fireEvent.click(screen.getByRole('button'));
      expect(fetchMock).not.toHaveBeenCalled();
    });
  }

  it('stays enabled when not disabled', () => {
    render(<ConnectDesktopButton deviceId="dev-on" disabledTitle="Device is offline" />);
    expect(screen.getByRole('button', { name: /connect desktop/i })).not.toBeDisabled();
  });

  it('shows the no-display tooltip for a Linux headless-server reason', () => {
    render(
      <ConnectDesktopButton
        deviceId="dev-1"
        desktopAccess={{
          mode: 'unavailable',
          loginUiReachable: false,
          virtualDisplayReady: false,
          reason: 'no_display_session',
          checkedAt: '2026-07-17T00:00:00.000Z',
        }}
      />,
    );
    const btn = screen.getByRole('button');
    expect(btn).toBeDisabled();
    expect(btn.getAttribute('title')).toMatch(/no active graphical session|log in/i);
  });

  it('clears a stale "Connection failed" error and shows the offline tooltip when the device goes offline', async () => {
    // GET /devices/:id (no launcher), then the sessions POST fails — drives the
    // button into its error state while it is still enabled.
    fetchMock.mockResolvedValueOnce(jsonRes({
      desktopAccess: null,
      hasRemoteAccessLauncher: false,
      remoteAccessLaunchSkipReason: 'no_provider_configured',
    }));
    fetchMock.mockResolvedValue(jsonRes({ error: 'Device is not online' }, false));

    const { rerender } = render(
      <ConnectDesktopButton deviceId="dev-x" disabledTitle="Device is offline" />,
    );
    fireEvent.click(screen.getByRole('button', { name: /connect desktop/i }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /connection failed/i })).toBeInTheDocument(),
    );

    // Device flips offline → disabled. The stale error must clear so the offline
    // tooltip is visible rather than the leftover "Connection failed" title.
    rerender(<ConnectDesktopButton deviceId="dev-x" disabled disabledTitle="Device is offline" />);
    const btn = screen.getByRole('button');
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('title', 'Device is offline');
    expect(screen.queryByText(/connection failed/i)).toBeNull();
  });
});
