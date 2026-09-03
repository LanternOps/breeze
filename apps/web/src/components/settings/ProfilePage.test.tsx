import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ProfilePage from './ProfilePage';
import { fetchWithAuth } from '../../stores/auth';
import { SSO_REAUTH_INTENT_KEY, stashSsoReauthIntent } from '@/lib/ssoReauthIntent';
import { writeDensity, writeFontPreference, writeThemePreference, writeTimeFormatPreference } from '@/lib/appearance';

vi.mock('../../stores/auth', () => ({
  createPasskeyCredential: vi.fn(),
  fetchWithAuth: vi.fn(),
  useAuthStore: Object.assign(
    (selector: any) => selector({ updateUser: vi.fn() }),
    { getState: () => ({ updateUser: vi.fn(), sessionGeneration: 0, commitReissuedSessionIfCurrent: vi.fn(() => true) }) }
  )
}));

// #4018: the SSO re-auth callback's `?ssoReauthError=` codes surface as toasts, and
// runAction toasts its own failures. Mocked here (this component and runAction
// resolve to the SAME Toast module) so the assertions are on the call rather
// than on a container these tests never mount.
const { showToastMock } = vi.hoisted(() => ({ showToastMock: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: showToastMock }));

// The avatar blob hook fetches /api/v1/users/<id>/avatar through fetchWithAuth
// when an avatarUrl is present. The tests below are about the upload/delete
// flow on /users/me/avatar; mocking the hook keeps the fetch mock consumption
// order deterministic.
vi.mock('@/lib/avatarBlobCache', () => ({
  useAvatarBlobUrl: (url: string | null | undefined) => url ?? null,
}));

// Approval-security section loads approver devices on mount; stub it so it
// doesn't touch this file's fetch mock. Covered by ApproverDevicesSection.test.tsx.
vi.mock('./ApproverDevicesSection', () => ({
  default: () => null,
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload)
  }) as unknown as Response;

function installLocalStorageStub() {
  const values = new Map<string, string>();
  const storage = {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      values.delete(key);
    }),
    clear: vi.fn(() => {
      values.clear();
    }),
  };
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: storage,
  });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: storage,
  });
}

// Stub URL.createObjectURL / revokeObjectURL — jsdom doesn't provide them by
// default, and the component calls them when a file is selected for preview.
beforeEach(() => {
  installLocalStorageStub();
  document.documentElement.classList.remove('dark');
  document.documentElement.removeAttribute('data-density');
  document.documentElement.removeAttribute('data-font');
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:fake');
  globalThis.URL.revokeObjectURL = vi.fn();
});

