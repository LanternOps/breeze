import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import UsersPage from './UsersPage';
import { fetchWithAuth } from '../../stores/auth';

// #7034: a partner user's organization access must be editable after the
// invite, from the same Edit modal that changes the role.

vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  handleSessionExpired: vi.fn(),
  useAuthStore: (sel: (s: { user: { id: string } | null }) => unknown) => sel({ user: { id: 'me' } }),
}));
const ORG_A = { id: 'org-a-uuid', name: 'Acme Dental' };
const ORG_B = { id: 'org-b-uuid', name: 'Brightside Law' };
vi.mock('../../stores/orgStore', () => ({
  useOrgStore: (sel: (s: { organizations: unknown[] }) => unknown) => sel({ organizations: [ORG_A, ORG_B] }),
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

const ROLE_TECH = { id: 'role-tech-uuid', name: 'Partner Technician', scope: 'partner' };
const ROLE_ADMIN = { id: 'role-admin-uuid', name: 'Partner Admin', scope: 'partner' };

const TECH = {
  id: 'user-tech-uuid',
  name: 'Tessa',
  email: 'tessa@example.com',
  roleName: 'Partner Technician',
  status: 'active',
  orgAccess: 'selected',
  orgIds: [ORG_A.id],
};

function seed(userRows: Array<Record<string, unknown>>, orgAccessStatus = 200) {
  fetchMock.mockImplementation(async (url, opts) => {
    const method = (opts as RequestInit | undefined)?.method ?? 'GET';
    if (url === '/users' && method === 'GET') return jsonResponse({ data: userRows });
    if (url === '/users/roles' && method === 'GET') return jsonResponse({ data: [ROLE_TECH, ROLE_ADMIN] });
    if (typeof url === 'string' && url.endsWith('/role') && method === 'POST') {
      return jsonResponse({ success: true });
    }
    if (typeof url === 'string' && url.endsWith('/org-access') && method === 'POST') {
      return orgAccessStatus === 200
        ? jsonResponse({ success: true, changed: true })
        : jsonResponse({ error: 'One or more organizations are not part of your partner' }, orgAccessStatus);
    }
    return jsonResponse({});
  });
}

const orgAccessCalls = () =>
  fetchMock.mock.calls.filter(([url]) => typeof url === 'string' && url.endsWith('/org-access'));

async function openEdit(name: string) {
  render(<UsersPage />);
  await screen.findByText(name);
  fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
  await screen.findByLabelText(/^Role$/);
}

describe('UsersPage — edit organization access (#7034)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('grants an additional organization via POST /users/:id/org-access', async () => {
    seed([TECH]);
    await openEdit('Tessa');

    const level = screen.getByLabelText(/^Access level$/) as HTMLSelectElement;
    expect(level.value).toBe('selected');
    // The current grant is shown as a chip.
    expect(screen.getByText(ORG_A.name)).toBeInTheDocument();

    fireEvent.focus(screen.getByPlaceholderText(/search organizations/i));
    fireEvent.click(await screen.findByRole('button', { name: ORG_B.name }));
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(orgAccessCalls()).toHaveLength(1));
    const [url, opts] = orgAccessCalls()[0];
    expect(url).toBe(`/users/${TECH.id}/org-access`);
    expect((opts as RequestInit).method).toBe('POST');
    expect(JSON.parse((opts as RequestInit).body as string)).toEqual({
      orgAccess: 'selected',
      orgIds: [ORG_A.id, ORG_B.id],
    });
    // Role unchanged → no role mutation.
    expect(fetchMock.mock.calls.some(([u]) => typeof u === 'string' && u.endsWith('/role'))).toBe(false);
  });

  it("switching to 'All organizations' sends no orgIds", async () => {
    seed([TECH]);
    await openEdit('Tessa');

    fireEvent.change(screen.getByLabelText(/^Access level$/), { target: { value: 'all' } });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(orgAccessCalls()).toHaveLength(1));
    expect(JSON.parse((orgAccessCalls()[0][1] as RequestInit).body as string)).toEqual({ orgAccess: 'all' });
  });

  it('does not call the endpoint when organization access is unchanged', async () => {
    seed([TECH]);
    await openEdit('Tessa');

    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(screen.queryByLabelText(/^Role$/)).not.toBeInTheDocument());
    expect(orgAccessCalls()).toHaveLength(0);
  });

  it("refuses to save 'Specific organizations' with none selected", async () => {
    seed([{ ...TECH, orgAccess: 'none', orgIds: null }]);
    await openEdit('Tessa');

    fireEvent.change(screen.getByLabelText(/^Access level$/), { target: { value: 'selected' } });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    expect(await screen.findByText(/at least one organization/i)).toBeInTheDocument();
    expect(orgAccessCalls()).toHaveLength(0);
    expect(screen.getByLabelText(/^Role$/)).toBeInTheDocument();
  });

  it('keeps the modal open on an org-access failure and does not re-POST an already-committed role', async () => {
    seed([TECH], 403);
    await openEdit('Tessa');
    const roleCalls = () =>
      fetchMock.mock.calls.filter(([u]) => typeof u === 'string' && u.endsWith('/role'));

    fireEvent.change(screen.getByLabelText(/^Role$/), { target: { value: ROLE_ADMIN.id } });
    fireEvent.change(screen.getByLabelText(/^Access level$/), { target: { value: 'all' } });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(orgAccessCalls()).toHaveLength(1));
    expect(roleCalls()).toHaveLength(1);
    // Failure → the modal stays open for a retry.
    expect(screen.getByLabelText(/^Role$/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(orgAccessCalls()).toHaveLength(2));
    // The role already landed on the first save; the retry only re-sends org access.
    expect(roleCalls()).toHaveLength(1);
  });

  it('hides organization access for organization-scoped users (no orgAccess in payload)', async () => {
    const { orgAccess: _a, orgIds: _i, ...orgUser } = TECH;
    seed([orgUser]);
    await openEdit('Tessa');

    expect(screen.queryByLabelText(/^Access level$/)).not.toBeInTheDocument();
  });

  it('hides organization access when editing yourself (the API refuses it)', async () => {
    seed([{ ...TECH, id: 'me' }]);
    await openEdit('Tessa');

    expect(screen.queryByLabelText(/^Access level$/)).not.toBeInTheDocument();
  });
});
