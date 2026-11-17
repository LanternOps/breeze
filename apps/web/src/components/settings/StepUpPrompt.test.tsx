import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import StepUpPrompt, { alternateReauthTier, pickReauthTier } from './StepUpPrompt';

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
