import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// unified-security-devices Phase 2, Task 7: the inline passkey card + its
// add/rename/delete flows moved into SecurityDevicesCard (covered by
// SecurityDevicesCard.test.tsx). This file now only asserts ProfilePage-level
// wiring: the card is mounted with the right props, its `onFactorAdded`
// callback updates the `user` record ProfilePage owns, and the collapsed
// group header renders.

const { onFactorAddedCalls } = vi.hoisted(() => ({
  onFactorAddedCalls: [] as Array<{ recoveryCodes?: string[] }>,
}));

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: Object.assign(
    (selector: any) => selector({ updateUser: vi.fn() }),
    { getState: () => ({ updateUser: vi.fn() }) },
  ),
}));

vi.mock('@/lib/avatarBlobCache', () => ({
  useAvatarBlobUrl: (url: string | null | undefined) => url ?? null,
}));

// ConnectSsoCard (#2183) fetches /sso/link/options on mount; stub it so it
// doesn't touch this file's fetchWithAuth mock. Its own behavior is covered by
// ConnectSsoCard.test.tsx.
vi.mock('./ConnectSsoCard', () => ({
  default: () => null,
}));

// Stub MFASettings so this test can assert the `recoveryCodes` prop
// ProfilePage passes down directly, rather than driving MFASettings' own
// internal view-state machine (enable → confirm → recovery view) just to
// observe a value ProfilePage already computed.
vi.mock('./MFASettings', () => ({
  default: (props: { enabled: boolean; recoveryCodes?: string[] }) => (
    <div data-testid="mfa-settings-stub">
      <span data-testid="mfa-settings-enabled">{String(props.enabled)}</span>
      <span data-testid="mfa-settings-recovery-codes">{(props.recoveryCodes ?? []).join(',')}</span>
    </div>
  ),
}));

// Stub SecurityDevicesCard so this file only asserts ProfilePage's wiring
// into it (props received, onFactorAdded's side effects on `user`) rather
// than re-testing the card's own passkey/approver-device behavior — that's
// SecurityDevicesCard.test.tsx's job.
vi.mock('./SecurityDevicesCard', () => ({
  default: (props: { mfaEnabled: boolean; mfaMethod: string | null; onFactorAdded: (p: { recoveryCodes?: string[] }) => void }) => (
    <div data-testid="security-devices-card-stub">
      <span data-testid="secdev-mfa-enabled">{String(props.mfaEnabled)}</span>
      <span data-testid="secdev-mfa-method">{String(props.mfaMethod)}</span>
      <button
        type="button"
        onClick={() => {
          const payload = { recoveryCodes: ['aaaa-bbbb'] };
          onFactorAddedCalls.push(payload);
          props.onFactorAdded(payload);
        }}
      >
        Simulate factor added
      </button>
    </div>
  ),
}));

import ProfilePage from './ProfilePage';

describe('ProfilePage security-devices wiring', () => {
  it('mounts SecurityDevicesCard with mfaEnabled/mfaMethod derived from the user record', () => {
    render(
      <ProfilePage
        initialUser={{
          id: 'user-1',
          name: 'Casey Admin',
          email: 'casey@example.com',
          mfaEnabled: true,
          mfaMethod: 'totp',
        }}
      />,
    );

    expect(screen.getByTestId('secdev-mfa-enabled')).toHaveTextContent('true');
    expect(screen.getByTestId('secdev-mfa-method')).toHaveTextContent('totp');
  });

  it('defaults mfaEnabled/mfaMethod to false/null when the user record omits them', () => {
    render(
      <ProfilePage
        initialUser={{
          id: 'user-1',
          name: 'Casey Admin',
          email: 'casey@example.com',
        }}
      />,
    );

    expect(screen.getByTestId('secdev-mfa-enabled')).toHaveTextContent('false');
    expect(screen.getByTestId('secdev-mfa-method')).toHaveTextContent('null');
  });

  it('renders a single collapsed "Security devices" group header above the card', () => {
    render(
      <ProfilePage
        initialUser={{
          id: 'user-1',
          name: 'Casey Admin',
          email: 'casey@example.com',
          mfaEnabled: false,
        }}
      />,
    );

    const heading = screen.getByTestId('security-devices-heading');
    expect(heading).toHaveTextContent('Security devices');
    // The old two-group split ("Sign-in security" / "Approvals") is gone.
    expect(screen.queryByTestId('signin-security-heading')).toBeNull();
    expect(screen.queryByTestId('approval-security-heading')).toBeNull();

    const card = screen.getByTestId('security-devices-card-stub');
    expect(heading.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('onFactorAdded flips mfaEnabled true (on both the card and MFASettings) and surfaces recovery codes', () => {
    render(
      <ProfilePage
        initialUser={{
          id: 'user-1',
          name: 'Casey Admin',
          email: 'casey@example.com',
          mfaEnabled: false,
          mfaMethod: null,
        }}
      />,
    );

    expect(screen.getByTestId('secdev-mfa-enabled')).toHaveTextContent('false');
    expect(screen.getByTestId('mfa-settings-enabled')).toHaveTextContent('false');
    expect(screen.getByTestId('mfa-settings-recovery-codes')).toHaveTextContent('');

    fireEvent.click(screen.getByRole('button', { name: 'Simulate factor added' }));

    expect(onFactorAddedCalls).toEqual([{ recoveryCodes: ['aaaa-bbbb'] }]);
    // ProfilePage re-renders both children off the same updated `user` state
    // and its own `recoveryCodes` state.
    expect(screen.getByTestId('secdev-mfa-enabled')).toHaveTextContent('true');
    expect(screen.getByTestId('mfa-settings-enabled')).toHaveTextContent('true');
    expect(screen.getByTestId('mfa-settings-recovery-codes')).toHaveTextContent('aaaa-bbbb');
  });
});
