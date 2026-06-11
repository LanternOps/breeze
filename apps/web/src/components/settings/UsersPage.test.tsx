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

  it('POSTs /users/:id/role with the new roleId when the role is changed', async () => {
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
  });

  it('does NOT POST /users/:id/role when the role is unchanged (name-only edit)', async () => {
    render(<UsersPage />);
    await screen.findByText('Trevor');

    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    await screen.findByLabelText(/^Role$/);

    // Leave role at its existing value (Partner Admin, defaultValue matches).
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => {
      // PATCH /users/:id is expected (name still sent).
      const patchCalls = fetchMock.mock.calls.filter(
        (c) => typeof c[0] === 'string' && (c[0] as string) === `/users/${TREVOR.id}`,
      );
      expect(patchCalls.length).toBe(1);
    });

    const roleCalls = fetchMock.mock.calls.filter(
      (c) => typeof c[0] === 'string' && (c[0] as string).endsWith('/role'),
    );
    expect(roleCalls.length).toBe(0);
  });
});
