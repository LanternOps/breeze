import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import RolesPage from './RolesPage';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: Object.assign(
    (selector: (s: { user: { permissions: { resource: string; action: string }[] } }) => unknown) =>
      selector({ user: { permissions: [{ resource: '*', action: '*' }] } }),
    { getState: () => ({ tokens: null }) },
  ),
}));
const navigateTo = vi.fn();
vi.mock('@/lib/navigation', () => ({ navigateTo: (...args: unknown[]) => navigateTo(...args) }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

// #3524: RolesPage sends `orgId` on create only when focused on one org. The
// mock lets each test dictate the current org scope.
const orgScopeMock = vi.fn();
vi.mock('@/hooks/useOrgScope', () => ({
  getOrgScope: () => orgScopeMock(),
  useOrgScope: () => orgScopeMock(),
}));

const fetchMock = vi.mocked(fetchWithAuth);

const json = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

describe('RolesPage — access control on the roles list', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders the access-denied state (not the retryable error) on a 403', async () => {
    fetchMock.mockImplementation(async (input: string) => {
      if (input === '/roles') return json({ error: 'forbidden' }, false, 403);
      return json({}, false, 404);
    });
    render(<RolesPage />);

    await waitFor(() => expect(screen.getByTestId('access-denied')).toBeInTheDocument());
    expect(screen.getByText('Access denied')).toBeInTheDocument();
    expect(screen.getByText("You don't have permission to manage roles.")).toBeInTheDocument();
    // A 403 must NOT offer a misleading "Try again" retry.
    expect(screen.queryByText('Try again')).not.toBeInTheDocument();
  });

  it('renders the retryable error (with Try again) on a non-403 load failure', async () => {
    fetchMock.mockImplementation(async (input: string) => {
      if (input === '/roles') return json({}, false, 500);
      return json({}, false, 404);
    });
    render(<RolesPage />);

    await waitFor(() => expect(screen.getByText('Try again')).toBeInTheDocument());
    expect(screen.queryByTestId('access-denied')).not.toBeInTheDocument();
  });

  it('renders the roles list on a successful load', async () => {
    fetchMock.mockImplementation(async (input: string) => {
      if (input === '/roles') {
        return json({ data: [{ id: 'r1', name: 'Partner Admin', description: null, scope: 'partner', isSystem: true, userCount: 1, createdAt: '2026-01-01', updatedAt: '2026-01-01' }] });
      }
      if (input === '/permissions/catalog') return json({ permissions: [], resourceLabels: {}, actionLabels: {} });
      return json({}, false, 404);
    });
    render(<RolesPage />);

    await waitFor(() => expect(screen.getByText('Partner Admin')).toBeInTheDocument());
    expect(screen.queryByTestId('access-denied')).not.toBeInTheDocument();
  });
});

describe('RolesPage — org-scoped role creation (#3524)', () => {
  beforeEach(() => vi.clearAllMocks());

  // Drives the create modal to submission and returns the JSON body POSTed to
  // /roles. The permission catalog must resolve before the submit button
  // un-disables (it gates on `catalog`).
  async function submitCreateAndCaptureBody(): Promise<Record<string, unknown>> {
    fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
      if (input === '/roles' && init?.method === 'POST') {
        return json({ id: 'new', name: 'Ops', scope: 'organization', isSystem: false, parentRoleId: null, createdAt: '2026-01-01', updatedAt: '2026-01-01' }, true, 201);
      }
      if (input === '/roles') return json({ data: [] });
      if (input === '/permissions/catalog') return json({ permissions: [], resourceLabels: {}, actionLabels: {} });
      return json({}, false, 404);
    });

    render(<RolesPage />);
    // Open the create modal (the page-level trigger).
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create Role' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Create Role' }));

    // Name it, then wait for the modal's submit button to enable (catalog loaded).
    const nameInput = await screen.findByPlaceholderText('e.g., Technician');
    fireEvent.change(nameInput, { target: { value: 'Ops' } });
    const submit = await waitFor(() => {
      const btns = screen.getAllByRole('button', { name: 'Create Role' }).filter(b => (b as HTMLButtonElement).type === 'submit');
      expect(btns[0]).toBeEnabled();
      return btns[0];
    });
    fireEvent.click(submit);

    const post = await waitFor(() => {
      const call = fetchMock.mock.calls.find(([u, i]) => u === '/roles' && (i as RequestInit | undefined)?.method === 'POST');
      expect(call).toBeTruthy();
      return call!;
    });
    return JSON.parse((post[1] as RequestInit).body as string);
  }

  it('includes orgId in the create body when focused on a single org', async () => {
    orgScopeMock.mockReturnValue({ ready: true, status: 'resolved', scope: 'org', orgId: 'org-xyz', org: null, error: null });
    const body = await submitCreateAndCaptureBody();
    expect(body.orgId).toBe('org-xyz');
  });

  it('omits orgId in fleet view (scope "all") so the API defaults to a partner-scoped role', async () => {
    orgScopeMock.mockReturnValue({ ready: true, status: 'resolved', scope: 'all', orgId: null, org: null, error: null });
    const body = await submitCreateAndCaptureBody();
    expect(body.orgId).toBeUndefined();
  });
});
