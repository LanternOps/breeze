import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import UsersPage from './UsersPage';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';

vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  handleSessionExpired: vi.fn(),
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
describe('UsersPage — session timeout pointer (#6111)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seedUsersAndRoles();
  });

  it('points at the Security tab where the idle timeout is configured', async () => {
    render(<UsersPage />);
    const link = await screen.findByTestId('users-session-timeout-pointer');
    expect(link).toHaveTextContent('Session idle timeout is configured under Security');
    expect(link).toHaveAttribute('href', '/settings/partner#security');
  });
});

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

// RMM-QA-166 (D11): GET /users now reports `mfaProtected` (mfa_enabled OR a live
// passkey) per row. The page must carry that field through to UserList, or the
// passkey-only leftover this finding is about still gets no Reset MFA button.
describe('UsersPage — mfaProtected mapping from GET /users (RMM-QA-166)', () => {
  beforeEach(() => vi.clearAllMocks());

  const seedListOnly = (row: Record<string, unknown>) => {
    fetchMock.mockImplementation(async (url) => {
      if (url === '/users') return jsonResponse({ data: [row] });
      if (url === '/users/roles') return jsonResponse({ data: [ROLE_ADMIN] });
      return jsonResponse({});
    });
  };

  it('W-4: a passkey-only row (mfaEnabled=false, mfaProtected=true) gets the Reset MFA action', async () => {
    seedListOnly({ ...TREVOR, mfaEnabled: false, mfaProtected: true });
    render(<UsersPage />);
    await screen.findByText('Trevor');

    expect(await screen.findByRole('button', { name: 'Reset MFA' })).toBeInTheDocument();
  });

  it('W-5: a row with no factors (mfaEnabled=false, mfaProtected=false) gets no Reset MFA action', async () => {
    seedListOnly({ ...TREVOR, mfaEnabled: false, mfaProtected: false });
    render(<UsersPage />);
    await screen.findByText('Trevor');

    expect(screen.queryByRole('button', { name: 'Reset MFA' })).toBeNull();
  });
});

// #5690 — GET /users now reports `mfaStatus` + `mfaEnrollmentDeadline` per
// row. The page must carry both through to UserList unchanged.
describe('UsersPage — mfaStatus mapping from GET /users (#5690)', () => {
  beforeEach(() => vi.clearAllMocks());

  const seedListOnly = (row: Record<string, unknown>) => {
    fetchMock.mockImplementation(async (url) => {
      if (url === '/users') return jsonResponse({ data: [row] });
      if (url === '/users/roles') return jsonResponse({ data: [ROLE_ADMIN] });
      return jsonResponse({});
    });
  };

  it('carries mfaStatus=pending and the deadline through to the rendered column', async () => {
    seedListOnly({
      ...TREVOR,
      mfaEnabled: false,
      mfaProtected: false,
      mfaStatus: 'pending',
      mfaEnrollmentDeadline: '2026-11-15T00:00:00.000Z',
    });
    render(<UsersPage />);
    await screen.findByText('Trevor');

    const expectedDate = new Date('2026-11-15T00:00:00.000Z').toLocaleDateString();
    expect(await screen.findByText(`Pending — enroll by ${expectedDate}`)).toBeInTheDocument();
  });

  it('renders no MFA status text for a legacy payload with neither field', async () => {
    seedListOnly({ ...TREVOR, mfaEnabled: false, mfaProtected: false });
    render(<UsersPage />);
    await screen.findByText('Trevor');

    expect(screen.queryByText(/Pending|Overdue|Enrolled|Not required/)).toBeNull();
  });
});

