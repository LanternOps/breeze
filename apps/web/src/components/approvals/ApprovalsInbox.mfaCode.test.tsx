import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ApprovalsInbox from './ApprovalsInbox';
import { ActionError } from '@/lib/runAction';
import { fetchWithAuth } from '../../stores/auth';

/**
 * An approve refused because the session has no second factor offers a field
 * for a code from the approver's authenticator app. The server verifies the
 * code (once) and counts it as the decision's second factor; the inbox only
 * forwards it with that one approve. A deny never asks for a code, and a
 * batch takes none.
 */

const intentApprovalsMock = vi.hoisted(() => ({ decide: vi.fn() }));
const authState = vi.hoisted(() => ({
  user: null as null | { mfaEnabled: boolean; mfaMethod: string | null; totpEnrolled?: boolean },
}));
const refreshProfileMock = vi.hoisted(() => vi.fn(async () => undefined));
const navigateToMock = vi.hoisted(() => vi.fn());
const authenticatorMock = vi.hoisted(() => ({
  getApprovalAssertion: vi.fn(),
  getBatchApprovalAssertion: vi.fn(),
}));

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  registerOrgIdProvider: vi.fn(),
  useAuthStore: Object.assign((select: (state: typeof authState) => unknown) => select(authState), {
    getState: () => authState,
  }),
  fetchAndApplyPreferences: refreshProfileMock,
}));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('../../stores/authenticator', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../stores/authenticator')>()),
  ...authenticatorMock,
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: navigateToMock }));
vi.mock('@/hooks/useEventStream', () => ({
  useEventStream: () => ({ connected: true, subscribe: vi.fn(), unsubscribe: vi.fn() }),
}));
vi.mock('../../stores/featuresStore', () => ({
  useAiAgentsPolicyDecideGate: () => ({ enabled: false, loaded: true }),
}));
vi.mock('@/lib/permissions', () => ({
  usePermissions: () => ({ permissions: [], can: () => true }),
}));
vi.mock('@/lib/intentApprovals', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/intentApprovals')>();
  return {
    ...actual,
    decideIntentApproval: (...args: unknown[]) => intentApprovalsMock.decide(...args),
  };
});

const fetchMock = vi.mocked(fetchWithAuth);
const response = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const pendingApproval = {
  id: 'approval-1',
  requestingClientLabel: 'Helpdesk Copilot',
  requestingMachineLabel: 'TECH-LAPTOP',
  actionLabel: 'Restart accounting server',
  actionToolName: 'restart_device',
  actionArguments: {},
  riskTier: 'high',
  riskSummary: 'Interrupts active sessions',
  customerTenant: null,
  status: 'pending',
  expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
  decidedAt: null,
  decisionReason: null,
  executionId: null,
  intentId: 'intent-1',
  approvalScope: 'four_eyes',
  isRecursive: false,
  createdAt: '2026-08-23T12:00:00.000Z',
  origin: 'human',
  agentName: null,
  orgId: 'org-1',
  orgName: 'Acme Dental',
  action: null,
  targetDevice: null,
};

const agentCard = (id: string) => ({
  ...pendingApproval,
  id,
  intentId: `intent-${id}`,
  origin: 'ai_agent',
  agentName: 'Patch Sweep',
  approvalScope: 'supervised',
  actionToolName: 'manage_patches',
  action: 'install',
  actionArguments: { action: 'install' },
  targetDevice: { id: `device-${id}`, hostname: `HOST-${id}` },
});
const GROUP_KEY = 'org-1--manage_patches--install';

const MFA_REQUIRED = () =>
  new ActionError('MFA required', 403, 'MFA_REQUIRED', { error: 'MFA required', code: 'MFA_REQUIRED' });
const CODE_REFUSED = () =>
  new ActionError('Invalid credentials', 401, 'invalid_credentials', {
    error: 'Invalid credentials',
    message: 'Invalid credentials',
    code: 'invalid_credentials',
  });

