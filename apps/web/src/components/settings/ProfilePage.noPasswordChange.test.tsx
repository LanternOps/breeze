import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ProfilePage from './ProfilePage';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  createPasskeyCredential: vi.fn(),
  fetchWithAuth: vi.fn(),
  useAuthStore: Object.assign(
    (selector: (state: { updateUser: () => void }) => unknown) => selector({ updateUser: vi.fn() }),
    { getState: () => ({ updateUser: vi.fn(), sessionGeneration: 0, commitReissuedSessionIfCurrent: vi.fn(() => true) }) },
  ),
}));

const { showToastMock } = vi.hoisted(() => ({ showToastMock: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: showToastMock }));

vi.mock('@/lib/avatarBlobCache', () => ({
  useAvatarBlobUrl: (url: string | null | undefined) => url ?? null,
}));

vi.mock('./ApproverDevicesSection', () => ({
  default: () => null,
}));

// TicketPushoverSettings fetches /users/me/ticket-pushover on mount; stub it so
// it doesn't consume from this file's fetchWithAuth mocks. Its own behavior is
// covered by TicketPushoverSettings.test.tsx.
vi.mock('./TicketPushoverSettings', () => ({
  default: () => null,
}));

// EmailNotificationSettings fetches /users/me/email-preferences on mount; stub it so
// it doesn't consume from this file's fetchWithAuth mocks (covered by its own test).
vi.mock('./EmailNotificationSettings', () => ({
  default: () => null,
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

const base = { id: 'user-1', name: 'Casey Admin', email: 'casey@example.com', mfaEnabled: false };

describe('ProfilePage — Change password for accounts without a password (#9008)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchWithAuthMock.mockImplementation(async (url) =>
      String(url) === '/auth/passkeys' ? makeJsonResponse({ passkeys: [] }) : makeJsonResponse({}));
  });

  it('replaces the dead-end form with an explanation when hasPassword is false', async () => {
    render(<ProfilePage initialUser={{ ...base, hasPassword: false }} />);

    expect(await screen.findByTestId('change-password-unavailable')).toBeTruthy();
    expect(document.getElementById('currentPassword')).toBeNull();
  });

  it('keeps the form for password accounts', async () => {
    render(<ProfilePage initialUser={{ ...base, hasPassword: true }} />);

    await waitFor(() => expect(document.getElementById('currentPassword')).not.toBeNull());
    expect(screen.queryByTestId('change-password-unavailable')).toBeNull();
  });

  it('keeps the form when hasPassword is unknown (fail-safe password road)', async () => {
    render(<ProfilePage initialUser={base} />);

    await waitFor(() => expect(document.getElementById('currentPassword')).not.toBeNull());
    expect(screen.queryByTestId('change-password-unavailable')).toBeNull();
  });
});
