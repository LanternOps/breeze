import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchWithAuthMock, createPasskeyCredentialMock, mintStepUpGrantMock } = vi.hoisted(() => ({
  fetchWithAuthMock: vi.fn(),
  createPasskeyCredentialMock: vi.fn(),
  mintStepUpGrantMock: vi.fn(),
}));

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: fetchWithAuthMock,
  createPasskeyCredential: createPasskeyCredentialMock,
  useAuthStore: Object.assign(
    (selector: any) => selector({ updateUser: vi.fn() }),
    { getState: () => ({ updateUser: vi.fn(), sessionGeneration: 0, commitReissuedSessionIfCurrent: vi.fn(() => true) }) },
  ),
}));

vi.mock('@/lib/avatarBlobCache', () => ({
  useAvatarBlobUrl: (url: string | null | undefined) => url ?? null,
}));

// See ProfilePage.passkeys.test.tsx: stubbed so it doesn't consume from this
// file's ordered/URL-matched fetchWithAuth mock.
vi.mock('./ApproverDevicesSection', () => ({
  default: () => null,
}));

vi.mock('./ConnectSsoCard', () => ({
  default: () => null,
}));

// SR2-20 step-up mint, mocked exactly like MaintenanceModeDialog.test.tsx so
// the TOTP-tier reauth call can be asserted independently of the passkey
// options/verify round-trip.
vi.mock('../../lib/mfaStepUp', () => ({
  mintStepUpGrant: mintStepUpGrantMock,
  StepUpMintError: class StepUpMintError extends Error {
    constructor(readonly code: string, message: string, readonly status?: number, readonly responseCode?: string) {
      super(message);
      this.name = 'StepUpMintError';
    }
  },
}));

import ProfilePage from './ProfilePage';

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

const REAL_LOCATION = window.location;

describe('ProfilePage passkey existing-factor step-up (sweep G4-7)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, 'location', { configurable: true, value: REAL_LOCATION });
    sessionStorage.clear();
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:fake');
    globalThis.URL.revokeObjectURL = vi.fn();
  });

  const REGISTRATION_OPTIONS = {
    challenge: 'register-challenge',
    rp: { name: 'Breeze' },
    user: { id: 'user-1', name: 'casey@example.com', displayName: 'Casey Admin' },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
  };
  const CREDENTIAL = {
    id: 'credential-1',
    rawId: 'credential-1',
    type: 'public-key',
    response: { attestationObject: 'attestation', clientDataJSON: 'client-data' },
  };

  // An account that already has TOTP enabled, adding its FIRST passkey.
  const mfaProtectedUser = {
    id: 'user-1',
    name: 'Casey Admin',
    email: 'casey@example.com',
    mfaEnabled: true,
    mfaMethod: 'totp',
  };

  function callsTo(url: string) {
    return fetchWithAuthMock.mock.calls.filter(([u]) => String(u) === url);
  }

  it('completes registration by minting an existing-factor step-up grant instead of dead-ending on the raw 403', async () => {
    const STEP_UP_GRANT = 'a1e6c9c0-9e2b-4a2b-8e2c-6c9c0e9e2b4a';
    let optionsCallCount = 0;

    fetchWithAuthMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u === '/auth/passkeys') return makeJsonResponse({ passkeys: [] });
      if (u === '/auth/passkeys/register/options') {
        optionsCallCount += 1;
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        if (optionsCallCount === 1) {
          // First attempt carries no grant: the account is already
          // MFA-protected, so the server demands a fresh existing-factor
          // step-up before it will validate a factor-addition request.
          expect(body.stepUpGrantId).toBeUndefined();
          return makeJsonResponse({ error: 'existing_factor_step_up_required', stepUpUrl: '/auth/mfa/step-up' }, false, 403);
        }
        // Second attempt must carry the SAME grant id the mint returned.
        expect(body.stepUpGrantId).toBe(STEP_UP_GRANT);
        return makeJsonResponse({ options: REGISTRATION_OPTIONS });
      }
      if (u === '/auth/passkeys/register/verify') {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        expect(body.stepUpGrantId).toBe(STEP_UP_GRANT);
        return makeJsonResponse({
          passkey: { id: 'credential-1', name: 'YubiKey' },
          tokens: { accessToken: 'reissued-access-token', expiresInSeconds: 900 },
        });
      }
      return makeJsonResponse({});
    });
    createPasskeyCredentialMock.mockResolvedValueOnce(CREDENTIAL);
    mintStepUpGrantMock.mockResolvedValueOnce(STEP_UP_GRANT);

    render(<ProfilePage initialUser={mfaProtectedUser} />);

    await screen.findByText(/No passkeys are registered/i);
    fireEvent.change(screen.getByLabelText(/Passkey name/i), { target: { value: 'YubiKey' } });
    fireEvent.change(screen.getByLabelText(/Current password/i, { selector: '#passkey-password' }), {
      target: { value: 'current-password' },
    });
    fireEvent.click(screen.getByTestId('passkey-add'));

    // The step-up prompt must appear...
    const code = await screen.findByTestId('passkey-stepup-code');
    // ...and the raw enum must NEVER be rendered anywhere on the page.
    expect(screen.queryByText(/existing_factor_step_up_required/i)).toBeNull();
    expect(document.body.textContent).not.toMatch(/existing_factor_step_up_required/);

    fireEvent.change(code, { target: { value: '123456' } });
    fireEvent.click(screen.getByTestId('passkey-add'));

    await screen.findByText('Passkey added');

    expect(mintStepUpGrantMock).toHaveBeenCalledWith({
      operation: 'add_factor',
      reauth: { method: 'totp', code: '123456' },
    });
    expect(callsTo('/auth/passkeys/register/options')).toHaveLength(2);
    expect(callsTo('/auth/passkeys/register/verify')).toHaveLength(1);
    expect(screen.queryByText(/existing_factor_step_up_required/i)).toBeNull();
  });

  it('never sends the passkey registration request without first resolving the step-up when required', async () => {
    fetchWithAuthMock.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u === '/auth/passkeys') return makeJsonResponse({ passkeys: [] });
      if (u === '/auth/passkeys/register/options') {
        return makeJsonResponse({ error: 'existing_factor_step_up_required', stepUpUrl: '/auth/mfa/step-up' }, false, 403);
      }
      return makeJsonResponse({});
    });

    render(<ProfilePage initialUser={mfaProtectedUser} />);

    await screen.findByText(/No passkeys are registered/i);
    fireEvent.change(screen.getByLabelText(/Passkey name/i), { target: { value: 'YubiKey' } });
    fireEvent.change(screen.getByLabelText(/Current password/i, { selector: '#passkey-password' }), {
      target: { value: 'current-password' },
    });
    fireEvent.click(screen.getByTestId('passkey-add'));

    await screen.findByTestId('passkey-stepup-code');
    expect(document.body.textContent).not.toMatch(/existing_factor_step_up_required/);
    expect(createPasskeyCredentialMock).not.toHaveBeenCalled();
    expect(mintStepUpGrantMock).not.toHaveBeenCalled();
  });
});