/** Approve once, get MFA_REQUIRED, and return the code field that appears. */
async function reachCodeEntry(): Promise<HTMLInputElement> {
  render(<ApprovalsInbox />);
  await screen.findByTestId('approval-row-approval-1');
  intentApprovalsMock.decide.mockRejectedValueOnce(MFA_REQUIRED());
  fireEvent.click(screen.getByTestId('approval-approve-approval-1'));
  return (await screen.findByTestId('approval-mfa-code-approval-1')) as HTMLInputElement;
}

/** The decide stub sends the code (as the real helper does when its POST goes out), then fails. */
function sendCodeThenReject(err: unknown) {
  intentApprovalsMock.decide.mockImplementationOnce(async (...args: unknown[]) => {
    (args[4] as { onCodeSent?: () => void } | undefined)?.onCodeSent?.();
    throw err;
  });
}

function approveWith(code: string) {
  fireEvent.change(screen.getByTestId('approval-mfa-code-approval-1'), { target: { value: code } });
  fireEvent.click(screen.getByTestId('approval-approve-approval-1'));
}

beforeEach(() => {
  vi.clearAllMocks();
  refreshProfileMock.mockReset();
  refreshProfileMock.mockResolvedValue(undefined);
  authState.user = { mfaEnabled: true, mfaMethod: 'totp' };
  intentApprovalsMock.decide.mockResolvedValue('decided');
  authenticatorMock.getApprovalAssertion.mockResolvedValue({ type: 'webauthn_platform', credentialId: 'c' });
  authenticatorMock.getBatchApprovalAssertion.mockResolvedValue({ type: 'webauthn_platform', credentialId: 'c' });
  fetchMock.mockResolvedValue(response({ approvals: [pendingApproval], nextCursor: null }));
});

