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

/** The respond route's 200 for a decision recorded as asked (routes/pam.ts). */
function respondRecordsRequestedDecision() {
  fetchWithAuthMock.mockImplementation(async (_url: string, init?: RequestInit) => {
    const approve = JSON.parse(String(init?.body ?? '{}')).decision === 'approve';
    return makeJsonResponse({
      success: true,
      id: 'er-9',
      status: approve ? 'approved' : 'denied',
      enforcementStatus: approve ? 'pending_dispatch' : 'cleanup_pending',
    });
  });
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
    respondRecordsRequestedDecision();
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
    respondRecordsRequestedDecision();
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
      expect(screen.getByRole('alert')).toHaveTextContent(/approver device/i),
    );
    // Same message and action the approvals inbox shows for a missing device.
    expect(screen.getByRole('alert')).toHaveTextContent('Register an approver device in your profile, then try again.');
    expect(screen.getByRole('alert')).not.toHaveTextContent('step_up_required');
    const link = screen.getByTestId('register-approver-device-link');
    expect(link).toHaveAttribute('href', '/settings/profile');
    expect(link).toHaveTextContent('Register device');
  });

  it('does not offer the register-device action for other errors', async () => {
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse({ success: false, error: 'Request is not pending' }, false, 400),
    );
    render(<PamRespondModal request={requestFixture()} onClose={() => {}} onActioned={() => {}} />);
    submit();
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.queryByTestId('register-approver-device-link')).toBeNull();
  });
});

// Pre-release sweep (v0.118.2 → main): the respond route answers HTTP 200
// `{ success: true }` even when the decision it recorded is NOT the one asked
// for. An approve whose target executable hash cannot be verified is refused
// server-side (services/pamActuationLifecycle.ts): the row is flipped to
// `denied` and the body carries `status: 'denied'`, `enforcementStatus:
// 'refused'` and the reason. The modal used to toast "Elevation approved" for
// it because it never read the body.
describe('PamRespondModal non-success outcomes on a 200', () => {
  const REFUSAL_REASON = 'Target identity could not be verified on the device; re-request elevation.';

  beforeEach(() => {
    vi.clearAllMocks();
    authState.user = { id: 'u-1', mfaEnabled: true, hasPassword: true };
    getApprovalAssertionMock.mockResolvedValue(proofFixture);
  });

  function approveCritical() {
    fireEvent.change(screen.getByTestId('pam-respond-reauth-input'), {
      target: { value: 'hunter2' },
    });
    submit();
  }

  it('shows a refused approve as an error inline and in a toast, never as "Elevation approved"', async () => {
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse({
        success: true,
        id: 'er-9',
        status: 'denied',
        enforcementStatus: 'refused',
        reason: REFUSAL_REASON,
      }),
    );
    const onActioned = vi.fn();
    render(
      <PamRespondModal
        request={requestFixture({ riskTier: 4 })}
        onClose={() => {}}
        onActioned={onActioned}
      />,
    );
    approveCritical();

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(REFUSAL_REASON));
    expect(showToastMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', message: expect.stringContaining(REFUSAL_REASON) }),
    );
    expect(showToastMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
    expect(showToastMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Elevation approved' }),
    );
    // The modal stays open on the error; the request is no longer pending, so
    // a second approve would only 409.
    expect(onActioned).not.toHaveBeenCalled();
    expect(screen.getByTestId('pam-respond-submit')).toBeDisabled();
  });

  it('refreshes the list when a refused modal is dismissed, so the row shows as denied', async () => {
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse({
        success: true,
        id: 'er-9',
        status: 'denied',
        enforcementStatus: 'refused',
        reason: REFUSAL_REASON,
      }),
    );
    const onActioned = vi.fn();
    const onClose = vi.fn();
    render(
      <PamRespondModal
        request={requestFixture({ riskTier: 4 })}
        onClose={onClose}
        onActioned={onActioned}
      />,
    );
    approveCritical();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(REFUSAL_REASON));

    fireEvent.click(screen.getByTestId('pam-respond-cancel'));
    expect(onActioned).toHaveBeenCalledTimes(1);
  });

  it('treats a 200 approve whose recorded status is not "approved" as not approved, even with no reason', async () => {
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse({ success: true, id: 'er-9', status: 'denied' }),
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
      expect(screen.getByRole('alert')).toHaveTextContent(/did not confirm this elevation as approved/i),
    );
    expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
    expect(showToastMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
    expect(onActioned).not.toHaveBeenCalled();
  });

  // An approval gate must not claim "approved" on a 200 it cannot read as one
  // (no `status`, or a body that is not JSON at all).
  it.each([
    ['names no status', { success: true }],
    ['is not JSON', null],
  ])('does not report an approve as approved when the 200 body %s', async (_label, payload) => {
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse(payload));
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
      expect(screen.getByRole('alert')).toHaveTextContent(/did not confirm this elevation as approved/i),
    );
    expect(showToastMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
    expect(onActioned).not.toHaveBeenCalled();
  });

  it('still reports a dispatched approve as approved', async () => {
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse({
        success: true,
        id: 'er-9',
        status: 'approved',
        enforcementStatus: 'pending_dispatch',
      }),
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

    await waitFor(() => expect(onActioned).toHaveBeenCalledTimes(1));
    expect(showToastMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', message: 'Elevation approved' }),
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('still reports a deny as denied (status "denied" is the requested outcome there)', async () => {
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse({
        success: true,
        id: 'er-9',
        status: 'denied',
        enforcementStatus: 'cleanup_pending',
      }),
    );
    const onActioned = vi.fn();
    render(
      <PamRespondModal request={requestFixture()} onClose={() => {}} onActioned={onActioned} />,
    );
    fireEvent.click(screen.getByTestId('pam-respond-deny-toggle'));
    submit();

    await waitFor(() => expect(onActioned).toHaveBeenCalledTimes(1));
    expect(showToastMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', message: 'Elevation denied' }),
    );
    expect(showToastMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });
});
