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

describe('ConnectDesktopButton — server-revoked session', () => {
  beforeEach(() => {
    _resetToastQueueForTests();
    fetchMock.mockReset();
    toastMock.mockReset();
  });

  it('surfaces the revocation reason instead of silently reverting to idle', async () => {
    // GET /devices/:id — no launcher, normal desktop access
    fetchMock.mockResolvedValueOnce(jsonRes({
      desktopAccess: null,
      hasRemoteAccessLauncher: false,
      remoteAccessLaunchSkipReason: 'no_provider_configured',
    }));
    // POST /remote/sessions — returns session id
    fetchMock.mockResolvedValueOnce(jsonRes({ id: 'sess-revoked' }));
    // POST /remote/sessions/sess-revoked/desktop-connect-code
    fetchMock.mockResolvedValueOnce(jsonRes({ code: 'code-abc' }));
    // GET /remote/sessions/sess-revoked (poll) — server revoked the lease
    fetchMock.mockResolvedValueOnce(jsonRes({
      status: 'disconnected',
      errorMessage: 'revoked:membership_removed',
    }));

    render(<ConnectDesktopButton deviceId="dev-revoked" />);
    fireEvent.click(screen.getByRole('button', { name: /connect desktop/i }));

    await waitFor(() => {
      expect(screen.getByText(/no longer have access/i)).toBeInTheDocument();
    }, { timeout: 3000 });

    // The revoked card title must be visible — not the generic connected fallthrough.
    expect(screen.getByText('Session revoked')).toBeInTheDocument();
  });

  it('links mfa_required revocations to the MFA setup page', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({
      desktopAccess: null,
      hasRemoteAccessLauncher: false,
      remoteAccessLaunchSkipReason: 'no_provider_configured',
    }));
    fetchMock.mockResolvedValueOnce(jsonRes({ id: 'sess-revoked-mfa' }));
    fetchMock.mockResolvedValueOnce(jsonRes({ code: 'code-xyz' }));
    fetchMock.mockResolvedValueOnce(jsonRes({
      status: 'disconnected',
      errorMessage: 'revoked:mfa_required',
    }));

    render(<ConnectDesktopButton deviceId="dev-revoked-mfa" />);
    fireEvent.click(screen.getByRole('button', { name: /connect desktop/i }));

    await waitFor(() => {
      const link = screen.getByRole('link');
      expect(link).toHaveAttribute('href', '/auth/mfa/setup');
    }, { timeout: 3000 });
  });

  it('falls back to the generic message for an unrecognized revocation reason', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({
      desktopAccess: null,
      hasRemoteAccessLauncher: false,
      remoteAccessLaunchSkipReason: 'no_provider_configured',
    }));
    fetchMock.mockResolvedValueOnce(jsonRes({ id: 'sess-revoked-unknown' }));
    fetchMock.mockResolvedValueOnce(jsonRes({ code: 'code-unk' }));
    // A reason the client doesn't recognize yet (e.g. a newer server build) —
    // must still show something rather than nothing (#6120's whole point).
    fetchMock.mockResolvedValueOnce(jsonRes({
      status: 'disconnected',
      errorMessage: 'revoked:some_future_reason',
    }));

    render(<ConnectDesktopButton deviceId="dev-revoked-unknown" />);
    fireEvent.click(screen.getByRole('button', { name: /connect desktop/i }));

    await waitFor(() => {
      expect(screen.getByText('Session revoked')).toBeInTheDocument();
      expect(screen.getByText(/ended by a security policy/i)).toBeInTheDocument();
    }, { timeout: 3000 });

    // No MFA CTA for a non-MFA reason.
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('does not treat an ordinary disconnected session as revoked (regression guard)', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({
      desktopAccess: null,
      hasRemoteAccessLauncher: false,
      remoteAccessLaunchSkipReason: 'no_provider_configured',
    }));
    fetchMock.mockResolvedValueOnce(jsonRes({ id: 'sess-ordinary' }));
    fetchMock.mockResolvedValueOnce(jsonRes({ code: 'code-ord' }));
    // A genuine disconnect with no revocation errorMessage must still take the
    // old "viewer connected" fallthrough back to idle, not the revoked card.
    fetchMock.mockResolvedValueOnce(jsonRes({
      status: 'disconnected',
      errorMessage: null,
    }));

    render(<ConnectDesktopButton deviceId="dev-ordinary" />);
    fireEvent.click(screen.getByRole('button', { name: /connect desktop/i }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /connect desktop/i })).not.toBeDisabled();
    }, { timeout: 3000 });

    expect(screen.queryByText('Session revoked')).not.toBeInTheDocument();
  });
});
