import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import MFASettings from './MFASettings';

describe('MFASettings active method rendering', () => {
  it('renders an active SMS factor even when SMS is no longer policy-available', () => {
    render(<MFASettings enabled mfaMethod="sms" smsAllowed={false} phoneLast4="1234" />);

    expect(screen.getByText('SMS codes')).toBeTruthy();
    expect(screen.getByText(/1234/)).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Disable' })).toHaveLength(1);
  });

  it('does not present TOTP as active or offer a bogus TOTP disable for passkey-only MFA', () => {
    render(<MFASettings enabled mfaMethod="passkey" />);

    expect(screen.queryByRole('button', { name: 'Disable' })).toBeNull();
    expect(screen.getByText('Authenticator app').parentElement?.textContent).toContain('Disabled');
  });
});
