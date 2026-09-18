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

// #5690 — Admin → Users MFA status column: enrolled / pending (with deadline
// date) / overdue / not required.
describe('UserList — MFA status column (#5690)', () => {
  beforeAll(async () => {
    await i18n.changeLanguage('en');
  });
  afterEach(() => cleanup());

  it('shows Enrolled for a user with an established factor', () => {
    renderRow({ ...base, mfaStatus: 'enrolled' });
    expect(screen.getByText('Enrolled')).toBeInTheDocument();
  });

  it('shows Overdue for a user whose grace window has lapsed', () => {
    renderRow({ ...base, mfaStatus: 'overdue' });
    expect(screen.getByText('Overdue')).toBeInTheDocument();
  });

  it('shows Not required for a user with no MFA requirement', () => {
    renderRow({ ...base, mfaStatus: 'not_required' });
    expect(screen.getByText('Not required')).toBeInTheDocument();
  });

  it('shows Pending with the formatted deadline date when a grace window is active', () => {
    renderRow({ ...base, mfaStatus: 'pending', mfaEnrollmentDeadline: '2026-11-15T00:00:00.000Z' });
    const expectedDate = new Date('2026-11-15T00:00:00.000Z').toLocaleDateString();
    expect(screen.getByText(`Pending — enroll by ${expectedDate}`)).toBeInTheDocument();
  });

  it('renders no MFA status cell content for a legacy payload with no mfaStatus field', () => {
    renderRow(base);
    expect(screen.queryByText('Enrolled')).toBeNull();
    expect(screen.queryByText('Pending')).toBeNull();
    expect(screen.queryByText('Overdue')).toBeNull();
    expect(screen.queryByText('Not required')).toBeNull();
  });
});
