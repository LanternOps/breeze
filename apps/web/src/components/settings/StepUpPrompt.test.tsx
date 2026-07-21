import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import StepUpPrompt, { pickReauthTier } from './StepUpPrompt';

describe('pickReauthTier', () => {
  it.each([
    [2, 'totp', 'passkey'],     // passkey wins even with TOTP
    [0, 'totp', 'totp'],
    [0, 'sms', 'password'],     // SMS users take the password path (spec)
    [0, null, 'password'],
  ] as const)('passkeys=%s mfaMethod=%s → %s', (passkeyCount, mfaMethod, expected) => {
    expect(pickReauthTier(passkeyCount, mfaMethod)).toBe(expected);
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
