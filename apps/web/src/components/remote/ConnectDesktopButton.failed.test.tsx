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
  return { ...actual, showToast: vi.fn() };
});

const fetchMock = vi.mocked(fetchWithAuth);

const jsonRes = (body: unknown, ok = true): Response =>
  ({
    ok,
    status: ok ? 200 : 500,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(body),
  }) as unknown as Response;

function mockFailedStart(sessionId: string, pollBody: Record<string, unknown>) {
  fetchMock.mockResolvedValueOnce(jsonRes({
    desktopAccess: null,
    hasRemoteAccessLauncher: false,
    remoteAccessLaunchSkipReason: 'no_provider_configured',
  }));
  fetchMock.mockResolvedValueOnce(jsonRes({ id: sessionId }));
  fetchMock.mockResolvedValueOnce(jsonRes({ code: 'code-abc' }));
  fetchMock.mockResolvedValueOnce(jsonRes(pollBody));
}

describe('ConnectDesktopButton — failed start_desktop (#7335)', () => {
  beforeEach(() => {
    _resetToastQueueForTests();
    fetchMock.mockReset();
    vi.mocked(showToast).mockReset();
  });

  it('surfaces the session errorMessage and leaves the button retryable', async () => {
    mockFailedStart('sess-failed', { status: 'failed', errorMessage: 'capture init failed: no encoder' });

    render(<ConnectDesktopButton deviceId="dev-failed" />);
    fireEvent.click(screen.getByRole('button', { name: /connect desktop/i }));

    await waitFor(() => {
      expect(screen.getByText('capture init failed: no encoder')).toBeInTheDocument();
    }, { timeout: 3000 });
    expect(screen.getByText('Remote Desktop failed to start')).toBeInTheDocument();
    expect(screen.queryByText(/viewer didn't open/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /connect desktop/i })).toBeEnabled();
  });

  it('falls back to a generic reason when the failed session has no errorMessage', async () => {
    mockFailedStart('sess-failed-2', { status: 'failed' });

    render(<ConnectDesktopButton deviceId="dev-failed-2" />);
    fireEvent.click(screen.getByRole('button', { name: /connect desktop/i }));

    await waitFor(() => {
      expect(screen.getByText('Remote Desktop failed to start')).toBeInTheDocument();
    }, { timeout: 3000 });
    expect(screen.getByText(/the agent could not start the session/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /connect desktop/i })).toBeEnabled();
  });

  it('dismiss clears the failure card', async () => {
    mockFailedStart('sess-failed-3', { status: 'failed', errorMessage: 'boom' });

    render(<ConnectDesktopButton deviceId="dev-failed-3" />);
    fireEvent.click(screen.getByRole('button', { name: /connect desktop/i }));
    await waitFor(() => expect(screen.getByText('boom')).toBeInTheDocument(), { timeout: 3000 });

    fireEvent.click(screen.getAllByRole('button', { name: /dismiss/i })[0]);
    expect(screen.queryByText('boom')).not.toBeInTheDocument();
  });
});
