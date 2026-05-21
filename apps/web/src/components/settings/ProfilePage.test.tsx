import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ProfilePage from './ProfilePage';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: Object.assign(
    (selector: any) => selector({ updateUser: vi.fn() }),
    { getState: () => ({ updateUser: vi.fn() }) }
  )
}));

// The avatar blob hook fetches /api/v1/users/<id>/avatar through fetchWithAuth
// when an avatarUrl is present. The tests below are about the upload/delete
// flow on /users/me/avatar; mocking the hook keeps the fetch mock consumption
// order deterministic.
vi.mock('@/lib/avatarBlobCache', () => ({
  useAvatarBlobUrl: (url: string | null | undefined) => url ?? null,
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload)
  }) as unknown as Response;

// Stub URL.createObjectURL / revokeObjectURL — jsdom doesn't provide them by
// default, and the component calls them when a file is selected for preview.
beforeEach(() => {
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:fake');
  globalThis.URL.revokeObjectURL = vi.fn();
});

describe('ProfilePage avatar settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does NOT render the old Avatar image URL input', () => {
    render(
      <ProfilePage
        initialUser={{
          id: 'user-1',
          name: 'Casey Admin',
          email: 'casey@example.com',
          mfaEnabled: false
        }}
      />
    );
    expect(screen.queryByLabelText('Avatar image URL')).toBeNull();
    expect(screen.queryByText(/coming soon/i)).toBeNull();
    // Helper text is present
    expect(screen.getByText(/PNG, JPG, or WebP\. Max 5 MB\./)).toBeTruthy();
  });

  it('uploads a staged PNG file via Save changes, updates the avatar, and shows success', async () => {
    // 1st response: avatar upload, 2nd: PATCH /users/me for the name save.
    fetchWithAuthMock
      .mockResolvedValueOnce(
        makeJsonResponse({
          avatarUrl: '/api/v1/users/user-1/avatar',
          size: 1234,
          mime: 'image/png',
          updatedAt: new Date().toISOString()
        })
      )
      .mockResolvedValueOnce(
        makeJsonResponse({
          id: 'user-1',
          name: 'Casey Admin',
          email: 'casey@example.com',
          mfaEnabled: false
        })
      );

    render(
      <ProfilePage
        initialUser={{
          id: 'user-1',
          name: 'Casey Admin',
          email: 'casey@example.com',
          mfaEnabled: false
        }}
      />
    );

    const fileInput = screen.getByTestId('avatar-file-input') as HTMLInputElement;
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'avatar.png', {
      type: 'image/png'
    });

    fireEvent.change(fileInput, { target: { files: [file] } });

    // Staged file row appears (no per-row Upload button anymore — Save changes does it).
    await screen.findByText('avatar.png');
    expect(screen.queryByRole('button', { name: 'Upload' })).toBeNull();
    expect(screen.getByText(/Staged — click Save changes to upload/i)).toBeTruthy();

    // Single submit path: Save changes button at the bottom of the form.
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await screen.findByText('Profile updated successfully');

    // Verify the avatar POST happened with FormData containing a 'file' field.
    const uploadCall = fetchWithAuthMock.mock.calls.find(
      ([url]) => String(url) === '/users/me/avatar'
    );
    expect(uploadCall).toBeDefined();
    const [, init] = uploadCall!;
    expect(init?.method).toBe('POST');
    expect(init?.body).toBeInstanceOf(FormData);
    const form = init!.body as FormData;
    const sentFile = form.get('file');
    expect(sentFile).toBeInstanceOf(File);
    expect((sentFile as File).name).toBe('avatar.png');

    // Critical regression guard: must NOT manually set Content-Type on a
    // FormData body. The browser sets multipart/form-data + boundary itself,
    // and a manual application/json header is exactly what caused the
    // "file field is required" 400 in production.
    const headers = (init?.headers ?? {}) as Record<string, string> | Headers | undefined;
    let contentType: string | null = null;
    if (headers instanceof Headers) {
      contentType = headers.get('Content-Type');
    } else if (headers && typeof headers === 'object') {
      contentType = (headers as Record<string, string>)['Content-Type'] ?? null;
    }
    expect(contentType).toBeNull();
  });

  it('removes a staged file when "Remove staged file" is clicked, with no API call', () => {
    render(
      <ProfilePage
        initialUser={{
          id: 'user-1',
          name: 'Casey Admin',
          email: 'casey@example.com',
          mfaEnabled: false
        }}
      />
    );

    const fileInput = screen.getByTestId('avatar-file-input') as HTMLInputElement;
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'avatar.png', {
      type: 'image/png'
    });
    fireEvent.change(fileInput, { target: { files: [file] } });

    expect(screen.getByText('avatar.png')).toBeTruthy();
    fireEvent.click(screen.getByTestId('avatar-remove-staged'));

    expect(screen.queryByText('avatar.png')).toBeNull();
    expect(
      fetchWithAuthMock.mock.calls.find(([url]) => String(url) === '/users/me/avatar')
    ).toBeUndefined();
  });

  it('shows a validation error for unsupported file types and does not call the API', () => {
    render(
      <ProfilePage
        initialUser={{
          id: 'user-1',
          name: 'Casey Admin',
          email: 'casey@example.com',
          mfaEnabled: false
        }}
      />
    );

    const fileInput = screen.getByTestId('avatar-file-input') as HTMLInputElement;
    const badFile = new File([new Uint8Array([1, 2, 3])], 'evil.svg', { type: 'image/svg+xml' });
    fireEvent.change(fileInput, { target: { files: [badFile] } });

    expect(screen.getByText(/Unsupported file type/i)).toBeTruthy();
    expect(
      fetchWithAuthMock.mock.calls.find(([url]) => String(url) === '/users/me/avatar')
    ).toBeUndefined();
  });

  it('deletes the current avatar via the Remove button', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ avatarUrl: null }));

    render(
      <ProfilePage
        initialUser={{
          id: 'user-1',
          name: 'Casey Admin',
          email: 'casey@example.com',
          avatarUrl: '/api/v1/users/user-1/avatar',
          mfaEnabled: false
        }}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    await screen.findByText('Avatar removed.');

    const deleteCall = fetchWithAuthMock.mock.calls.find(
      ([url]) => String(url) === '/users/me/avatar'
    );
    expect(deleteCall).toBeDefined();
    const [, init] = deleteCall!;
    expect(init?.method).toBe('DELETE');

    // After successful delete, the Remove button is no longer shown.
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
    });
  });
});

