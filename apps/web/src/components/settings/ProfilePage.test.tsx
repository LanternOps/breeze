import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ProfilePage from './ProfilePage';
import { fetchWithAuth } from '../../stores/auth';
import { writeDensity, writeFontPreference, writeThemePreference } from '@/lib/appearance';

vi.mock('../../stores/auth', () => ({
  createPasskeyCredential: vi.fn(),
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

// Approval-security section loads approver devices on mount; stub it so it
// doesn't touch this file's fetch mock. Covered by ApproverDevicesSection.test.tsx.
vi.mock('./ApproverDevicesSection', () => ({
  default: () => null,
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload)
  }) as unknown as Response;

function installLocalStorageStub() {
  const values = new Map<string, string>();
  const storage = {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      values.delete(key);
    }),
    clear: vi.fn(() => {
      values.clear();
    }),
  };
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: storage,
  });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: storage,
  });
}

// Stub URL.createObjectURL / revokeObjectURL — jsdom doesn't provide them by
// default, and the component calls them when a file is selected for preview.
beforeEach(() => {
  installLocalStorageStub();
  document.documentElement.classList.remove('dark');
  document.documentElement.removeAttribute('data-density');
  document.documentElement.removeAttribute('data-font');
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:fake');
  globalThis.URL.revokeObjectURL = vi.fn();
});

describe('ProfilePage avatar settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchWithAuthMock.mockImplementation(async (url) => {
      if (String(url) === '/auth/passkeys') {
        return makeJsonResponse({ passkeys: [] });
      }
      return undefined as unknown as Response;
    });
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

  it('uploads a PNG file, updates the avatar, and shows success', async () => {
    fetchWithAuthMock.mockImplementation(async (url) => {
      if (String(url) === '/auth/passkeys') {
        return makeJsonResponse({ passkeys: [] });
      }
      if (String(url) === '/users/me/avatar') {
        return makeJsonResponse({
          avatarUrl: '/api/v1/users/user-1/avatar',
          size: 1234,
          mime: 'image/png',
          updatedAt: new Date().toISOString()
        });
      }
      return undefined as unknown as Response;
    });

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

    // Confirmation row appears
    await screen.findByText('avatar.png');
    fireEvent.click(screen.getByRole('button', { name: 'Upload' }));

    await screen.findByText('Avatar updated.');

    const uploadCall = fetchWithAuthMock.mock.calls.find(
      ([url]) => String(url) === '/users/me/avatar'
    );
    expect(uploadCall).toBeDefined();
    const [, init] = uploadCall!;
    expect(init?.method).toBe('POST');
    expect(init?.body).toBeInstanceOf(FormData);
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
    fetchWithAuthMock.mockImplementation(async (url) => {
      if (String(url) === '/auth/passkeys') {
        return makeJsonResponse({ passkeys: [] });
      }
      if (String(url) === '/users/me/avatar') {
        return makeJsonResponse({ avatarUrl: null });
      }
      return undefined as unknown as Response;
    });

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

describe('ProfilePage theming settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchWithAuthMock.mockImplementation(async (url) => {
      if (String(url) === '/auth/passkeys') {
        return makeJsonResponse({ passkeys: [] });
      }
      if (String(url) === '/users/me') {
        return makeJsonResponse({
          preferences: {
            theme: 'dark',
            density: 'compact',
            font: 'system'
          }
        });
      }
      return undefined as unknown as Response;
    });
  });

  it('renders theming below the passkeys section', async () => {
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

    await screen.findByText('No passkeys are registered for this account.');
    const addPasskeyButton = screen.getByRole('button', { name: 'Add passkey' });
    const themingHeading = screen.getByRole('heading', { name: 'Theming' });

    expect(
      addPasskeyButton.compareDocumentPosition(themingHeading) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it('reflects appearance changes made outside the profile page', async () => {
    render(
      <ProfilePage
        initialUser={{
          id: 'user-1',
          name: 'Casey Admin',
          email: 'casey@example.com',
          mfaEnabled: false,
          preferences: {
            theme: 'light',
            density: 'comfortable',
            font: 'breeze'
          }
        }}
      />
    );

    await screen.findByText('No passkeys are registered for this account.');

    act(() => {
      writeThemePreference('dark');
      writeDensity('dense');
      writeFontPreference('system');
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Dark/i })).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByRole('button', { name: /Dense/i })).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByText('OS interface font').closest('button')).toHaveAttribute('aria-pressed', 'true');
    });
  });

  it('saves font selection with the existing theme and density preferences', async () => {
    render(
      <ProfilePage
        initialUser={{
          id: 'user-1',
          name: 'Casey Admin',
          email: 'casey@example.com',
          mfaEnabled: false,
          preferences: {
            theme: 'dark',
            density: 'compact',
            font: 'breeze'
          }
        }}
      />
    );

    const systemFontButton = screen.getByText('OS interface font').closest('button');
    expect(systemFontButton).not.toBeNull();
    fireEvent.click(systemFontButton!);

    await screen.findByText('Theming preferences saved.');

    const preferenceCall = fetchWithAuthMock.mock.calls.find(
      ([url]) => String(url) === '/users/me'
    );
    expect(preferenceCall).toBeDefined();
    const [, init] = preferenceCall!;
    expect(init?.method).toBe('PATCH');
    expect(JSON.parse(String(init?.body))).toEqual({
      preferences: {
        theme: 'dark',
        density: 'compact',
        font: 'system'
      }
    });
    expect(localStorage.getItem('breeze.font')).toBe('system');
    expect(document.documentElement).toHaveAttribute('data-font', 'system');
  });
});

describe('ProfilePage MFA setup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchWithAuthMock.mockImplementation(async (url) => {
      if (String(url) === '/auth/passkeys') {
        return makeJsonResponse({ passkeys: [] });
      }
      return undefined as unknown as Response;
    });
  });

  // Regression guard for the bug fixed in PR #543: server requires
  // currentPassword on /auth/mfa/setup, but the client wasn't sending it,
  // breaking MFA enrollment for every user. Without this assertion the
  // server/client schema drift was silent — tsc passed, the page rendered,
  // requests just 400'd in production.
  it('sends currentPassword in the body when starting MFA setup', async () => {
    fetchWithAuthMock.mockImplementation(async (url) => {
      if (String(url) === '/auth/passkeys') {
        return makeJsonResponse({ passkeys: [] });
      }
      if (String(url) === '/auth/mfa/setup') {
        return makeJsonResponse({ qrCodeDataUrl: 'data:image/png;base64,abc' });
      }
      return undefined as unknown as Response;
    });

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
