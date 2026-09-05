import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { i18n } from '@/lib/i18n';
import UserList, { type User } from './UserList';

const base: User = {
  id: 'user-1',
  name: 'Pat Example',
  email: 'pat@example.com',
  role: 'Technician',
  status: 'active',
  lastLogin: 'Never',
};

function renderRow(user: User) {
  return render(<UserList users={[user]} currentUserId="admin-1" />);
}

// RMM-QA-166 (D11): the Reset MFA action must key on `mfaProtected` — mfa_enabled
// OR a live passkey — not on `mfaEnabled` alone. A passkey-only leftover has
// mfa_enabled = false yet is still second-factor protected, and the admin must be
// able to reset it from the users list.
describe('UserList — Reset MFA visibility (RMM-QA-166)', () => {
  beforeAll(async () => {
    await i18n.changeLanguage('en');
  });
  afterEach(() => cleanup());

  it('W-1: shows Reset MFA for a passkey-only user (mfaEnabled=false, mfaProtected=true)', () => {
    renderRow({ ...base, mfaEnabled: false, mfaProtected: true });
    expect(screen.getByRole('button', { name: 'Reset MFA' })).toBeInTheDocument();
  });

  it('W-2: hides Reset MFA when mfaProtected=false even if a stale mfaEnabled=true is sent', () => {
    renderRow({ ...base, mfaEnabled: true, mfaProtected: false });
    expect(screen.queryByRole('button', { name: 'Reset MFA' })).toBeNull();
  });

  it('W-3: falls back to mfaEnabled when the payload has no mfaProtected (legacy API)', () => {
    renderRow({ ...base, mfaEnabled: true });
    expect(screen.getByRole('button', { name: 'Reset MFA' })).toBeInTheDocument();
    cleanup();
    renderRow({ ...base, mfaEnabled: false });
    expect(screen.queryByRole('button', { name: 'Reset MFA' })).toBeNull();
  });

  it('W-3b: hides Reset MFA for a user with no factors at all (no mfaEnabled, no mfaProtected)', () => {
    renderRow(base);
    expect(screen.queryByRole('button', { name: 'Reset MFA' })).toBeNull();
  });
});
