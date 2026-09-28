import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ElevationRequest } from './types';

const { fetchWithAuthMock, getApprovalAssertionMock, showToastMock, navigateToMock, authState } =
  vi.hoisted(() => ({
    fetchWithAuthMock: vi.fn(),
    getApprovalAssertionMock: vi.fn(),
    showToastMock: vi.fn(),
    navigateToMock: vi.fn(),
    authState: {
      user: { id: 'u-1', mfaEnabled: true, hasPassword: true } as {
        id: string;
        mfaEnabled: boolean;
        hasPassword?: boolean;
      } | null,
    },
  }));

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: fetchWithAuthMock,
  useAuthStore: (selector: (s: typeof authState) => unknown) => selector(authState),
}));

vi.mock('../../stores/authenticator', () => ({
  getApprovalAssertion: getApprovalAssertionMock,
}));

vi.mock('../shared/Toast', () => ({
  showToast: showToastMock,
}));

vi.mock('@/lib/navigation', () => ({
  navigateTo: navigateToMock,
}));

import PamRespondModal from './PamRespondModal';

function makeJsonResponse(payload: unknown, ok = true, status = ok ? 200 : 500): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  } as unknown as Response;
}

const requestFixture = (over: Partial<ElevationRequest> = {}): ElevationRequest => ({
  id: 'er-9',
  orgId: 'org-1',
  siteId: null,
  deviceId: 'dev-1',
  flowType: 'uac_intercept',
  subjectUsername: 'ACME\\jdoe',
  reason: 'Install printer driver',
  status: 'pending',
  requestedAt: '2026-06-14T12:00:00.000Z',
  deviceHostname: 'WS-001',
  ...over,
});

const proofFixture = {
  credentialId: 'cred-1',
  authenticatorData: 'auth-data',
  clientDataJSON: 'client-data',
  signature: 'signature',
  userHandle: null,
};

/** Pull the parsed JSON body from a fetchWithAuth call to the respond endpoint. */
function respondBody(): Record<string, unknown> {
  const call = fetchWithAuthMock.mock.calls.find((c) =>
    String(c[0]).includes('/pam/elevation-requests/er-9/respond'),
  );
  if (!call) throw new Error('respond endpoint was not called');
  return JSON.parse((call[1] as RequestInit).body as string);
}

describe('PamRespondModal Windows Hello step-up', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ success: true }));
  });

  it('runs the assertion on approve and includes the proof in the respond body', async () => {
    getApprovalAssertionMock.mockResolvedValueOnce(proofFixture);

    render(
      <PamRespondModal request={requestFixture()} onClose={() => {}} onActioned={() => {}} />,
    );

    fireEvent.submit(screen.getByTestId('pam-respond-submit').closest('form')!);

    await waitFor(() =>
      expect(getApprovalAssertionMock).toHaveBeenCalledWith('/pam/elevation-requests', 'er-9'),
    );
    await waitFor(() => {
      const body = respondBody();
      expect(body.decision).toBe('approve');
      expect(body.proof).toEqual(proofFixture);
    });
  });

  it('does not request an assertion on deny', async () => {
    render(
      <PamRespondModal request={requestFixture()} onClose={() => {}} onActioned={() => {}} />,
    );

    fireEvent.click(screen.getByTestId('pam-respond-deny-toggle'));
    fireEvent.submit(screen.getByTestId('pam-respond-submit').closest('form')!);

    await waitFor(() => {
      const body = respondBody();
      expect(body.decision).toBe('deny');
    });
    expect(getApprovalAssertionMock).not.toHaveBeenCalled();
    expect(respondBody().proof).toBeUndefined();
  });

  it('surfaces an error and does not submit when the WebAuthn ceremony is cancelled', async () => {
    getApprovalAssertionMock.mockRejectedValueOnce(
      new DOMException('The operation was cancelled', 'NotAllowedError'),
    );

    render(
      <PamRespondModal request={requestFixture()} onClose={() => {}} onActioned={() => {}} />,
    );

    fireEvent.submit(screen.getByTestId('pam-respond-submit').closest('form')!);

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    // The respond endpoint must NOT have been called after a cancelled ceremony.
    expect(
      fetchWithAuthMock.mock.calls.some((c) =>
        String(c[0]).includes('/pam/elevation-requests/er-9/respond'),
      ),
    ).toBe(false);
  });
});

/** The respond call's RequestInit (options), for asserting transport flags. */
function respondInit(): Record<string, unknown> {
  const call = fetchWithAuthMock.mock.calls.find((c) =>
    String(c[0]).includes('/pam/elevation-requests/er-9/respond'),
  );
  if (!call) throw new Error('respond endpoint was not called');
  return call[1] as Record<string, unknown>;
}

function respondCalled(): boolean {
  return fetchWithAuthMock.mock.calls.some((c) =>
    String(c[0]).includes('/pam/elevation-requests/er-9/respond'),
  );
}

function submit() {
  fireEvent.submit(screen.getByTestId('pam-respond-submit').closest('form')!);
}