describe('ProfilePage avatar settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchWithAuthMock.mockImplementation(async (url) => {
      if (String(url) === '/auth/passkeys') {
        return makeJsonResponse({ passkeys: [] });
      }
      return undefined as unknown as Response;
    });
  });

  it('does NOT render the old Avatar image URL input', () => {
    render(
      <ProfilePage
        initialUser={{
          id: 'user-1',
          name: 'Casey Admin',
          email: 'casey@example.com',
          mfaEnabled: false
        }}
      />
    );
    expect(screen.queryByLabelText('Avatar image URL')).toBeNull();
    expect(screen.queryByText(/coming soon/i)).toBeNull();
    // Helper text is present
    expect(screen.getByText(/PNG, JPG, or WebP\. Max 5 MB\./)).toBeTruthy();
  });

  it('uploads a PNG file, updates the avatar, and shows success', async () => {
    fetchWithAuthMock.mockImplementation(async (url) => {
      if (String(url) === '/auth/passkeys') {
        return makeJsonResponse({ passkeys: [] });
      }
      if (String(url) === '/users/me/avatar') {
        return makeJsonResponse({
          avatarUrl: '/api/v1/users/user-1/avatar',
          size: 1234,
          mime: 'image/png',
          updatedAt: new Date().toISOString()
        });
      }
      return undefined as unknown as Response;
    });

    render(
      <ProfilePage
        initialUser={{
          id: 'user-1',
          name: 'Casey Admin',
          email: 'casey@example.com',
          mfaEnabled: false
        }}
      />
    );

    const fileInput = screen.getByTestId('avatar-file-input') as HTMLInputElement;
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'avatar.png', {
      type: 'image/png'
    });

    fireEvent.change(fileInput, { target: { files: [file] } });

    // Confirmation row appears
    await screen.findByText('avatar.png');
    fireEvent.click(screen.getByRole('button', { name: 'Upload' }));

    await screen.findByText('Avatar updated.');

    const uploadCall = fetchWithAuthMock.mock.calls.find(
      ([url]) => String(url) === '/users/me/avatar'
    );
    expect(uploadCall).toBeDefined();
    const [, init] = uploadCall!;
    expect(init?.method).toBe('POST');
    expect(init?.body).toBeInstanceOf(FormData);
  });

  it('shows a validation error for unsupported file types and does not call the API', () => {
    render(
      <ProfilePage
        initialUser={{
          id: 'user-1',
          name: 'Casey Admin',
          email: 'casey@example.com',
          mfaEnabled: false
        }}
      />
    );

    const fileInput = screen.getByTestId('avatar-file-input') as HTMLInputElement;
    const badFile = new File([new Uint8Array([1, 2, 3])], 'evil.svg', { type: 'image/svg+xml' });
    fireEvent.change(fileInput, { target: { files: [badFile] } });

    expect(screen.getByText(/Unsupported file type/i)).toBeTruthy();
    expect(
      fetchWithAuthMock.mock.calls.find(([url]) => String(url) === '/users/me/avatar')
    ).toBeUndefined();
  });

  it('deletes the current avatar via the Remove button', async () => {
    fetchWithAuthMock.mockImplementation(async (url) => {
      if (String(url) === '/auth/passkeys') {
        return makeJsonResponse({ passkeys: [] });
      }
      if (String(url) === '/users/me/avatar') {
        return makeJsonResponse({ avatarUrl: null });
      }
      return undefined as unknown as Response;
    });

    render(
      <ProfilePage
        initialUser={{
          id: 'user-1',
          name: 'Casey Admin',
          email: 'casey@example.com',
          avatarUrl: '/api/v1/users/user-1/avatar',
          mfaEnabled: false
        }}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    await screen.findByText('Avatar removed.');

    const deleteCall = fetchWithAuthMock.mock.calls.find(
      ([url]) => String(url) === '/users/me/avatar'
    );
    expect(deleteCall).toBeDefined();
    const [, init] = deleteCall!;
    expect(init?.method).toBe('DELETE');

    // After successful delete, the Remove button is no longer shown.
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
    });
  });
});