describe('ApprovalsInbox — authenticator code after a second-factor refusal', () => {
  it('offers no code field until the server asks for a second factor', async () => {
    render(<ApprovalsInbox />);
    await screen.findByTestId('approval-row-approval-1');
    expect(screen.queryByTestId('approval-mfa-code-approval-1')).toBeNull();
  });

  it('refused → enter a code → approve again with it → approved', async () => {
    const field = await reachCodeEntry();
    expect(screen.getByTestId('approval-error-approval-1')).toHaveTextContent(/authenticator app/i);
    expect(field).toHaveAttribute('autocomplete', 'one-time-code');
    // Nothing to send yet: the approve waits for a code.
    expect(screen.getByTestId('approval-approve-approval-1')).toBeDisabled();

    approveWith('123456');

    await waitFor(() => expect(intentApprovalsMock.decide).toHaveBeenCalledTimes(2));
    expect(intentApprovalsMock.decide).toHaveBeenLastCalledWith(
      'approval-1',
      'approve',
      undefined,
      'four_eyes',
      expect.objectContaining({ mfaCode: '123456', silentSuccess: true }),
    );
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(1));
    expect(navigateToMock).not.toHaveBeenCalled();
  });

  it('clears the field after the code is used, whatever the answer', async () => {
    await reachCodeEntry();
    sendCodeThenReject(CODE_REFUSED());

    approveWith('123456');

    await screen.findByText(/each code works once/i);
    expect((screen.getByTestId('approval-mfa-code-approval-1') as HTMLInputElement).value).toBe('');
  });

  it('a refused code says each code works once, keeps the field, and does not sign the user out', async () => {
    await reachCodeEntry();
    sendCodeThenReject(CODE_REFUSED());

    approveWith('000000');

    const error = await screen.findByTestId('approval-error-approval-1');
    await waitFor(() => expect(error).toHaveTextContent(/each code works once/i));
    expect(error).toHaveTextContent(/wait for the next code/i);
    expect(screen.getByTestId('approval-mfa-code-approval-1')).toBeInTheDocument();
    expect(navigateToMock).not.toHaveBeenCalled();
  });

  it('a code that was accepted before another refusal is reported as used', async () => {
    await reachCodeEntry();
    sendCodeThenReject(new ActionError('Failed', 500, undefined, { error: 'internal' }));

    approveWith('123456');

    const spent = await screen.findByTestId('approval-mfa-code-spent-approval-1');
    expect(spent).toHaveTextContent(/has been used/i);
    expect(spent).toHaveTextContent(/next code/i);
  });

  it('too many codes: says to wait', async () => {
    await reachCodeEntry();
    sendCodeThenReject(
      new ActionError('Too many', 429, 'mfa_check_throttled', {
        error: 'Too many', message: 'Too many', code: 'mfa_check_throttled', retryAfter: 120,
      }),
    );

    approveWith('123456');

    const error = await screen.findByTestId('approval-error-approval-1');
    await waitFor(() => expect(error).toHaveTextContent(/wait a few minutes/i));
  });

  it('a policy that does not allow codes says to sign in again instead', async () => {
    await reachCodeEntry();
    sendCodeThenReject(
      new ActionError('This MFA method is not permitted', 403, 'mfa_method_not_permitted', {
        error: 'This MFA method is not permitted',
        message: 'This MFA method is not permitted',
        code: 'mfa_method_not_permitted',
      }),
    );

    approveWith('123456');

    const error = await screen.findByTestId('approval-error-approval-1');
    await waitFor(() => expect(error).toHaveTextContent(/doesn't allow authenticator codes/i));
  });
});

describe('ApprovalsInbox — what a code attempt reports', () => {
  it('a decide refusal after the code was checked keeps its own copy and marks the code used', async () => {
    await reachCodeEntry();
    sendCodeThenReject(
      new ActionError('Forbidden', 403, undefined, { error: 'site_ceiling', message: 'Org-wide authority.' }),
    );

    approveWith('123456');

    const error = await screen.findByTestId('approval-error-approval-1');
    await waitFor(() => expect(error).toHaveTextContent(/another approver needs to decide it/i));
    expect(error).not.toHaveTextContent(/doesn't allow authenticator codes/i);
    expect(await screen.findByTestId('approval-mfa-code-spent-approval-1')).toBeInTheDocument();
  });

  it('a rate limit that is not the code check is not reported as too many codes', async () => {
    await reachCodeEntry();
    sendCodeThenReject(new ActionError('Too many requests', 429, undefined, { error: 'Too many requests' }));

    approveWith('123456');

    const error = await screen.findByTestId('approval-error-approval-1');
    await waitFor(() => expect(error).toHaveTextContent(/could not be submitted/i));
    expect(error).not.toHaveTextContent(/too many codes/i);
  });

  it('a cancelled passkey check never sent the code: it is kept and not marked used', async () => {
    await reachCodeEntry();
    const { CeremonyError } = await import('@/lib/intentApprovals');
    intentApprovalsMock.decide.mockRejectedValueOnce(new CeremonyError(new Error('cancelled')));

    approveWith('123456');

    const error = await screen.findByTestId('approval-error-approval-1');
    await waitFor(() => expect(error).toHaveTextContent(/verification was canceled/i));
    expect((screen.getByTestId('approval-mfa-code-approval-1') as HTMLInputElement).value).toBe('123456');
    expect(screen.queryByTestId('approval-mfa-code-spent-approval-1')).toBeNull();
  });

  it('a step-up refusal after the code was sent marks the code used', async () => {
    await reachCodeEntry();
    intentApprovalsMock.decide.mockImplementationOnce(async (...args: unknown[]) => {
      (args[4] as { onCodeSent?: () => void }).onCodeSent?.();
      return 'needs_device';
    });

    approveWith('123456');

    expect(await screen.findByTestId('approval-mfa-code-spent-approval-1')).toBeInTheDocument();
    expect(screen.getByTestId('approval-error-approval-1')).toHaveTextContent(/approver device/i);
  });

  it('a PAM refusal for the request\'s site has its own terminal copy', async () => {
    render(<ApprovalsInbox />);
    await screen.findByTestId('approval-row-approval-1');
    intentApprovalsMock.decide.mockRejectedValueOnce(
      new ActionError('Forbidden', 403, undefined, { error: 'site_access_denied' }),
    );
    fireEvent.click(screen.getByTestId('approval-approve-approval-1'));

    const error = await screen.findByTestId('approval-error-approval-1');
    await waitFor(() => expect(error).toHaveTextContent(/does not include this request's site/i));
  });
});

describe('ApprovalsInbox — an account with no authenticator app', () => {
  it('offers no code field and says how to get a second factor instead', async () => {
    authState.user = { mfaEnabled: false, mfaMethod: null };
    render(<ApprovalsInbox />);
    await screen.findByTestId('approval-row-approval-1');
    intentApprovalsMock.decide.mockRejectedValueOnce(MFA_REQUIRED());

    fireEvent.click(screen.getByTestId('approval-approve-approval-1'));

    const error = await screen.findByTestId('approval-error-approval-1');
    await waitFor(() => expect(error).toHaveTextContent(/set up an authenticator app/i));
    expect(screen.queryByTestId('approval-mfa-code-approval-1')).toBeNull();
    expect(screen.getByTestId('approval-approve-approval-1')).not.toBeDisabled();
  });

  it('a passkey-primary account the server says has no authenticator app: no field, says how to get one', async () => {
    authState.user = { mfaEnabled: true, mfaMethod: 'passkey', totpEnrolled: false };
    render(<ApprovalsInbox />);
    await screen.findByTestId('approval-row-approval-1');
    intentApprovalsMock.decide.mockRejectedValueOnce(MFA_REQUIRED());

    fireEvent.click(screen.getByTestId('approval-approve-approval-1'));

    const error = await screen.findByTestId('approval-error-approval-1');
    await waitFor(() => expect(error).toHaveTextContent(/set up an authenticator app/i));
    // The refusal re-reads the profile once; it still says no authenticator app.
    await waitFor(() => expect(refreshProfileMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('approval-mfa-code-approval-1')).toBeNull();
    expect(error).toHaveTextContent(/set up an authenticator app/i);
  });

  it('an authenticator app added since the session was stored: the refusal re-reads the profile and offers the field', async () => {
    authState.user = { mfaEnabled: true, mfaMethod: 'passkey', totpEnrolled: false };
    refreshProfileMock.mockImplementationOnce(async () => {
      authState.user = { mfaEnabled: true, mfaMethod: 'passkey', totpEnrolled: true };
    });
    render(<ApprovalsInbox />);
    await screen.findByTestId('approval-row-approval-1');
    intentApprovalsMock.decide.mockRejectedValueOnce(MFA_REQUIRED());

    fireEvent.click(screen.getByTestId('approval-approve-approval-1'));

    expect(await screen.findByTestId('approval-mfa-code-approval-1')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId('approval-error-approval-1')).toHaveTextContent(/enter the code below/i),
    );
  });

  it('a passkey-primary account with an authenticator-app backup is offered the field', async () => {
    authState.user = { mfaEnabled: true, mfaMethod: 'passkey', totpEnrolled: true };
    render(<ApprovalsInbox />);
    await screen.findByTestId('approval-row-approval-1');
    intentApprovalsMock.decide.mockRejectedValueOnce(MFA_REQUIRED());

    fireEvent.click(screen.getByTestId('approval-approve-approval-1'));

    expect(await screen.findByTestId('approval-mfa-code-approval-1')).toBeInTheDocument();
  });

  it('a passkey-primary account not yet known: asks the server, offers no field while it does not say yes', async () => {
    authState.user = { mfaEnabled: true, mfaMethod: 'passkey' };
    render(<ApprovalsInbox />);
    await screen.findByTestId('approval-row-approval-1');
    await waitFor(() => expect(refreshProfileMock).toHaveBeenCalledTimes(1));
    intentApprovalsMock.decide.mockRejectedValueOnce(MFA_REQUIRED());

    fireEvent.click(screen.getByTestId('approval-approve-approval-1'));

    await screen.findByTestId('approval-error-approval-1');
    // Once on mount, once more for the refusal; the profile still does not say.
    await waitFor(() => expect(refreshProfileMock).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId('approval-mfa-code-approval-1')).toBeNull();
  });

  it('a TOTP-primary account does not ask the server again', async () => {
    render(<ApprovalsInbox />);
    await screen.findByTestId('approval-row-approval-1');
    expect(refreshProfileMock).not.toHaveBeenCalled();
  });

  it('an SMS-primary account is not offered a code field', async () => {
    authState.user = { mfaEnabled: true, mfaMethod: 'sms' };
    render(<ApprovalsInbox />);
    await screen.findByTestId('approval-row-approval-1');
    intentApprovalsMock.decide.mockRejectedValueOnce(MFA_REQUIRED());

    fireEvent.click(screen.getByTestId('approval-approve-approval-1'));

    await screen.findByTestId('approval-error-approval-1');
    expect(screen.queryByTestId('approval-mfa-code-approval-1')).toBeNull();
  });
});

describe('ApprovalsInbox — a deny never asks for a code', () => {
  it('denies straight away, with no code field and no code sent', async () => {
    render(<ApprovalsInbox />);
    await screen.findByTestId('approval-row-approval-1');

    fireEvent.click(screen.getByTestId('approval-deny-approval-1'));
    fireEvent.click(screen.getByTestId('approval-deny-confirm-approval-1'));

    await waitFor(() =>
      expect(intentApprovalsMock.decide).toHaveBeenCalledWith('approval-1', 'deny', undefined),
    );
    expect(intentApprovalsMock.decide.mock.calls[0]).toHaveLength(3);
    expect(screen.queryByTestId('approval-mfa-code-approval-1')).toBeNull();
  });

  it('a code typed for an approve is never sent with a deny of the same request', async () => {
    await reachCodeEntry();
    fireEvent.change(screen.getByTestId('approval-mfa-code-approval-1'), { target: { value: '123456' } });

    fireEvent.click(screen.getByTestId('approval-deny-approval-1'));
    fireEvent.click(screen.getByTestId('approval-deny-confirm-approval-1'));

    await waitFor(() =>
      expect(intentApprovalsMock.decide).toHaveBeenLastCalledWith('approval-1', 'deny', undefined),
    );
    expect(intentApprovalsMock.decide.mock.calls.at(-1)).toHaveLength(3);
  });
});

describe('ApprovalsInbox — a batch takes no code', () => {
  it('a whole-batch second-factor refusal says to approve each request on its own', async () => {
    fetchMock.mockImplementation((async (url: string) => {
      if (String(url).includes('/batch/decide')) {
        return response({ error: 'MFA required', code: 'MFA_REQUIRED' }, false, 403);
      }
      return response({ approvals: [agentCard('ap-a'), agentCard('ap-b')], nextCursor: null });
    }) as unknown as typeof fetchWithAuth);
    render(<ApprovalsInbox />);
    await screen.findByTestId(`approval-group-${GROUP_KEY}`);

    fireEvent.click(screen.getByTestId(`approval-group-approve-${GROUP_KEY}`));

    const error = await screen.findByTestId(`approval-group-error-${GROUP_KEY}`);
    expect(error).toHaveTextContent(/approve each request on its own/i);
    expect(error).toHaveTextContent(/authenticator app/i);
    expect(screen.queryByTestId('approval-mfa-code-ap-a')).toBeNull();
    expect(screen.queryByTestId('approval-mfa-code-ap-b')).toBeNull();
  });

  it('a batch challenge refused for the second factor is not reported as a failed verification', async () => {
    const { AssertionChallengeError } = await import('../../stores/authenticator');
    authenticatorMock.getBatchApprovalAssertion.mockRejectedValue(
      new AssertionChallengeError('MFA required', 403, 'MFA required', undefined, 'MFA_REQUIRED'),
    );
    fetchMock.mockResolvedValue(response({ approvals: [agentCard('ap-a'), agentCard('ap-b')], nextCursor: null }));
    render(<ApprovalsInbox />);
    await screen.findByTestId(`approval-group-${GROUP_KEY}`);

    fireEvent.click(screen.getByTestId(`approval-group-approve-${GROUP_KEY}`));

    const error = await screen.findByTestId(`approval-group-error-${GROUP_KEY}`);
    expect(error).toHaveTextContent(/approve each request on its own/i);
    expect(error).not.toHaveTextContent(/verification was canceled/i);
  });
});
