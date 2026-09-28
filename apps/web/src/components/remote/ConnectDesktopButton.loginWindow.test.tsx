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

const jsonRes = (body: unknown, ok = true): Response =>
  ({
    ok,
    status: ok ? 200 : 500,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(body),
  }) as unknown as Response;

// The agent's refusal text (agent/internal/heartbeat/desktop_login_window_gate.go).
const LOGIN_WINDOW_REFUSAL =
  'Remote Desktop is not available at the macOS login window (login_window): macOS blocks remote keyboard ' +
  'and mouse input until a user signs in. Use VNC Relay to sign in at the login window, then connect again.';

const liveDevice = (desktopAccess: unknown = null) => jsonRes({
  desktopAccess,
  hasRemoteAccessLauncher: false,
  remoteAccessLaunchSkipReason: 'no_provider_configured',
});

const calledPaths = () => fetchMock.mock.calls.map(([path, init]) => `${(init as RequestInit | undefined)?.method ?? 'GET'} ${path}`);

// #7047: a Mac at the login window can be captured but not controlled, so a
// WebRTC session there is video-only while looking usable.
describe('ConnectDesktopButton — macOS login window (#7047)', () => {
  beforeEach(() => {
    _resetToastQueueForTests();
    fetchMock.mockReset();
    vi.mocked(showToast).mockReset();
  });

  it('explains an agent login-window refusal and says how to enable VNC Relay', async () => {
    fetchMock.mockResolvedValueOnce(liveDevice());
    fetchMock.mockResolvedValueOnce(jsonRes({ id: 'sess-lw' }));
    fetchMock.mockResolvedValueOnce(jsonRes({ code: 'code-lw' }));
    fetchMock.mockResolvedValueOnce(jsonRes({ status: 'failed', errorMessage: LOGIN_WINDOW_REFUSAL }));

    render(<ConnectDesktopButton deviceId="dev-lw" />);
    fireEvent.click(screen.getByRole('button', { name: /connect desktop/i }));

    await waitFor(() => {
      expect(screen.getByText('This Mac is at the login window')).toBeInTheDocument();
    }, { timeout: 3000 });
    expect(screen.getByText(/enable VNC Relay in this device's configuration policy/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /connect with VNC Relay/i })).not.toBeInTheDocument();
  });

  it('offers VNC Relay from the refusal card when the device policy allows it', async () => {
    fetchMock.mockResolvedValueOnce(liveDevice());
    fetchMock.mockResolvedValueOnce(jsonRes({ id: 'sess-lw-vnc' }));
    fetchMock.mockResolvedValueOnce(jsonRes({ code: 'code-lw-vnc' }));
    fetchMock.mockResolvedValueOnce(jsonRes({ status: 'failed', errorMessage: LOGIN_WINDOW_REFUSAL }));

    render(
      <ConnectDesktopButton
        deviceId="dev-lw-vnc"
        remoteAccessPolicy={{ webrtcDesktop: true, vncRelay: true } as never}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /connect desktop/i }));

    const vncButton = await screen.findByRole('button', { name: /connect with VNC Relay/i }, { timeout: 3000 });

    // POST /tunnels, then POST /tunnels/:id/connect-code (existing VNC plumbing).
    fetchMock.mockResolvedValueOnce(jsonRes({ id: 'tun-1' }));
    fetchMock.mockResolvedValueOnce(jsonRes({ code: 'vnc-code' }));
    fireEvent.click(vncButton);

    await waitFor(() => {
      const tunnelCall = fetchMock.mock.calls.find(([path]) => path === '/tunnels');
      expect(tunnelCall).toBeDefined();
      expect(JSON.parse(String((tunnelCall![1] as RequestInit).body))).toEqual({ deviceId: 'dev-lw-vnc', type: 'vnc' });
    });
    expect(calledPaths()).toContain('POST /tunnels/tun-1/connect-code');
  });

  it('does not start WebRTC when the live desktop state is unavailable, even if the page loaded it as available', async () => {
    // Page rendered before the reboot (prop says nothing is wrong), but the
    // click-time fetch shows the Mac is now at the login window.
    fetchMock.mockResolvedValueOnce(liveDevice({
      mode: 'unavailable',
      reason: 'unsupported_os',
      loginUiReachable: false,
      virtualDisplayReady: false,
    }));

    render(<ConnectDesktopButton deviceId="dev-stale" desktopAccess={null} />);
    fireEvent.click(screen.getByRole('button', { name: /connect desktop/i }));

    await waitFor(() => {
      expect(screen.getByText('Remote Desktop unavailable')).toBeInTheDocument();
    });
    expect(screen.getByText(/macOS blocks remote keyboard and mouse input at the login window/i)).toBeInTheDocument();
    expect(calledPaths()).not.toContain('POST /remote/sessions');
  });

  it('does not show the login-window card for an unrelated start failure (regression guard)', async () => {
    fetchMock.mockResolvedValueOnce(liveDevice());
    fetchMock.mockResolvedValueOnce(jsonRes({ id: 'sess-other' }));
    fetchMock.mockResolvedValueOnce(jsonRes({ code: 'code-other' }));
    fetchMock.mockResolvedValueOnce(jsonRes({ status: 'failed', errorMessage: 'no H264 encoder available' }));

    render(<ConnectDesktopButton deviceId="dev-other" />);
    fireEvent.click(screen.getByRole('button', { name: /connect desktop/i }));

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([path]) => path === '/remote/sessions/sess-other')).toBe(true);
    }, { timeout: 3000 });
    expect(screen.queryByText('This Mac is at the login window')).not.toBeInTheDocument();
  });
});