describe('ProfilePage theming settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchWithAuthMock.mockImplementation(async (url) => {
      if (String(url) === '/auth/passkeys') {
        return makeJsonResponse({ passkeys: [] });
      }
      if (String(url) === '/users/me') {
        return makeJsonResponse({
          preferences: {
            theme: 'dark',
            density: 'compact',
            font: 'system',
            timeFormat: '12h'
          }
        });
      }
      return undefined as unknown as Response;
    });
  });

  it('renders theming below the passkeys section', async () => {
    render(
      <ProfilePage
        initialUser={{
          id: 'user-1',
          name: 'Casey Admin',
          email: 'casey@example.com',
          mfaEnabled: false
        }}
      />
    );

    await screen.findByText('No passkeys are registered for this account.');
    const addPasskeyButton = screen.getByRole('button', { name: 'Add passkey' });
    const themingHeading = screen.getByRole('heading', { name: 'Theming' });

    expect(
      addPasskeyButton.compareDocumentPosition(themingHeading) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it('reflects appearance changes made outside the profile page', async () => {
    render(
      <ProfilePage
        initialUser={{
          id: 'user-1',
          name: 'Casey Admin',
          email: 'casey@example.com',
          mfaEnabled: false,
          preferences: {
            theme: 'light',
            density: 'comfortable',
            font: 'breeze',
            timeFormat: '12h'
          }
        }}
      />
    );

    await screen.findByText('No passkeys are registered for this account.');

    act(() => {
      writeThemePreference('dark');
      writeDensity('dense');
      writeFontPreference('system');
      writeTimeFormatPreference('24h');
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Dark/i })).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByRole('button', { name: /Dense/i })).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByText('OS interface font').closest('button')).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByText('24-hour').closest('button')).toHaveAttribute('aria-pressed', 'true');
    });
  });

  it('saves font selection with the existing theme and density preferences', async () => {
    render(
      <ProfilePage
        initialUser={{
          id: 'user-1',
          name: 'Casey Admin',
          email: 'casey@example.com',
          mfaEnabled: false,
          preferences: {
            theme: 'dark',
            density: 'compact',
            font: 'breeze',
            timeFormat: '12h'
          }
        }}
      />
    );

    const systemFontButton = screen.getByText('OS interface font').closest('button');
    expect(systemFontButton).not.toBeNull();
    fireEvent.click(systemFontButton!);

    await screen.findByText('Theming preferences saved.');

    const preferenceCall = fetchWithAuthMock.mock.calls.find(
      ([url]) => String(url) === '/users/me'
    );
    expect(preferenceCall).toBeDefined();
    const [, init] = preferenceCall!;
    expect(init?.method).toBe('PATCH');
    expect(JSON.parse(String(init?.body))).toEqual({
      preferences: {
        theme: 'dark',
        density: 'compact',
        font: 'system',
        timeFormat: '12h',
        locale: 'en'
      }
    });
    expect(localStorage.getItem('breeze.font')).toBe('system');
    expect(document.documentElement).toHaveAttribute('data-font', 'system');
  });

  it('saves the selected time format with existing appearance preferences', async () => {
    fetchWithAuthMock.mockImplementation(async (url, init) => {
      if (String(url) === '/auth/passkeys') {
        return makeJsonResponse({ passkeys: [] });
      }
      if (String(url) === '/users/me') {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        return makeJsonResponse({ preferences: body.preferences });
      }
      return undefined as unknown as Response;
    });

    render(
      <ProfilePage
        initialUser={{
          id: 'user-1',
          name: 'Casey Admin',
          email: 'casey@example.com',
          mfaEnabled: false,
          preferences: {
            theme: 'dark',
            density: 'compact',
            font: 'breeze',
            timeFormat: '12h'
          }
        }}
      />
    );

    fireEvent.click(screen.getByText('24-hour').closest('button')!);

    await screen.findByText('Theming preferences saved.');

    const preferenceCall = fetchWithAuthMock.mock.calls.find(
      ([url]) => String(url) === '/users/me'
    );
    expect(preferenceCall).toBeDefined();
    const [, init] = preferenceCall!;
    expect(init?.method).toBe('PATCH');
    expect(JSON.parse(String(init?.body))).toEqual({
      preferences: {
        theme: 'dark',
        density: 'compact',
        font: 'breeze',
        timeFormat: '24h',
        locale: 'en'
      }
    });
    expect(localStorage.getItem('breeze.timeFormat')).toBe('24h');
    await waitFor(() => {
      expect(screen.getByText('24-hour').closest('button')).toHaveAttribute('aria-pressed', 'true');
    });
  });
});

describe('ProfilePage MFA setup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchWithAuthMock.mockImplementation(async (url) => {
      if (String(url) === '/auth/passkeys') {
        return makeJsonResponse({ passkeys: [] });
      }
      return undefined as unknown as Response;
    });
  });

  // Regression guard for the bug fixed in PR #543: server requires
  // currentPassword on /auth/mfa/setup, but the client wasn't sending it,
  // breaking MFA enrollment for every user. Without this assertion the
  // server/client schema drift was silent — tsc passed, the page rendered,
  // requests just 400'd in production.
  it('sends currentPassword in the body when starting MFA setup', async () => {
    fetchWithAuthMock.mockImplementation(async (url) => {
      if (String(url) === '/auth/passkeys') {
        return makeJsonResponse({ passkeys: [] });
      }
      if (String(url) === '/auth/mfa/setup') {
        return makeJsonResponse({ qrCodeDataUrl: 'data:image/png;base64,abc' });
      }
      return undefined as unknown as Response;
    });

    render(
      <ProfilePage
        initialUser={{
          id: 'user-1',
          name: 'Casey Admin',
          email: 'casey@example.com',
          mfaEnabled: false
        }}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Enable' }));

    // Wait for the confirm-password view to mount, then query the MFA-specific
    // input by its id (the page also has a Change Password form with the same
    // "Current password" label, so getByLabelText would be ambiguous).
    await screen.findByText(/Confirm your password/i);
    const passwordInput = document.getElementById('mfa-confirm-password') as HTMLInputElement;
    expect(passwordInput).not.toBeNull();
    fireEvent.change(passwordInput, { target: { value: 'hunter2-pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    await screen.findByText(/Set up authenticator/i);

    const setupCall = fetchWithAuthMock.mock.calls.find(
      ([url]) => String(url) === '/auth/mfa/setup'
    );
    expect(setupCall).toBeDefined();

    const [, init] = setupCall!;
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ currentPassword: 'hunter2-pw' });
  });
});

