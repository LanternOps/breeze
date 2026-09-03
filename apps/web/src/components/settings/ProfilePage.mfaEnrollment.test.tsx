import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ProfilePage from './ProfilePage';
import { fetchWithAuth } from '../../stores/auth';

/**
 * #4413 — a wrong TOTP during enrollment must NOT fail silently.
 *
 * `POST /auth/mfa/enable` answers `Invalid MFA code` for a mistyped code. The
 * panel used to collapse straight back to the status card and drop the
 * QR/secret, so a user who fat-fingered one digit was left with a dead
 * authenticator entry, no error, and no way to retry that same secret.
 *
 * #4470 changed that rejection's STATUS from 401 to 400 + a stable
 * `code: 'mfa_code_invalid'`, so it can no longer be mistaken for bearer
 * expiry by fetchWithAuth. These specs pin the new status end to end and
 * assert the `skipUnauthorizedRetry` stopgap is gone with it.
 */

/** The API's #4470 rejected-proof body. */
const rejectedProof = (error: string, code = 'mfa_code_invalid') => ({ error, message: error, code });

vi.mock('../../stores/auth', () => ({
  createPasskeyCredential: vi.fn(),
  fetchWithAuth: vi.fn(),
  useAuthStore: Object.assign(
    (selector: (state: { updateUser: () => void }) => unknown) => selector({ updateUser: vi.fn() }),
    { getState: () => ({ updateUser: vi.fn(), sessionGeneration: 0, commitReissuedSessionIfCurrent: vi.fn(() => true) }) }
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
        return makeJsonResponse(rejectedProof('Invalid MFA code'), false, 400);
      }
      return undefined as unknown as Response;
    });
  });

  it('shows the server error and keeps the enrollment panel open so the code can be retried', async () => {
    render(<ProfilePage initialUser={BASE_USER} />);

    await openEnrollmentPanel();
    fillCode();
    fireEvent.click(screen.getByRole('button', { name: /Verify and enable/i }));

    // The rejection must be VISIBLE, not swallowed.
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
      // otherwise the retry is refused for a completely different reason.
      expect(JSON.parse(String(enableCalls[1][1]?.body)))
        .toEqual({ code: '654321', currentPassword: 'hunter2-pw' });
    });

    // One enrollment, one secret.
    const setupCalls = fetchWithAuthMock.mock.calls.filter(
      ([url]) => String(url) === '/auth/mfa/setup'
    );
    expect(setupCalls.length).toBe(1);
  });

  it('#4470: the wrong-code rejection is a 400 the client renders, with no 401 opt-out flag left', async () => {
    render(<ProfilePage initialUser={BASE_USER} />);

    await openEnrollmentPanel();
    fillCode();
    fireEvent.click(screen.getByRole('button', { name: /Verify and enable/i }));
    await screen.findByText(/Invalid MFA code/i);

    // "You typed the wrong digits" can no longer reach fetchWithAuth's
    // refresh-and-replay path, because it is no longer a 401 at all. The
    // #4413 `skipUnauthorizedRetry` stopgap therefore has to be GONE — a
    // leftover flag would silently suppress a REAL bearer expiry on the
    // forced-enrollment page, whose only token comes from that refresh.
    const enableCall = fetchWithAuthMock.mock.calls.find(
      ([url]) => String(url) === '/auth/mfa/enable'
    );
    expect(enableCall).toBeDefined();
    expect(
      (enableCall![1] as { skipUnauthorizedRetry?: boolean } | undefined)?.skipUnauthorizedRetry
    ).toBeUndefined();
  });

  it('shows the retry hint on rejection, and clears it on the next enrollment', async () => {
    render(<ProfilePage initialUser={BASE_USER} />);

    await openEnrollmentPanel();
    expect(screen.queryByTestId('mfa-code-rejected-hint')).toBeNull();

    fillCode();
    fireEvent.click(screen.getByRole('button', { name: /Verify and enable/i }));

    // The bare server string does not say the enrollment survived; this does.
    expect(await screen.findByTestId('mfa-code-rejected-hint')).toBeTruthy();

    // Backing out and starting over must not carry the stale hint in.
    fireEvent.click(screen.getByRole('button', { name: /^Cancel$/i }));
    await screen.findByTestId('mfa-setup-start');
    await openEnrollmentPanel();
    expect(screen.queryByTestId('mfa-code-rejected-hint')).toBeNull();
  });

  it('#4470: disable and recovery-codes also drop the opt-out flag and render the 400', async () => {
    fetchWithAuthMock.mockImplementation(async (url) => {
      if (String(url) === '/auth/passkeys') return makeJsonResponse({ passkeys: [] });
      if (String(url) === '/auth/mfa/disable') {
        return makeJsonResponse(rejectedProof('Invalid MFA code'), false, 400);
      }
      if (String(url) === '/auth/mfa/recovery-codes') {
        return makeJsonResponse({ recoveryCodes: ['NEW-0001'] });
      }
      return undefined as unknown as Response;
    });

    render(<ProfilePage initialUser={{ ...BASE_USER, mfaEnabled: true, mfaMethod: 'totp' }} />);

    // Recovery codes: regenerate, behind its confirm.
    fireEvent.click(await screen.findByTestId('mfa-recovery-regenerate-start'));
    const recoveryPassword = document.getElementById('mfa-recovery-password') as HTMLInputElement;
    fireEvent.change(recoveryPassword, { target: { value: 'hunter2-pw' } });
    fireEvent.click(screen.getByTestId('mfa-recovery-regenerate'));
    fireEvent.click(await screen.findByTestId('confirm-regenerate-recovery-codes'));

    await waitFor(() => {
      const call = fetchWithAuthMock.mock.calls.find(
        ([url]) => String(url) === '/auth/mfa/recovery-codes'
      );
      expect(call).toBeDefined();
      expect(
        (call![1] as { skipUnauthorizedRetry?: boolean } | undefined)?.skipUnauthorizedRetry
      ).toBeUndefined();
    });
    expect(await screen.findByText('NEW-0001')).toBeTruthy();

    // Disable: a wrong code is a rejected proof, not a dead session.
    fireEvent.click(screen.getByRole('button', { name: /^Back$/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^Disable$/i }));
    const digits = document.querySelectorAll<HTMLInputElement>('input[inputmode="numeric"]');
    digits.forEach((input, index) => {
      fireEvent.change(input, { target: { value: String(index + 1) } });
    });
    const disablePassword = document.getElementById('mfa-disable-password') as HTMLInputElement;
    fireEvent.change(disablePassword, { target: { value: 'hunter2-pw' } });
    fireEvent.click(screen.getByRole('button', { name: /^Disable MFA$/i }));

    await waitFor(() => {
      const call = fetchWithAuthMock.mock.calls.find(
        ([url]) => String(url) === '/auth/mfa/disable'
      );
      expect(call).toBeDefined();
      expect(
        (call![1] as { skipUnauthorizedRetry?: boolean } | undefined)?.skipUnauthorizedRetry
      ).toBeUndefined();
    });
    expect(await screen.findByText(/Invalid MFA code/i)).toBeTruthy();
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
