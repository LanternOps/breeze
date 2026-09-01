import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ProfilePage from './ProfilePage';
import { fetchWithAuth } from '../../stores/auth';

/**
 * #4413 — a wrong TOTP during enrollment must NOT fail silently.
 *
 * `POST /auth/mfa/enable` answers 401 `Invalid MFA code` for a mistyped code.
 * The panel used to collapse straight back to the status card and drop the
 * QR/secret, so a user who fat-fingered one digit was left with a dead
 * authenticator entry, no error, and no way to retry that same secret.
 */

vi.mock('../../stores/auth', () => ({
  createPasskeyCredential: vi.fn(),
  fetchWithAuth: vi.fn(),
  useAuthStore: Object.assign(
    (selector: (state: { updateUser: () => void }) => unknown) => selector({ updateUser: vi.fn() }),
    { getState: () => ({ updateUser: vi.fn() }) }
  )
}));

const { showToastMock } = vi.hoisted(() => ({ showToastMock: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: showToastMock }));

vi.mock('@/lib/avatarBlobCache', () => ({
  useAvatarBlobUrl: (url: string | null | undefined) => url ?? null,
}));

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

const BASE_USER = {
  id: 'user-1',
  name: 'Casey Admin',
  email: 'casey@example.com',
  mfaEnabled: false,
  hasPassword: true,
};

/** Walks the status card → password gate → QR view. */
async function openEnrollmentPanel() {
  fireEvent.click(screen.getByTestId('mfa-setup-start'));
  await screen.findByText(/Confirm your password/i);
  const passwordInput = document.getElementById('mfa-confirm-password') as HTMLInputElement;
  fireEvent.change(passwordInput, { target: { value: 'hunter2-pw' } });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await screen.findByText(/Set up authenticator/i);
}

function fillCode(value = '123456') {
  const digits = document.querySelectorAll<HTMLInputElement>('input[inputmode="numeric"]');
  expect(digits.length).toBe(6);
  digits.forEach((input, index) => {
    fireEvent.change(input, { target: { value: value[index] } });
  });
}

describe('ProfilePage — MFA enrollment rejects a wrong TOTP (#4413)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState(null, '', '/settings/profile');
    fetchWithAuthMock.mockImplementation(async (url) => {
      if (String(url) === '/auth/passkeys') return makeJsonResponse({ passkeys: [] });
      if (String(url) === '/auth/mfa/setup') {
        return makeJsonResponse({ qrCodeDataUrl: 'data:image/png;base64,abc' });
      }
      if (String(url) === '/auth/mfa/enable') {
        return makeJsonResponse({ error: 'Invalid MFA code' }, false, 401);
      }
      return undefined as unknown as Response;
    });
  });

  it('shows the server error and keeps the enrollment panel open so the code can be retried', async () => {
    render(<ProfilePage initialUser={BASE_USER} />);

    await openEnrollmentPanel();
    fillCode();
    fireEvent.click(screen.getByRole('button', { name: /Verify and enable/i }));

    // The 401 must be VISIBLE, not swallowed.
    expect(await screen.findByText(/Invalid MFA code/i)).toBeTruthy();

    // ...and the panel must NOT have collapsed back to the status card: the
    // secret behind the QR is un-recoverable once this view is left.
    expect(screen.getByText(/Set up authenticator/i)).toBeTruthy();
    expect(screen.queryByTestId('mfa-setup-start')).toBeNull();
    expect(document.querySelector('img[alt*="QR"]')).not.toBeNull();
  });

  it('retries against the SAME secret — no second /auth/mfa/setup, and the password is still carried', async () => {
    render(<ProfilePage initialUser={BASE_USER} />);

    await openEnrollmentPanel();
    fillCode();
    fireEvent.click(screen.getByRole('button', { name: /Verify and enable/i }));
    await screen.findByText(/Invalid MFA code/i);

    fillCode('654321');
    fireEvent.click(screen.getByRole('button', { name: /Verify and enable/i }));

    await waitFor(() => {
      const enableCalls = fetchWithAuthMock.mock.calls.filter(
        ([url]) => String(url) === '/auth/mfa/enable'
      );
      expect(enableCalls.length).toBe(2);
      // The password collected at the gate must survive the first rejection,
      // otherwise the retry 401s for a completely different reason.
      expect(JSON.parse(String(enableCalls[1][1]?.body)))
        .toEqual({ code: '654321', currentPassword: 'hunter2-pw' });
    });

    // One enrollment, one secret.
    const setupCalls = fetchWithAuthMock.mock.calls.filter(
      ([url]) => String(url) === '/auth/mfa/setup'
    );
    expect(setupCalls.length).toBe(1);
  });

  it('does not let fetchWithAuth mistake the wrong-code 401 for an expired session', async () => {
    render(<ProfilePage initialUser={BASE_USER} />);

    await openEnrollmentPanel();
    fillCode();
    fireEvent.click(screen.getByRole('button', { name: /Verify and enable/i }));
    await screen.findByText(/Invalid MFA code/i);

    // A 401 meaning "you typed the wrong digits" must never be handed to the
    // refresh-and-replay path: that either replays a single-use code or (when
    // the refresh does not restore) logs the user out mid-enrollment.
    const enableCall = fetchWithAuthMock.mock.calls.find(
      ([url]) => String(url) === '/auth/mfa/enable'
    );
    expect(enableCall).toBeDefined();
    expect(
      (enableCall![1] as { skipUnauthorizedRetry?: boolean } | undefined)?.skipUnauthorizedRetry
    ).toBe(true);
  });

  it('still completes enrollment on a correct code', async () => {
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

    render(<ProfilePage initialUser={BASE_USER} />);

    await openEnrollmentPanel();
    fillCode();
    fireEvent.click(screen.getByRole('button', { name: /Verify and enable/i }));

    expect(
      await screen.findByText(/Multi-factor authentication enabled successfully/i)
    ).toBeTruthy();
    expect(screen.queryByText(/Set up authenticator/i)).toBeNull();
  });

  // #4414 complement: /auth/mfa/enable is the ONLY moment these codes exist in
  // plaintext. Once "View codes" is gone (it regenerated), enrollment has to
  // display them or the user's first set is unreachable forever.
  it('displays the recovery codes returned by enrollment, once, without a second request', async () => {
    fetchWithAuthMock.mockImplementation(async (url) => {
      if (String(url) === '/auth/passkeys') return makeJsonResponse({ passkeys: [] });
      if (String(url) === '/auth/mfa/setup') {
        return makeJsonResponse({ qrCodeDataUrl: 'data:image/png;base64,abc' });
      }
      if (String(url) === '/auth/mfa/enable') {
        return makeJsonResponse({ recoveryCodes: ['AAAA-BBBB', 'CCCC-DDDD'] });
      }
      return undefined as unknown as Response;
    });

    render(<ProfilePage initialUser={BASE_USER} />);

    await openEnrollmentPanel();
    fillCode();
    fireEvent.click(screen.getByRole('button', { name: /Verify and enable/i }));

    expect(await screen.findByText('AAAA-BBBB')).toBeTruthy();
    expect(screen.getByText('CCCC-DDDD')).toBeTruthy();
    expect(
      fetchWithAuthMock.mock.calls.filter(([url]) => String(url) === '/auth/mfa/recovery-codes')
    ).toHaveLength(0);
  });
});