// #3531: the remove confirmation is a fixed z-50 overlay and the page `error`
// banner renders behind it, so a failed DELETE used to be invisible.
describe('UsersPage — remove confirmation surfaces failures (#3531)', () => {
  const toastMock = vi.mocked(showToast);

  function seedRemove(status: number, payload: unknown) {
    fetchMock.mockImplementation(async (url, opts) => {
      const method = (opts as RequestInit | undefined)?.method ?? 'GET';
      if (url === '/users' && method === 'GET') return jsonResponse({ data: [TREVOR] });
      if (url === '/users/roles' && method === 'GET') return jsonResponse({ data: [ROLE_ADMIN, ROLE_TECH] });
      return jsonResponse(payload, status);
    });
  }

  const listFetches = () =>
    fetchMock.mock.calls.filter(([url, opts]) => url === '/users' && !(opts as RequestInit | undefined)?.method).length;

  async function openRemoveDialog() {
    render(<UsersPage />);
    await screen.findByText('Trevor');
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await screen.findByRole('heading', { name: 'Remove User' });
    const buttons = screen.getAllByRole('button', { name: 'Remove' });
    return buttons[buttons.length - 1];
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('remove failure: toasts, keeps the modal open, does not refetch', async () => {
    seedRemove(500, { error: 'Remove blew up' });
    const confirm = await openRemoveDialog();
    expect(listFetches()).toBe(1);

    fireEvent.click(confirm);

    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'Remove blew up' })),
    );
    expect(fetchMock).toHaveBeenCalledWith(`/users/${TREVOR.id}`, expect.objectContaining({ method: 'DELETE' }));
    expect(screen.getByRole('heading', { name: 'Remove User' })).toBeInTheDocument();
    expect(listFetches()).toBe(1);
  });

  it('remove success: refetches and closes the modal', async () => {
    seedRemove(200, { success: true });
    fireEvent.click(await openRemoveDialog());

    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Remove User' })).toBeNull());
    expect(listFetches()).toBe(2);
    expect(toastMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
    // #9950: the row vanishing used to be the only confirmation.
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', message: 'Trevor removed' }),
    );
  });
});

// #9603: Users page used its own never-dismissing toast stack; it now uses the
// shared helper (auto-dismiss) and keeps only the manual-invite-link toast sticky.
describe('UsersPage — shared toasts (#9603)', () => {
  const toastMock = vi.mocked(showToast);
  beforeEach(() => vi.clearAllMocks());

  function seedResend(body: unknown) {
    fetchMock.mockImplementation(async (url, opts) => {
      const method = (opts as RequestInit | undefined)?.method ?? 'GET';
      if (url === '/users' && method === 'GET') return jsonResponse({ data: [{ ...TREVOR, status: 'invited' }] });
      if (url === '/users/roles' && method === 'GET') return jsonResponse({ data: [ROLE_ADMIN, ROLE_TECH] });
      if (url === '/users/resend-invite') return jsonResponse(body);
      return jsonResponse({});
    });
  }

  it('resend success goes through the shared showToast (auto-dismisses)', async () => {
    seedResend({ success: true, inviteEmailSent: true });
    render(<UsersPage />);
    await screen.findByText('Trevor');
    fireEvent.click(screen.getByRole('button', { name: /resend/i }));
    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' })),
    );
    const call = toastMock.mock.calls.find(([t]) => t.type === 'success')![0];
    expect(call.duration).not.toBe(0);
  });

  it('manual-link toast is sticky and carries the link to copy', async () => {
    seedResend({ success: true, inviteEmailSent: false, inviteUrl: 'https://x.test/invite/abc' });
    render(<UsersPage />);
    await screen.findByText('Trevor');
    fireEvent.click(screen.getByRole('button', { name: /resend/i }));
    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'warning', duration: 0, copyValue: 'https://x.test/invite/abc' }),
      ),
    );
  });
});