describe('PamRespondModal critical-tier (L4) re-authentication (#4052)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.user = { id: 'u-1', mfaEnabled: true, hasPassword: true };
    getApprovalAssertionMock.mockResolvedValue(proofFixture);
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ success: true }));
  });

  it('does not show re-auth fields for a non-critical request', () => {
    render(
      <PamRespondModal
        request={requestFixture({ riskTier: 3 })}
        onClose={() => {}}
        onActioned={() => {}}
      />,
    );
    expect(screen.queryByTestId('pam-respond-reauth')).toBeNull();
    expect(screen.queryByTestId('pam-respond-reauth-input')).toBeNull();
  });

  it('does not send re-auth fields for a non-critical approve', async () => {
    render(
      <PamRespondModal
        request={requestFixture({ riskTier: 2 })}
        onClose={() => {}}
        onActioned={() => {}}
      />,
    );
    submit();
    await waitFor(() => expect(respondCalled()).toBe(true));
    expect(respondBody().reauthPassword).toBeUndefined();
    expect(respondBody().reauthMfaCode).toBeUndefined();
  });

  it('shows a password field for a critical approve, and hides it on deny', () => {
    render(
      <PamRespondModal
        request={requestFixture({ riskTier: 4 })}
        onClose={() => {}}
        onActioned={() => {}}
      />,
    );
    const input = screen.getByTestId('pam-respond-reauth-input') as HTMLInputElement;
    expect(input.type).toBe('password');
    expect(input.autocomplete).toBe('current-password');
    expect(screen.getByTestId('pam-respond-reauth')).toHaveTextContent(/critical/i);

    fireEvent.click(screen.getByTestId('pam-respond-deny-toggle'));
    expect(screen.queryByTestId('pam-respond-reauth-input')).toBeNull();
  });

  it('blocks a critical approve with an empty password — no ceremony, no POST', async () => {
    render(
      <PamRespondModal
        request={requestFixture({ riskTier: 4 })}
        onClose={() => {}}
        onActioned={() => {}}
      />,
    );
    submit();
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(getApprovalAssertionMock).not.toHaveBeenCalled();
    expect(respondCalled()).toBe(false);
  });

  it('sends reauthPassword on a critical approve, never replays it, and clears it after submit', async () => {
    const onActioned = vi.fn();
    render(
      <PamRespondModal
        request={requestFixture({ riskTier: 4 })}
        onClose={() => {}}
        onActioned={onActioned}
      />,
    );
    const input = screen.getByTestId('pam-respond-reauth-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'hunter2' } });
    submit();

    await waitFor(() => expect(onActioned).toHaveBeenCalled());
    const body = respondBody();
    expect(body.reauthPassword).toBe('hunter2');
    expect(body.reauthMfaCode).toBeUndefined();
    expect(body.proof).toEqual(proofFixture);
    // A re-auth secret (and the single-use assertion) must never be replayed
    // by fetchWithAuth's refresh-and-retry.
    expect(respondInit().skipUnauthorizedRetry).toBe(true);
    expect(input.value).toBe('');
  });

  it('sends reauthMfaCode (and no password) when the approver switches to an authenticator code', async () => {
    render(
      <PamRespondModal
        request={requestFixture({ riskTier: 4 })}
        onClose={() => {}}
        onActioned={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId('pam-respond-reauth-mode-toggle'));
    const input = screen.getByTestId('pam-respond-reauth-input') as HTMLInputElement;
    expect(input.autocomplete).toBe('one-time-code');
    fireEvent.change(input, { target: { value: '123456' } });
    submit();

    await waitFor(() => expect(respondCalled()).toBe(true));
    const body = respondBody();
    expect(body.reauthMfaCode).toBe('123456');
    expect(body.reauthPassword).toBeUndefined();
  });

  it('defaults a passwordless (SSO) account to the authenticator-code field', () => {
    authState.user = { id: 'u-1', mfaEnabled: true, hasPassword: false };
    render(
      <PamRespondModal
        request={requestFixture({ riskTier: 4 })}
        onClose={() => {}}
        onActioned={() => {}}
      />,
    );
    const input = screen.getByTestId('pam-respond-reauth-input') as HTMLInputElement;
    expect(input.autocomplete).toBe('one-time-code');
    // No password to fall back to — offering the toggle would be a dead end.
    expect(screen.queryByTestId('pam-respond-reauth-mode-toggle')).toBeNull();
  });

  it('does not offer the authenticator-code toggle to a password account with no MFA', () => {
    authState.user = { id: 'u-1', mfaEnabled: false, hasPassword: true };
    render(
      <PamRespondModal
        request={requestFixture({ riskTier: 4 })}
        onClose={() => {}}
        onActioned={() => {}}
      />,
    );
    expect((screen.getByTestId('pam-respond-reauth-input') as HTMLInputElement).type).toBe('password');
    expect(screen.queryByTestId('pam-respond-reauth-mode-toggle')).toBeNull();
  });

  it('explains the dead end for an account with neither a password nor MFA, and still lets the server decide', async () => {
    authState.user = { id: 'u-1', mfaEnabled: false, hasPassword: false };
    render(
      <PamRespondModal
        request={requestFixture({ riskTier: 4 })}
        onClose={() => {}}
        onActioned={() => {}}
      />,
    );
    expect(screen.queryByTestId('pam-respond-reauth-input')).toBeNull();
    expect(screen.getByTestId('pam-respond-reauth-unavailable')).toHaveTextContent(
      /authenticator app/i,
    );
    submit();
    await waitFor(() => expect(respondCalled()).toBe(true));
    expect(respondBody().reauthPassword).toBeUndefined();
    expect(respondBody().reauthMfaCode).toBeUndefined();
  });

  it('shows a wrong-password error inline, clears the field, and does not bounce to /login', async () => {
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse(
        { error: 'Invalid credentials', message: 'Invalid credentials', code: 'invalid_credentials' },
        false,
        401,
      ),
    );
    const onActioned = vi.fn();
    render(
      <PamRespondModal
        request={requestFixture({ riskTier: 4 })}
        onClose={() => {}}
        onActioned={onActioned}
      />,
    );
    const input = screen.getByTestId('pam-respond-reauth-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'wrong' } });
    submit();

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/password or code was not accepted/i),
    );
    expect(input.value).toBe('');
    expect(navigateToMock).not.toHaveBeenCalled();
    expect(onActioned).not.toHaveBeenCalled();
  });

  it('reveals the re-auth fields when the server answers reauth_required for a request not known to be critical', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({ success: false, error: 'reauth_required' }, false, 401),
    );
    render(
      <PamRespondModal
        request={requestFixture({ riskTier: null })}
        onClose={() => {}}
        onActioned={() => {}}
      />,
    );
    expect(screen.queryByTestId('pam-respond-reauth-input')).toBeNull();
    submit();

    await waitFor(() => expect(screen.getByTestId('pam-respond-reauth-input')).toBeInTheDocument());
    expect(screen.getByRole('alert')).toHaveTextContent(/re-enter your password/i);
    expect(navigateToMock).not.toHaveBeenCalled();
  });

  it('surfaces the throttle message on 429', async () => {
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse(
        { error: 'Too many attempts. Please try again later.', message: 'Too many attempts. Please try again later.' },
        false,
        429,
      ),
    );
    render(
      <PamRespondModal
        request={requestFixture({ riskTier: 4 })}
        onClose={() => {}}
        onActioned={() => {}}
      />,
    );
    fireEvent.change(screen.getByTestId('pam-respond-reauth-input'), {
      target: { value: 'hunter2' },
    });
    submit();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/too many attempts/i));
  });

  it('still treats a bare 401 on approve as an expired session', async () => {
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ error: 'Unauthorized' }, false, 401));
    render(
      <PamRespondModal
        request={requestFixture({ riskTier: 2 })}
        onClose={() => {}}
        onActioned={() => {}}
      />,
    );
    submit();
    await waitFor(() => expect(navigateToMock).toHaveBeenCalledWith('/login', { replace: true }));
    // A redirect IS the feedback for an expired session — no error toast on top.
    expect(showToastMock).not.toHaveBeenCalled();
  });

  it('shows a server-rejected approver-device assertion inline instead of redirecting', async () => {
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse({ success: false, error: 'assertion_failed' }, false, 401),
    );
    const onActioned = vi.fn();
    render(
      <PamRespondModal
        request={requestFixture({ riskTier: 2 })}
        onClose={() => {}}
        onActioned={onActioned}
      />,
    );
    submit();
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/approver-device verification was not accepted/i),
    );
    expect(navigateToMock).not.toHaveBeenCalled();
    expect(onActioned).not.toHaveBeenCalled();
  });

  it('drops a typed password when the approver switches to deny', async () => {
    render(
      <PamRespondModal
        request={requestFixture({ riskTier: 4 })}
        onClose={() => {}}
        onActioned={() => {}}
      />,
    );
    fireEvent.change(screen.getByTestId('pam-respond-reauth-input'), {
      target: { value: 'hunter2' },
    });
    fireEvent.click(screen.getByTestId('pam-respond-deny-toggle'));
    submit();
    await waitFor(() => expect(respondCalled()).toBe(true));
    const body = respondBody();
    expect(body.decision).toBe('deny');
    expect(body.reauthPassword).toBeUndefined();
    expect(body.reauthMfaCode).toBeUndefined();
    expect(JSON.stringify(fetchWithAuthMock.mock.calls)).not.toContain('hunter2');
  });

  it('explains an enforced step-up (403 step_up_required) in plain words', async () => {
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse({ success: false, error: 'step_up_required', requiredLevel: 4 }, false, 403),
    );
    render(
      <PamRespondModal
        request={requestFixture({ riskTier: 4 })}
        onClose={() => {}}
        onActioned={() => {}}
      />,
    );
    fireEvent.change(screen.getByTestId('pam-respond-reauth-input'), {
      target: { value: 'hunter2' },
    });
    submit();
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/registered approver device/i),
    );
  });
});
