import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import OrgSecuritySettings from './OrgSecuritySettings';

vi.mock('../../stores/orgStore', () => ({ useOrgStore: () => ({ currentOrgId: 'org-1' }) }));

describe('OrgSecuritySettings MFA policy', () => {
  it('saves the canonical allowedMethods object including passkeys', () => {
    const onSave = vi.fn();
    render(<OrgSecuritySettings security={{ requireMfa: true, allowedMethods: { totp: true, sms: false, passkey: false } }} onSave={onSave} />);

    fireEvent.click(screen.getByLabelText('Passkey'));
    fireEvent.click(screen.getByRole('button', { name: /save security/i }));

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      requireMfa: true,
      allowedMethods: { totp: true, sms: false, passkey: true },
    }));
  });
});