// ── #4018: MFA enrollment for a PASSWORDLESS, SSO-provisioned account ────────
// Such an account cannot satisfy the password step-up the enrollment endpoints
// normally demand, so it proves identity with a fresh, forced IdP round-trip
// and hands the resulting grant to /auth/mfa/setup and /auth/mfa/enable.
describe('ProfilePage — SSO re-authentication enrollment (#4018)', () => {
  const BASE_USER = {
    id: 'user-1',
    name: 'Casey Admin',
    email: 'casey@example.com',
    mfaEnabled: false,
  };

  const realLocation = window.location;

  function restoreLocation() {
    Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    restoreLocation();
    // #4055 records the originating card in sessionStorage; a value bleeding
    // between tests would silently reroute the one after it.
    sessionStorage.clear();
    // Real jsdom location + history so the hash-consumption assertions below
    // exercise the actual replaceState behaviour rather than a stub's.
    window.history.replaceState(null, '', '/settings/profile');
    fetchWithAuthMock.mockImplementation(async (url) => {
      if (String(url) === '/auth/passkeys') {
        return makeJsonResponse({ passkeys: [] });
      }
      if (String(url) === '/auth/mfa/setup') {
        return makeJsonResponse({ qrCodeDataUrl: 'data:image/png;base64,abc' });
      }
      return undefined as unknown as Response;
    });
  });

  it('offers the IdP verification button instead of the password prompt for a passwordless account', async () => {
    render(<ProfilePage initialUser={{ ...BASE_USER, hasPassword: false }} />);

    fireEvent.click(screen.getByTestId('mfa-setup-start'));

    expect(await screen.findByTestId('mfa-sso-reauth')).toBeTruthy();
    expect(screen.getByTestId('mfa-sso-reauth').textContent)
      .toContain('Verify with your identity provider');
    expect(screen.queryByTestId('mfa-current-password')).toBeNull();
  });

  it('keeps the password prompt for an account that has a password', async () => {
    render(<ProfilePage initialUser={{ ...BASE_USER, hasPassword: true }} />);

    fireEvent.click(screen.getByTestId('mfa-setup-start'));

    expect(await screen.findByTestId('mfa-current-password')).toBeTruthy();
    expect(screen.queryByTestId('mfa-sso-reauth')).toBeNull();
  });

  // Absent is UNKNOWN, not "passwordless": a session persisted before
  // /users/me carried the field must keep the road the server will accept.
  it('keeps the password prompt when hasPassword is absent', async () => {
    render(<ProfilePage initialUser={{ ...BASE_USER }} />);

    fireEvent.click(screen.getByTestId('mfa-setup-start'));

    expect(await screen.findByTestId('mfa-current-password')).toBeTruthy();
    expect(screen.queryByTestId('mfa-sso-reauth')).toBeNull();
  });

  it('POSTs /sso/reauth/start and navigates to the returned authUrl', async () => {
    const assignMock = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: {
        assign: assignMock,
        hash: '',
        search: '',
        pathname: '/settings/profile',
        href: 'http://localhost/settings/profile',
      },
    });

    fetchWithAuthMock.mockImplementation(async (url) => {
      if (String(url) === '/auth/passkeys') return makeJsonResponse({ passkeys: [] });
      if (String(url) === '/sso/reauth/start') {
        return makeJsonResponse({ authUrl: 'https://idp.example.com/authorize?prompt=login' });
      }
      return undefined as unknown as Response;
    });

    render(<ProfilePage initialUser={{ ...BASE_USER, hasPassword: false }} />);
    fireEvent.click(screen.getByTestId('mfa-setup-start'));
    fireEvent.click(await screen.findByTestId('mfa-sso-reauth'));

    await waitFor(() => {
      expect(assignMock).toHaveBeenCalledWith('https://idp.example.com/authorize?prompt=login');
    });

    const startCall = fetchWithAuthMock.mock.calls.find(
      ([url]) => String(url) === '/sso/reauth/start'
    );
    expect(startCall).toBeDefined();
    expect(startCall![1]?.method).toBe('POST');

    restoreLocation();
  });

  it('consumes the #ssoReauthGrant fragment, calls /auth/mfa/setup with it, and clears the hash', async () => {
    window.history.replaceState(null, '', '/settings/profile#ssoReauthGrant=grant-abc');
    expect(window.location.hash).toBe('#ssoReauthGrant=grant-abc');

    render(<ProfilePage initialUser={{ ...BASE_USER, hasPassword: false }} />);

    await waitFor(() => {
      const setupCall = fetchWithAuthMock.mock.calls.find(
        ([url]) => String(url) === '/auth/mfa/setup'
      );
      expect(setupCall).toBeDefined();
      expect(JSON.parse(String(setupCall![1]?.body))).toEqual({ ssoReauthGrantId: 'grant-abc' });
    });

    // The grant is single-use — leaving it in the address bar invites a
    // confusing second attempt after it has already been consumed.
    expect(window.location.hash).toBe('');
    // And the user lands straight on the QR screen; re-prompting for a proof
    // already spent on this page load would be a dead end.
    await screen.findByText(/Set up authenticator/i);
  });

  it('sends the grant, not a password, on the terminal /auth/mfa/enable write', async () => {
    window.history.replaceState(null, '', '/settings/profile#ssoReauthGrant=grant-abc');
    fetchWithAuthMock.mockImplementation(async (url) => {
      if (String(url) === '/auth/passkeys') return makeJsonResponse({ passkeys: [] });
      if (String(url) === '/auth/mfa/setup') {
        return makeJsonResponse({ qrCodeDataUrl: 'data:image/png;base64,abc' });
      }
      if (String(url) === '/auth/mfa/enable') {
        return makeJsonResponse({ recoveryCodes: ['AAAA-BBBB'] });
      }
      return undefined as unknown as Response;
    });

    render(<ProfilePage initialUser={{ ...BASE_USER, hasPassword: false }} />);
    await screen.findByText(/Set up authenticator/i);

    const digitInputs = document.querySelectorAll<HTMLInputElement>('input[inputmode="numeric"]');
    expect(digitInputs.length).toBe(6);
    digitInputs.forEach((input, index) => {
      fireEvent.change(input, { target: { value: String(index + 1) } });
    });

    fireEvent.click(screen.getByRole('button', { name: /Verify and enable/i }));

    await waitFor(() => {
      const enableCall = fetchWithAuthMock.mock.calls.find(
        ([url]) => String(url) === '/auth/mfa/enable'
      );
      expect(enableCall).toBeDefined();
      expect(JSON.parse(String(enableCall![1]?.body)))
        .toEqual({ code: '123456', ssoReauthGrantId: 'grant-abc' });
    });
  });

  it('toasts actionable copy for the reauth_not_fresh callback error', async () => {
    window.history.replaceState(null, '', '/settings/profile?ssoReauthError=reauth_not_fresh');

    render(<ProfilePage initialUser={{ ...BASE_USER, hasPassword: false }} />);

    await waitFor(() => expect(showToastMock).toHaveBeenCalled());
    expect(showToastMock).toHaveBeenCalledWith({
      type: 'error',
      message: 'Your identity provider did not re-verify your sign-in. Try again, or ask your administrator to allow re-authentication prompts.',
    });
  });

  it.each([
    ['identity_mismatch', 'not the one linked to this profile'],
    ['session_invalid', 'Your session changed while you were verifying'],
    ['password_set', 'This account now has a password'],
    ['reauth_unavailable', 'temporarily unavailable'],
    // Reachable only since the callback stopped bouncing reauth to /login: a
    // provider disabled, or its config_version bumped by an admin edit,
    // mid-flight.
    ['provider_inactive', 'no longer available for this account'],
    ['config_changed', 'settings changed while you were verifying'],
    ['email_unverified', 'email address is not verified'],
  ])('toasts a specific message for the %s callback error', async (code, fragment) => {
    window.history.replaceState(null, '', `/settings/profile?ssoReauthError=${code}`);

    render(<ProfilePage initialUser={{ ...BASE_USER, hasPassword: false }} />);

    await waitFor(() => expect(showToastMock).toHaveBeenCalled());
    expect(showToastMock.mock.calls[0][0].type).toBe('error');
    expect(showToastMock.mock.calls[0][0].message).toContain(fragment);
  });

  // A code this build doesn't know must still say something — silence here
  // leaves the user staring at an unchanged page after a failed IdP trip.
  it('toasts a generic message for an unrecognized callback error code', async () => {
    window.history.replaceState(null, '', '/settings/profile?ssoReauthError=some_new_code');

    render(<ProfilePage initialUser={{ ...BASE_USER, hasPassword: false }} />);

    await waitFor(() => expect(showToastMock).toHaveBeenCalled());
    expect(showToastMock.mock.calls[0][0].message)
      .toBe('Could not verify with your identity provider. Please try again.');
  });

  it('stays silent when there is no callback error', async () => {
    render(<ProfilePage initialUser={{ ...BASE_USER, hasPassword: false }} />);
    await screen.findByTestId('mfa-setup-start');
    expect(showToastMock).not.toHaveBeenCalled();
  });

  // The param was previously a bare `error`, read but never removed, on an
  // effect that depended on `[t]`. showToast has no dedupe by design, so when
  // react-i18next swapped `t`'s identity after its async resource load the user
  // saw the SAME toast twice; and because the param stayed in the URL, every
  // reload (or a shared link) re-toasted forever.
  it('strips ssoReauthError from the URL so a reload cannot re-toast', async () => {
    window.history.replaceState(null, '', '/settings/profile?ssoReauthError=reauth_not_fresh');

    render(<ProfilePage initialUser={{ ...BASE_USER, hasPassword: false }} />);

    await waitFor(() => expect(showToastMock).toHaveBeenCalledTimes(1));
    expect(window.location.search).toBe('');
  });

  it('preserves other query params and the fragment when stripping its own', async () => {
    window.history.replaceState(
      null,
      '',
      '/settings/profile?tab=security&ssoReauthError=session_invalid&ref=email#passkeys',
    );

    render(<ProfilePage initialUser={{ ...BASE_USER, hasPassword: false }} />);

    await waitFor(() => expect(showToastMock).toHaveBeenCalledTimes(1));
    const params = new URLSearchParams(window.location.search);
    expect(params.get('ssoReauthError')).toBeNull();
    expect(params.get('tab')).toBe('security');
    expect(params.get('ref')).toBe('email');
    expect(window.location.hash).toBe('#passkeys');
  });

  // The param is namespaced for the same reason ConnectSsoCard's is: a bare
  // `error` is a name any feature on this page could reasonably claim, and this
  // handler would then toast SSO copy for something else entirely.
  it('ignores a bare ?error= param that is not ours', async () => {
    window.history.replaceState(null, '', '/settings/profile?error=reauth_not_fresh');

    render(<ProfilePage initialUser={{ ...BASE_USER, hasPassword: false }} />);
    await screen.findByTestId('mfa-setup-start');

    expect(showToastMock).not.toHaveBeenCalled();
    // And it is left alone — it belongs to whoever put it there.
    expect(window.location.search).toBe('?error=reauth_not_fresh');
  });

  // ProfilePage's `if (ok)` guard on the mount-time /mfa/setup call. Without it
  // an unconditional setSsoSetupReady(true) still passed every other test in
  // this file, and production would open a QR view with no QR in it.
  it('stays on the status card when the grant-backed /auth/mfa/setup fails', async () => {
    window.history.replaceState(null, '', '/settings/profile#ssoReauthGrant=grant-abc');
    fetchWithAuthMock.mockImplementation(async (url) => {
      if (String(url) === '/auth/passkeys') return makeJsonResponse({ passkeys: [] });
      if (String(url) === '/auth/mfa/setup') {
        return makeJsonResponse({ error: 'Invalid credentials' }, false, 401);
      }
      return undefined as unknown as Response;
    });

    render(<ProfilePage initialUser={{ ...BASE_USER, hasPassword: false }} />);

    // Wait on the error banner, which the SAME .then chain sets. Anything that
    // flipped the view would have flipped it by now, so the assertion below is
    // not a race: dropping the `if (ok)` makes this test fail rather than pass
    // on ordering luck.
    await screen.findByText('Invalid credentials');

    // The retry affordance lives on the status card, so that is where the user
    // must stay — and the QR view must NOT open with an empty frame in it.
    expect(screen.getByTestId('mfa-setup-start')).toBeTruthy();
    expect(screen.queryByText(/Set up authenticator/i)).toBeNull();
    expect(screen.queryByText(/QR code unavailable/i)).toBeNull();
  });

  // NOTE: the "grant lost" dead end (review finding 7) is NOT reachable from
  // this component today, so it is pinned in MFASettings.test.tsx instead where
  // the state combination is directly expressible. ProfilePage sets
  // `ssoSetupReady` and `ssoReauthGrantId` in the SAME mount effect and clears
  // them together, and the passwordless confirm view's only action is a
  // full-page navigation to the IdP — so a reload drops the user on the status
  // card rather than on a QR screen with a dead Verify button. See the report.

  // ── #4055: the TOTP half of "return to the card you left from" ─────────────
  // The passkey half lives in ProfilePage.passkeys.test.tsx. These pin the side
  // that must NOT change: the authenticator card's own round-trip still lands
  // on the QR screen, and it now says so out loud instead of relying on it
  // being the only thing the return path could possibly do.
  describe('returning to the card the trip started from (#4055)', () => {
    it('records the authenticator card as the origin BEFORE navigating to the IdP', async () => {
      // Captured at assign() time: the recorded intent has to be durable at the
      // instant the page leaves, or the return has nothing to read.
      let intentAtNavigation: string | null = 'not-called';
      const assignMock = vi.fn(() => {
        intentAtNavigation = sessionStorage.getItem(SSO_REAUTH_INTENT_KEY);
      });
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: {
          assign: assignMock,
          hash: '',
          search: '',
          pathname: '/settings/profile',
          href: 'http://localhost/settings/profile',
        },
      });

      fetchWithAuthMock.mockImplementation(async (url) => {
        if (String(url) === '/auth/passkeys') return makeJsonResponse({ passkeys: [] });
        if (String(url) === '/sso/reauth/start') {
          return makeJsonResponse({ authUrl: 'https://idp.example.com/authorize?prompt=login' });
        }
        return undefined as unknown as Response;
      });

      try {
        render(<ProfilePage initialUser={{ ...BASE_USER, hasPassword: false }} />);
        fireEvent.click(screen.getByTestId('mfa-setup-start'));
        fireEvent.click(await screen.findByTestId('mfa-sso-reauth'));

        await waitFor(() => expect(assignMock).toHaveBeenCalled());
        expect(intentAtNavigation).toBe('totp');
      } finally {
        // In a `finally` on purpose: a bare restore after the assertions is
        // skipped when one fails, and the stubbed location then leaks into
        // every later test as an empty hash.
        restoreLocation();
      }
    });

    it('still opens the QR screen when the trip started from the authenticator card', async () => {
      stashSsoReauthIntent('totp');
      window.history.replaceState(null, '', '/settings/profile#ssoReauthGrant=grant-abc');

      render(<ProfilePage initialUser={{ ...BASE_USER, hasPassword: false }} />);

      await waitFor(() => {
        const setupCall = fetchWithAuthMock.mock.calls.find(
          ([url]) => String(url) === '/auth/mfa/setup'
        );
        expect(setupCall).toBeDefined();
        expect(JSON.parse(String(setupCall![1]?.body))).toEqual({ ssoReauthGrantId: 'grant-abc' });
      });
      await screen.findByText(/Set up authenticator/i);
      expect(sessionStorage.getItem(SSO_REAUTH_INTENT_KEY)).toBeNull();
    });

    // An intent recorded for a trip that never completed must not survive to
    // reroute the next one. The mount effect consumes it whether or not a grant
    // came back — an error return (`?ssoReauthError=`) leaves nothing to route.
    it('clears a stale intent even when the return carried no grant', async () => {
      stashSsoReauthIntent('passkey');
      window.history.replaceState(null, '', '/settings/profile?ssoReauthError=reauth_not_fresh');

      render(<ProfilePage initialUser={{ ...BASE_USER, hasPassword: false }} />);
      await screen.findByTestId('mfa-setup-start');

      expect(sessionStorage.getItem(SSO_REAUTH_INTENT_KEY)).toBeNull();
      // No grant, so nothing to enroll with — and certainly no /mfa/setup.
      expect(
        fetchWithAuthMock.mock.calls.filter(([url]) => String(url) === '/auth/mfa/setup')
      ).toHaveLength(0);
    });
  });
});