describe('ProfilePage MFA setup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Regression guard for the bug fixed in PR #543: server requires
  // currentPassword on /auth/mfa/setup, but the client wasn't sending it,
  // breaking MFA enrollment for every user. Without this assertion the
  // server/client schema drift was silent — tsc passed, the page rendered,
  // requests just 400'd in production.
  it('sends currentPassword in the body when starting MFA setup', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({ qrCodeDataUrl: 'data:image/png;base64,abc' })
    );

    render(
      <ProfilePage
        initialUser={{
          id: 'user-1',
          name: 'Casey Admin',
          email: 'casey@example.com',
          mfaEnabled: false
        }}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Enable' }));

    // Wait for the confirm-password view to mount, then query the MFA-specific
    // input by its id (the page also has a Change Password form with the same
    // "Current password" label, so getByLabelText would be ambiguous).
    await screen.findByText(/Confirm your password/i);
    const passwordInput = document.getElementById('mfa-confirm-password') as HTMLInputElement;
    expect(passwordInput).not.toBeNull();
    fireEvent.change(passwordInput, { target: { value: 'hunter2-pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    await screen.findByText(/Set up authenticator/i);

    const setupCall = fetchWithAuthMock.mock.calls.find(
      ([url]) => String(url) === '/auth/mfa/setup'
    );
    expect(setupCall).toBeDefined();

    const [, init] = setupCall!;
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ currentPassword: 'hunter2-pw' });
  });
});