// #10111 — Wisp links a user as `/settings/users#<userId>` (wispEntityHref),
// and that href is persisted on Wisp link rows. The page must select that
// user from the hash, and say so when the linked user is not in the list this
// viewer can see, rather than silently land on the unfiltered list.
describe('UsersPage — #<userId> hash selects the linked user (#10111)', () => {
  const DANA = {
    id: 'user-dana-uuid',
    name: 'Dana',
    email: 'dana@example.com',
    roleName: 'Partner Technician',
    status: 'active',
  };
  const scrollIntoView = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = scrollIntoView;
    fetchMock.mockImplementation(async (url) => {
      if (url === '/users') return jsonResponse({ data: [TREVOR, DANA] });
      if (url === '/users/roles') return jsonResponse({ data: [ROLE_ADMIN, ROLE_TECH] });
      return jsonResponse({});
    });
  });

  afterEach(() => {
    window.history.replaceState(null, '', '/settings/users');
  });

  it('highlights and scrolls to the user named by the hash', async () => {
    window.history.replaceState(null, '', `/settings/users#${DANA.id}`);
    render(<UsersPage />);
    await screen.findByText('Dana');

    const row = screen.getByTestId(`user-row-${DANA.id}`);
    await waitFor(() => expect(row).toHaveAttribute('aria-current', 'true'));
    expect(screen.getByTestId(`user-row-${TREVOR.id}`)).not.toHaveAttribute('aria-current');
    expect(scrollIntoView).toHaveBeenCalled();
    expect(scrollIntoView.mock.contexts[0]).toBe(row);
    expect(screen.queryByTestId('users-linked-user-missing')).not.toBeInTheDocument();
  });

  it('decodes a percent-encoded id (wispEntityHref encodes it)', async () => {
    window.history.replaceState(null, '', '/settings/users#user%2Ddana%2Duuid');
    render(<UsersPage />);
    await screen.findByText('Dana');
    await waitFor(() =>
      expect(screen.getByTestId(`user-row-${DANA.id}`)).toHaveAttribute('aria-current', 'true'),
    );
  });

  it('says so when the linked user is not in the list the viewer can see', async () => {
    window.history.replaceState(null, '', '/settings/users#user-not-visible');
    render(<UsersPage />);
    await screen.findByText('Dana');

    const notice = await screen.findByTestId('users-linked-user-missing');
    expect(notice).toHaveTextContent(/isn't in this list/i);
    expect(screen.getByTestId(`user-row-${DANA.id}`)).not.toHaveAttribute('aria-current');
    expect(screen.getByTestId(`user-row-${TREVOR.id}`)).not.toHaveAttribute('aria-current');
  });

  it('selects nothing and shows no notice without a hash', async () => {
    render(<UsersPage />);
    await screen.findByText('Dana');
    expect(screen.getByTestId(`user-row-${DANA.id}`)).not.toHaveAttribute('aria-current');
    expect(screen.queryByTestId('users-linked-user-missing')).not.toBeInTheDocument();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('follows a hash change after load (a second Wisp link clicked in place)', async () => {
    window.history.replaceState(null, '', `/settings/users#${TREVOR.id}`);
    render(<UsersPage />);
    await screen.findByText('Dana');
    await waitFor(() =>
      expect(screen.getByTestId(`user-row-${TREVOR.id}`)).toHaveAttribute('aria-current', 'true'),
    );

    window.history.replaceState(null, '', `/settings/users#${DANA.id}`);
    window.dispatchEvent(new HashChangeEvent('hashchange'));

    await waitFor(() =>
      expect(screen.getByTestId(`user-row-${DANA.id}`)).toHaveAttribute('aria-current', 'true'),
    );
    expect(screen.getByTestId(`user-row-${TREVOR.id}`)).not.toHaveAttribute('aria-current');
  });

  it('does not jump back to the linked row when a save refetches the list', async () => {
    window.history.replaceState(null, '', `/settings/users#${DANA.id}`);
    render(<UsersPage />);
    const row = await screen.findByTestId(`user-row-${DANA.id}`);
    await waitFor(() => expect(row).toHaveAttribute('aria-current', 'true'));
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    // An unchanged-role save still refetches /users (spinner remounts the list).
    fireEvent.click(within(row).getByRole('button', { name: /^edit$/i }));
    fireEvent.click(await screen.findByRole('button', { name: /save changes/i }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.filter(([url]) => url === '/users')).toHaveLength(2),
    );
    await screen.findByTestId(`user-row-${DANA.id}`);
    await waitFor(() => expect(screen.queryByLabelText(/^Role$/)).not.toBeInTheDocument());

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it('scrolls again when the same user is re-linked after the hash was cleared', async () => {
    window.history.replaceState(null, '', `/settings/users#${DANA.id}`);
    render(<UsersPage />);
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));

    window.history.replaceState(null, '', '/settings/users');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await waitFor(() =>
      expect(screen.getByTestId(`user-row-${DANA.id}`)).not.toHaveAttribute('aria-current'),
    );

    window.history.replaceState(null, '', `/settings/users#${DANA.id}`);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(2));
  });

  it('leaves the search usable after landing on a linked user', async () => {
    window.history.replaceState(null, '', `/settings/users#${DANA.id}`);
    render(<UsersPage />);
    await waitFor(() =>
      expect(screen.getByTestId(`user-row-${DANA.id}`)).toHaveAttribute('aria-current', 'true'),
    );

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'trevor' } });
    expect(screen.getByRole('searchbox')).toHaveValue('trevor');
    expect(screen.queryByTestId(`user-row-${DANA.id}`)).not.toBeInTheDocument();
    expect(screen.getByTestId(`user-row-${TREVOR.id}`)).toBeInTheDocument();
  });

  it('clears an earlier search that would hide the newly linked user', async () => {
    render(<UsersPage />);
    await screen.findByText('Dana');

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'trevor' } });
    expect(screen.queryByTestId(`user-row-${DANA.id}`)).not.toBeInTheDocument();

    window.history.replaceState(null, '', `/settings/users#${DANA.id}`);
    window.dispatchEvent(new HashChangeEvent('hashchange'));

    const row = await screen.findByTestId(`user-row-${DANA.id}`);
    expect(row).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('searchbox')).toHaveValue('');
    expect(scrollIntoView.mock.contexts.at(-1)).toBe(row);
  });
});
