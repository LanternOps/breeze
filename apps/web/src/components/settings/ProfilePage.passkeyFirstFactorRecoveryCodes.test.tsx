import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * G4-14 (v0.114.0 pass-3 sweep) — registering the FIRST passkey (first-factor
 * enrollment, no prior MFA) has `POST /auth/passkeys/register/verify` return
 * ten one-time recovery codes in `recoveryCodes`, exactly like enabling TOTP
 * does. But nothing ever renders them: ProfilePage stores the codes in state
 * and hands them to `MFASettings` as a prop, and `MFASettings` only draws its
 * recovery-codes panel when its OWN internal `view` state is 'recovery' — a
 * state the passkey flow never puts it in, because that flow lives entirely
 * outside MFASettings. The user ends up enrolled with codes they can never
 * see again — a lockout risk if the authenticator is later lost.
 *
 * This test proves every one of the ten codes lands in the DOM after a
 * first-passkey registration succeeds.
 */

const {
  fetchWithAuthMock,
  createPasskeyCredentialMock,
  commitReissuedSessionIfCurrentMock,
  sessionGeneration,
} = vi.hoisted(() => ({
  fetchWithAuthMock: vi.fn(),
  createPasskeyCredentialMock: vi.fn(),
  commitReissuedSessionIfCurrentMock: vi.fn(() => true),
  sessionGeneration: 3,
}));

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: fetchWithAuthMock,
  createPasskeyCredential: createPasskeyCredentialMock,
  useAuthStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector({ updateUser: vi.fn() }),
    {
      getState: () => ({
        updateUser: vi.fn(),
        sessionGeneration,
        commitReissuedSessionIfCurrent: commitReissuedSessionIfCurrentMock,
      }),
    },
  ),
}));

vi.mock('@/lib/avatarBlobCache', () => ({
  useAvatarBlobUrl: (url: string | null | undefined) => url ?? null,
}));

vi.mock('./ApproverDevicesSection', () => ({ default: () => null }));
vi.mock('./ConnectSsoCard', () => ({ default: () => null }));

import ProfilePage from './ProfilePage';

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

// No prior MFA at all — this is a first-factor enrollment.
const USER = {
  id: 'user-1',
  name: 'Casey Admin',
  email: 'casey@example.com',
  mfaEnabled: false,
  mfaMethod: null,
  hasPassword: true,
};

const registrationOptions = { challenge: 'register-challenge', rp: { name: 'Breeze' } };
const credential = { id: 'credential-1', rawId: 'credential-1', type: 'public-key', response: {} };

const RECOVERY_CODES = [
  'aaaa-1111', 'bbbb-2222', 'cccc-3333', 'dddd-4444', 'eeee-5555',
  'ffff-6666', 'gggg-7777', 'hhhh-8888', 'iiii-9999', 'jjjj-0000',
];

async function addPasskey() {
  await screen.findByLabelText(/Passkey name/i);
  fireEvent.change(screen.getByLabelText(/Passkey name/i), { target: { value: 'iPhone' } });
  fireEvent.change(screen.getByLabelText(/Current password/i, { selector: '#passkey-password' }), {
    target: { value: 'current-password' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Add passkey' }));
}

describe('ProfilePage — first passkey enrollment surfaces its recovery codes (G4-14)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    commitReissuedSessionIfCurrentMock.mockReturnValue(true);
    sessionStorage.clear();
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:fake');
    globalThis.URL.revokeObjectURL = vi.fn();
  });

  it('renders every recovery code returned by register/verify for a first-factor passkey', async () => {
    fetchWithAuthMock
      .mockResolvedValueOnce(makeJsonResponse({ passkeys: [] }))
      .mockResolvedValueOnce(makeJsonResponse({ options: registrationOptions }))
      .mockResolvedValueOnce(makeJsonResponse({
        success: true,
        passkey: { id: 'credential-1', name: 'iPhone' },
        recoveryCodes: RECOVERY_CODES,
      }))
      .mockResolvedValueOnce(makeJsonResponse({ passkeys: [{ id: 'credential-1', name: 'iPhone', lastUsedAt: null }] }));
    createPasskeyCredentialMock.mockResolvedValueOnce(credential);

    render(<ProfilePage initialUser={USER} />);
    await addPasskey();

    await waitFor(() => {
      for (const code of RECOVERY_CODES) {
        expect(screen.getByText(code)).toBeTruthy();
      }
    });
  });

  it('does not render a stale recovery panel when a SECOND passkey is added (no codes returned)', async () => {
    // Second-factor adds go through an existing-factor step-up round trip
    // before register/options is even attempted (SR2-20) — exercising that
    // whole path here would just be a duplicate of ProfilePage.passkeyStepUp
    // .test.tsx. What's actually new to verify for G4-14 is narrower: the
    // MFASettings panel this fix touches must NOT auto-open when the
    // `recoveryCodes` prop is absent, even though `mfaMethod` is already
    // 'passkey' (the case a second passkey add leaves it in, since
    // register/verify returns no codes for it). Test that contract directly.
    const { default: MFASettings } = await import('./MFASettings');
    const { rerender } = render(
      <MFASettings enabled mfaMethod="passkey" hasPassword recoveryCodes={undefined} />,
    );
    expect(await screen.findByText('Multi-factor authentication')).toBeTruthy();
    for (const code of RECOVERY_CODES) expect(screen.queryByText(code)).toBeNull();

    // Codes already present on first render (a remount after they were shown)
    // must not re-open the panel either — the effect is keyed on a NEW array.
    rerender(<MFASettings enabled mfaMethod="passkey" hasPassword recoveryCodes={RECOVERY_CODES} />);
    await waitFor(() => expect(screen.getByText(RECOVERY_CODES[0])).toBeTruthy());
    // Same identity again: nothing new, panel state untouched (still open).
    rerender(<MFASettings enabled mfaMethod="passkey" hasPassword recoveryCodes={RECOVERY_CODES} />);
    expect(screen.getByText(RECOVERY_CODES[0])).toBeTruthy();
  });

  it('does not swallow codes that arrive before the panel is ready to show them', async () => {
    // Review of the first fix: the effect updated its "last seen" ref even when
    // the guard failed, so codes that landed while `currentMethod` (or `view`)
    // was not yet in the passkey/status state were remembered as shown and
    // never rendered. The ref must only advance when the panel actually opens.
    const { default: MFASettings } = await import('./MFASettings');
    const { rerender } = render(
      <MFASettings enabled mfaMethod="totp" hasPassword recoveryCodes={undefined} />,
    );
    expect(await screen.findByText('Multi-factor authentication')).toBeTruthy();
    // Codes arrive while the method still reads as totp: guard fails, nothing shown.
    rerender(<MFASettings enabled mfaMethod="totp" hasPassword recoveryCodes={RECOVERY_CODES} />);
    expect(screen.queryByText(RECOVERY_CODES[0])).toBeNull();
    // The method catches up with the same codes: they must show now.
    rerender(<MFASettings enabled mfaMethod="passkey" hasPassword recoveryCodes={RECOVERY_CODES} />);
    await waitFor(() => expect(screen.getByText(RECOVERY_CODES[0])).toBeTruthy());
  });
});
