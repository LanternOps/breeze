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

describe('ConnectDesktopButton — user-denied state', () => {
  beforeEach(() => {
    _resetToastQueueForTests();
    fetchMock.mockReset();
    toastMock.mockReset();
  });

  it('shows a user-denied message and stops polling when the session status is denied', async () => {
    // GET /devices/:id — no launcher, normal desktop access
    fetchMock.mockResolvedValueOnce(jsonRes({
      desktopAccess: null,
      hasRemoteAccessLauncher: false,
      remoteAccessLaunchSkipReason: 'no_provider_configured',
    }));
    // DELETE /remote/sessions/stale (fires in parallel, ignored)
    fetchMock.mockResolvedValueOnce(jsonRes({}));
    // POST /remote/sessions — returns session id
    fetchMock.mockResolvedValueOnce(jsonRes({ id: 'sess-denied' }));
    // POST /remote/sessions/sess-denied/desktop-connect-code
    fetchMock.mockResolvedValueOnce(jsonRes({ code: 'code-abc' }));
    // GET /remote/sessions/sess-denied (poll) — returns denied
    fetchMock.mockResolvedValueOnce(jsonRes({ status: 'denied' }));

    render(<ConnectDesktopButton deviceId="dev-denied" />);
    fireEvent.click(screen.getByRole('button', { name: /connect desktop/i }));

    await waitFor(() => {
      expect(screen.getByText('The user denied the remote connection.')).toBeInTheDocument();
    }, { timeout: 3000 });

    // Must NOT show the generic "Viewer didn't open?" fallback card
    expect(screen.queryByText(/viewer didn't open/i)).not.toBeInTheDocument();
  });

  it('does NOT show the generic viewer-fallback card when the session is denied', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({
      desktopAccess: null,
      hasRemoteAccessLauncher: false,
      remoteAccessLaunchSkipReason: 'no_provider_configured',
    }));
    fetchMock.mockResolvedValueOnce(jsonRes({}));
    fetchMock.mockResolvedValueOnce(jsonRes({ id: 'sess-denied-2' }));
    fetchMock.mockResolvedValueOnce(jsonRes({ code: 'code-xyz' }));
    // Poll returns denied
    fetchMock.mockResolvedValueOnce(jsonRes({ status: 'denied' }));

    render(<ConnectDesktopButton deviceId="dev-denied-2" />);
    fireEvent.click(screen.getByRole('button', { name: /connect desktop/i }));

    await waitFor(() => {
      expect(screen.getByText('The user denied the remote connection.')).toBeInTheDocument();
    }, { timeout: 3000 });

    // The denied card title must be visible
    expect(screen.getByText('Connection denied')).toBeInTheDocument();
    // Must NOT show the "Viewer didn't open?" generic fallback card
    expect(screen.queryByText(/viewer didn't open/i)).not.toBeInTheDocument();
  });
});
