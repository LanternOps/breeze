import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import StepUpPrompt, { alternateReauthTier, pickRegisterReauthTier, pickReauthTier } from './StepUpPrompt';

describe('pickReauthTier', () => {
  it.each([
    [2, 'totp', 'passkey'],     // passkey wins even with TOTP
    [0, 'totp', 'totp'],
    [0, 'sms', 'password'],     // SMS users take the password path (spec)
    [0, null, 'password'],
  ] as const)('passkeys=%s mfaMethod=%s → %s', (passkeyCount, mfaMethod, expected) => {
    expect(pickReauthTier(passkeyCount, mfaMethod)).toBe(expected);
  });

  // #10650: an authenticator app enrolled beside a passkey primary. The
  // passkey stays the strongest proof; the code is the way back in when the
  // passkey is lost.
  it.each([
    [1, 'passkey', true, 'passkey'],
    [1, 'passkey', false, 'passkey'],
    [1, 'passkey', undefined, 'passkey'],
    // Passkey list not loaded yet: the enrolled authenticator still answers.
    [0, 'passkey', true, 'totp'],
    [0, 'passkey', false, 'password'],
    [0, 'totp', true, 'totp'],
  ] as const)('passkeys=%s mfaMethod=%s totpEnrolled=%s → %s', (passkeyCount, mfaMethod, totpEnrolled, expected) => {
    expect(pickReauthTier(passkeyCount, mfaMethod, totpEnrolled)).toBe(expected);
  });
});

describe('alternateReauthTier', () => {
  it('offers the authenticator app beside a passkey when TOTP is enrolled', () => {
    expect(alternateReauthTier(1, 'passkey', true)).toBe('totp');
  });
  it('offers nothing for a passkey-only account', () => {
    expect(alternateReauthTier(1, 'passkey', false)).toBeNull();
  });
  it('treats an unknown enrolment (older session) as none — no new button', () => {
    expect(alternateReauthTier(1, 'passkey', undefined)).toBeNull();
  });
  it('leaves a TOTP primary without passkeys unchanged (TOTP is already the tier)', () => {
    expect(pickReauthTier(0, 'totp', true)).toBe('totp');
    expect(alternateReauthTier(0, 'totp', true)).toBeNull();
  });
  it('offers the code beside a passkey on a TOTP primary too', () => {
    expect(alternateReauthTier(2, 'totp', true)).toBe('totp');
  });
});

describe('StepUpPrompt', () => {
  it('renders a code input for totp tier', () => {
    render(<StepUpPrompt tier="totp" reauthValue="" onChange={vi.fn()} disabled={false} />);
    expect(screen.getByTestId('approver-stepup-code')).toBeTruthy();
  });
  it('renders a password input for password tier', () => {
    render(<StepUpPrompt tier="password" reauthValue="" onChange={vi.fn()} disabled={false} />);
    expect(screen.getByTestId('approver-stepup-password')).toBeTruthy();
  });
  it('renders only the explainer for passkey tier (ceremony happens on submit)', () => {
    render(<StepUpPrompt tier="passkey" reauthValue="" onChange={vi.fn()} disabled={false} />);
    expect(screen.queryByTestId('approver-stepup-code')).toBeNull();
    expect(screen.queryByTestId('approver-stepup-password')).toBeNull();
  });
});

// #9007: approver-device registration is the one step-up whose endpoint
// (POST /authenticator/register-grant) also takes an SSO re-auth grant, so the
// `sso` tier lives on its own picker and never reaches the shared step-ups.
describe('pickRegisterReauthTier', () => {
  it.each([
    [0, null, undefined, false, 'sso'],       // passwordless, no factor
    [0, 'sms', undefined, false, 'sso'],      // SMS has no authenticated step-up sender
    [1, null, undefined, false, 'passkey'],   // a stronger factor outranks the IdP
    [0, 'totp', undefined, false, 'totp'],
    [0, 'passkey', true, false, 'totp'],      // authenticator held as a backup
    [0, null, undefined, true, 'password'],
    [0, null, undefined, undefined, 'password'], // unknown keeps the password road
  ] as const)(
    'passkeys=%s mfaMethod=%s totpEnrolled=%s hasPassword=%s → %s',
    (passkeyCount, mfaMethod, totpEnrolled, hasPassword, expected) => {
      expect(pickRegisterReauthTier(passkeyCount, mfaMethod, totpEnrolled, hasPassword)).toBe(expected);
    },
  );

  it('never hands the shared step-up picker an sso tier', () => {
    expect(pickReauthTier(0, null)).toBe('password');
  });
});

describe('StepUpPrompt sso tier (#9007)', () => {
  it('offers the IdP round-trip instead of a password field, and calls onStart once', () => {
    const onStart = vi.fn();
    render(
      <StepUpPrompt
        tier="sso"
        reauthValue=""
        onChange={vi.fn()}
        disabled={false}
        sso={{ verified: false, starting: false, onStart }}
      />,
    );
    expect(screen.queryByTestId('approver-stepup-password')).toBeNull();
    expect(screen.getByText(/has no password\. Verify with your provider first/i)).toBeTruthy();
    const start = screen.getByTestId('approver-stepup-sso-start');
    expect(start).toHaveTextContent('Verify with your identity provider');
    fireEvent.click(start);
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('approver-stepup-sso-verified')).toBeNull();
  });

  it('disables the start button while the trip is starting', () => {
    render(
      <StepUpPrompt
        tier="sso"
        reauthValue=""
        onChange={vi.fn()}
        disabled={false}
        sso={{ verified: false, starting: true, onStart: vi.fn() }}
      />,
    );
    expect(screen.getByTestId('approver-stepup-sso-start')).toBeDisabled();
  });

  it('shows the verified state and no start button once a grant is in hand', () => {
    render(
      <StepUpPrompt
        tier="sso"
        reauthValue=""
        onChange={vi.fn()}
        disabled={false}
        sso={{ verified: true, starting: false, onStart: vi.fn() }}
      />,
    );
    expect(screen.getByTestId('approver-stepup-sso-verified')).toHaveTextContent(/Identity verified/);
    expect(screen.queryByTestId('approver-stepup-sso-start')).toBeNull();
  });
});
