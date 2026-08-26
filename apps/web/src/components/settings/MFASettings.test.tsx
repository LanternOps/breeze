import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import MFASettings from './MFASettings';

/**
 * #4018 review finding 7: the SSO enrollment road's terminal write needs the
 * single-use grant, and the component must not issue the request without one.
 *
 * Pinned HERE rather than through ProfilePage because ProfilePage cannot
 * currently produce the state: it sets `ssoSetupReady` and `ssoReauthGrantId`
 * in the same mount effect and clears them together, and the passwordless
 * confirm-identity view's only action is a full-page navigation to the IdP.
 * MFASettings takes the two as INDEPENDENT props, so the combination is one a
 * caller can hand it — and the component owes a sane answer either way rather
 * than posting a proofless request and rendering the 401 on a screen with no
 * password field and no re-verify button.
 */
describe('MFASettings — passwordless enrollment with no re-auth grant', () => {
  const baseProps = {
    enabled: false,
    hasPassword: false,
    ssoSetupReady: true,
    qrCodeDataUrl: 'data:image/png;base64,abc',
  } as const;

  function fillCode() {
    const digits = document.querySelectorAll<HTMLInputElement>('input[inputmode="numeric"]');
    expect(digits.length).toBe(6);
    digits.forEach((input, index) => {
      fireEvent.change(input, { target: { value: String(index + 1) } });
    });
  }

  it('offers IdP re-verification instead of Verify, and never calls onEnable', async () => {
    const onEnable = vi.fn();
    const onSsoReauth = vi.fn();

    render(
      <MFASettings
        {...baseProps}
        ssoReauthGrantAvailable={false}
        onEnable={onEnable}
        onSsoReauth={onSsoReauth}
      />
    );

    await screen.findByText(/Set up authenticator/i);
    fillCode();

    expect(screen.getByTestId('mfa-sso-grant-lost')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Verify and enable/i })).toBeNull();

    fireEvent.click(screen.getByTestId('mfa-sso-reauth-retry'));

    await waitFor(() => expect(onSsoReauth).toHaveBeenCalledTimes(1));
    expect(onEnable).not.toHaveBeenCalled();
  });

  it('keeps the ordinary Verify button when the grant IS available', async () => {
    const onEnable = vi.fn();

    render(
      <MFASettings {...baseProps} ssoReauthGrantAvailable onEnable={onEnable} />
    );

    await screen.findByText(/Set up authenticator/i);
    fillCode();

    expect(screen.queryByTestId('mfa-sso-grant-lost')).toBeNull();
    expect(screen.queryByTestId('mfa-sso-reauth-retry')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Verify and enable/i }));

    // A passwordless account sends no password — the parent attaches the grant.
    await waitFor(() => expect(onEnable).toHaveBeenCalledWith('123456', ''));
  });

  // The prop defaults to true so the password road and any caller that predates
  // it are untouched: a password account must never see the SSO CTA.
  it('leaves a password account alone', async () => {
    const onEnable = vi.fn();

    render(
      <MFASettings
        enabled={false}
        hasPassword
        ssoSetupReady
        qrCodeDataUrl="data:image/png;base64,abc"
        onEnable={onEnable}
      />
    );

    await screen.findByText(/Set up authenticator/i);
    fillCode();

    expect(screen.queryByTestId('mfa-sso-grant-lost')).toBeNull();
    expect(screen.getByRole('button', { name: /Verify and enable/i })).toBeTruthy();
  });
});
