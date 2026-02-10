import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ProfilePage from './ProfilePage';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn()
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload)
  }) as unknown as Response;

describe('ProfilePage avatar settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('replaces coming-soon avatar copy with editable avatar URL and saves profile', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({
        id: 'user-1',
        name: 'Casey Admin',
        email: 'casey@example.com',
        avatarUrl: 'https://cdn.example.com/old-avatar.png',
        mfaEnabled: false
      })
    );

    render(
      <ProfilePage
        initialUser={{
          id: 'user-1',
          name: 'Casey Admin',
          email: 'casey@example.com',
          avatarUrl: 'https://cdn.example.com/old-avatar.png',
          mfaEnabled: false
        }}
      />
    );

    expect(screen.queryByText(/coming soon/i)).toBeNull();

    const avatarUrlInput = screen.getByLabelText('Avatar image URL');
    fireEvent.change(avatarUrlInput, {
      target: { value: 'https://cdn.example.com/new-avatar.png' }
    });

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await screen.findByText('Profile updated successfully');

    const saveCall = fetchWithAuthMock.mock.calls.find(([url]) => String(url) === '/users/me');
    expect(saveCall).toBeDefined();

    const [, init] = saveCall!;
    expect(init?.method).toBe('PATCH');
    expect(init?.body).toBe(
      JSON.stringify({
        name: 'Casey Admin',
        avatarUrl: 'https://cdn.example.com/new-avatar.png'
      })
    );
  });
});
