import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import UsersPage from './UsersPage';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: (sel: (s: { user: { id: string } | null }) => unknown) => sel({ user: { id: 'me' } }),
}));
vi.mock('../../stores/orgStore', () => ({
  useOrgStore: (sel: (s: { organizations: unknown[] }) => unknown) => sel({ organizations: [] }),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

const fetchMock = vi.mocked(fetchWithAuth);

const jsonResponse = (payload: unknown, status = 200): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    statusText: 'OK',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

const ROLE_ADMIN = { id: 'role-admin-uuid', name: 'Partner Admin', scope: 'partner' };
const ROLE_TECH = { id: 'role-tech-uuid', name: 'Partner Technician', scope: 'partner' };

const TREVOR = {
  id: 'user-trevor-uuid',
  name: 'Trevor',
  email: 'trevor@example.com',
  roleName: 'Partner Admin',
  status: 'active',
};

function seedUsersAndRoles() {
  fetchMock.mockImplementation(async (url, opts) => {
    const method = (opts as RequestInit | undefined)?.method ?? 'GET';
    if (url === '/users' && method === 'GET') {
      return jsonResponse({ data: [TREVOR] });
    }
    if (url === '/users/roles' && method === 'GET') {
      return jsonResponse({ data: [ROLE_ADMIN, ROLE_TECH] });
    }
    if (typeof url === 'string' && url.startsWith('/users/') && method === 'PATCH') {
      return jsonResponse({ success: true });
    }
    if (typeof url === 'string' && url.endsWith('/role') && method === 'POST') {
      return jsonResponse({ success: true });
    }
    return jsonResponse({});
  });
}

describe('UsersPage — handleEditSubmit role-change contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seedUsersAndRoles();
  });

  it('partner admin role edits skip global identity PATCH and POST the authorized role endpoint', async () => {
    render(<UsersPage />);
    await screen.findByText('Trevor');

    // Click Edit for Trevor (the only user).
    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    await screen.findByLabelText(/^Role$/);

    // Change role to Technician.
    fireEvent.change(screen.getByLabelText(/^Role$/), { target: { value: ROLE_TECH.id } });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => {
      const roleCalls = fetchMock.mock.calls.filter(
        (c) => typeof c[0] === 'string' && (c[0] as string).endsWith('/role'),
      );
      expect(roleCalls.length).toBe(1);
      const [url, opts] = roleCalls[0];
      expect(url).toBe(`/users/${TREVOR.id}/role`);
      expect((opts as RequestInit).method).toBe('POST');
      expect((opts as RequestInit).body).toBe(JSON.stringify({ roleId: ROLE_TECH.id }));
    });

    const identityPatchCalls = fetchMock.mock.calls.filter(
      ([url, opts]) => url === `/users/${TREVOR.id}` && (opts as RequestInit | undefined)?.method === 'PATCH',
    );
    expect(identityPatchCalls).toHaveLength(0);
  });

  it('does not call either mutation endpoint when the role is unchanged', async () => {
    render(<UsersPage />);
    await screen.findByText('Trevor');

    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    await screen.findByLabelText(/^Role$/);

    // Leave role at its existing value (Partner Admin, defaultValue matches).
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(screen.queryByLabelText(/^Role$/)).not.toBeInTheDocument());

    const roleCalls = fetchMock.mock.calls.filter(
      (c) => typeof c[0] === 'string' && (c[0] as string).endsWith('/role'),
    );
    expect(roleCalls.length).toBe(0);
    const identityPatchCalls = fetchMock.mock.calls.filter(
      ([url, opts]) => url === `/users/${TREVOR.id}` && (opts as RequestInit | undefined)?.method === 'PATCH',
    );
    expect(identityPatchCalls).toHaveLength(0);
  });
});

// #1629 follow-up: a 403 on the users list is a permission denial, not a
// transient "Failed to fetch users" error — it must render AccessDenied with
// no misleading "Try again" retry.
describe('UsersPage — 403 renders access-denied (not the retryable error)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders AccessDenied on a 403 from /users', async () => {
    fetchMock.mockImplementation(async (url) => {
      if (url === '/users') return jsonResponse({ error: 'forbidden' }, 403);
      return jsonResponse({}, 404);
    });
    render(<UsersPage />);

    await waitFor(() => expect(screen.getByTestId('access-denied')).toBeInTheDocument());
    expect(screen.getByText('Access denied')).toBeInTheDocument();
    expect(screen.getByText("You don't have permission to view users.")).toBeInTheDocument();
    // No misleading retry on a permission denial, and no "session expired" copy.
    expect(screen.queryByText('Try again')).not.toBeInTheDocument();
    expect(screen.queryByText('Failed to fetch users')).not.toBeInTheDocument();
  });

  it('renders the retryable error (with Try again) on a non-403 load failure', async () => {
    fetchMock.mockImplementation(async (url) => {
      if (url === '/users') return jsonResponse({}, 500);
      return jsonResponse({}, 404);
    });
    render(<UsersPage />);

    await waitFor(() => expect(screen.getByText('Try again')).toBeInTheDocument());
    expect(screen.queryByTestId('access-denied')).not.toBeInTheDocument();
  });
});
