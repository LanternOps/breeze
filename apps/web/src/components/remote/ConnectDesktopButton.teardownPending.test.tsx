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

function rigLaunch(pollBody: unknown) {
  // GET /devices/:id — no launcher, normal desktop access
  fetchMock.mockResolvedValueOnce(jsonRes({
    desktopAccess: null,
    hasRemoteAccessLauncher: false,
    remoteAccessLaunchSkipReason: 'no_provider_configured',
  }));
  // POST /remote/sessions — returns session id
  fetchMock.mockResolvedValueOnce(jsonRes({ id: 'sess-1' }));
  // POST /remote/sessions/sess-1/desktop-connect-code
  fetchMock.mockResolvedValueOnce(jsonRes({ code: 'code-abc' }));
  // GET /remote/sessions/sess-1 (poll)
  fetchMock.mockResolvedValueOnce(jsonRes(pollBody));
}

// SEC-038 W06 (#5537): a server-side End commits its terminal decision before
// the agent acknowledges the stop (terminationPhase = 'pending'). The button
// must never read such a session as "viewer connected" — it is ended, and the
// operator needs to know the device is still tearing the previous one down.
describe('ConnectDesktopButton — pending teardown is never rendered as connected', () => {
  beforeEach(() => {
    _resetToastQueueForTests();
    fetchMock.mockReset();
    toastMock.mockReset();
  });

  it('shows the session-ending card (not the connected/idle state) when terminationPhase is pending', async () => {
    rigLaunch({ status: 'disconnected', terminationPhase: 'pending' });

    render(<ConnectDesktopButton deviceId="dev-1" />);
    fireEvent.click(screen.getByRole('button', { name: /connect desktop/i }));

    await waitFor(() => {
      expect(screen.getByText('Session still ending')).toBeInTheDocument();
    }, { timeout: 3000 });
    expect(screen.getByText(/still shutting down/i)).toBeInTheDocument();

    // Neither the generic "Viewer didn't open?" fallback nor the denied card.
    expect(screen.queryByText(/viewer didn't open/i)).not.toBeInTheDocument();
    expect(screen.queryByText('Connection denied')).not.toBeInTheDocument();
    // And it stops polling: exactly one GET of the session.
    const sessionGets = fetchMock.mock.calls.filter(
      (call) => String(call[0]) === '/remote/sessions/sess-1',
    );
    expect(sessionGets).toHaveLength(1);
  });

  it('treats a pending teardown as ended even if the status still reads live', async () => {
    rigLaunch({ status: 'active', terminationPhase: 'pending' });

    render(<ConnectDesktopButton deviceId="dev-1" />);
    fireEvent.click(screen.getByRole('button', { name: /connect desktop/i }));

    await waitFor(() => {
      expect(screen.getByText('Session still ending')).toBeInTheDocument();
    }, { timeout: 3000 });
  });

  it('still goes quietly idle when the viewer connects (terminationPhase none)', async () => {
    rigLaunch({ status: 'active', terminationPhase: 'none' });

    render(<ConnectDesktopButton deviceId="dev-1" />);
    fireEvent.click(screen.getByRole('button', { name: /connect desktop/i }));

    await waitFor(() => {
      const sessionGets = fetchMock.mock.calls.filter(
        (call) => String(call[0]) === '/remote/sessions/sess-1',
      );
      expect(sessionGets).toHaveLength(1);
    }, { timeout: 3000 });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /connect desktop/i })).toBeInTheDocument();
    });
    expect(screen.queryByText('Session still ending')).not.toBeInTheDocument();
  });

  it('dismisses the session-ending card', async () => {
    rigLaunch({ status: 'disconnected', terminationPhase: 'pending' });

    render(<ConnectDesktopButton deviceId="dev-1" />);
    fireEvent.click(screen.getByRole('button', { name: /connect desktop/i }));

    await waitFor(() => {
      expect(screen.getByText('Session still ending')).toBeInTheDocument();
    }, { timeout: 3000 });
    fireEvent.click(screen.getAllByRole('button', { name: /^dismiss$/i })[0]);
    expect(screen.queryByText('Session still ending')).not.toBeInTheDocument();
  });
});
