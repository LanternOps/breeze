import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import RolesPage from './RolesPage';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore, type Organization } from '../../stores/orgStore';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  // orgStore registers an orgId provider at module load.
  registerOrgIdProvider: vi.fn(),
  useAuthStore: Object.assign(
    (selector: (s: { user: { permissions: { resource: string; action: string }[] } }) => unknown) =>
      selector({ user: { permissions: [{ resource: '*', action: '*' }] } }),
    { getState: () => ({ tokens: null }) },
  ),
}));
const navigateTo = vi.fn();
vi.mock('@/lib/navigation', () => ({ navigateTo: (...args: unknown[]) => navigateTo(...args) }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

// Each test dictates the current header org scope and the JWT scope.
const orgScopeMock = vi.fn(() => ({ ready: true, status: 'resolved', scope: 'all', orgId: null, org: null, error: null }) as unknown);
vi.mock('@/hooks/useOrgScope', () => ({
  getOrgScope: () => orgScopeMock(),
  useOrgScope: () => orgScopeMock(),
}));
type Claims = { scope: string; partnerId: string | null; orgId: string | null };
const jwtClaimsMock = vi.fn((): Claims => ({ scope: 'partner', partnerId: 'p-1', orgId: null }));
vi.mock('@/lib/authScope', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/authScope')>()),
  getJwtClaims: () => jwtClaimsMock(),
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

// #8370: the owner axis is an explicit choice in the Create Role dialog
// (default partner) instead of being read silently from the header org.
describe('RolesPage — explicit role scope on create (#8370)', () => {
  const orgA: Organization = { id: 'org-aaaa', partnerId: 'p-1', name: 'Acme Corp', status: 'active', createdAt: '2026-01-01T00:00:00Z' };
  const orgB: Organization = { id: 'org-bbbb', partnerId: 'p-1', name: 'Beta Inc', status: 'active', createdAt: '2026-01-01T00:00:00Z' };
  const focused = { ready: true, status: 'resolved', scope: 'org', orgId: 'org-aaaa', org: null, error: null };
  const fleet = { ready: true, status: 'resolved', scope: 'all', orgId: null, org: null, error: null };
  const role = (id: string, name: string, scope: 'partner' | 'organization') =>
    ({ id, name, description: null, scope, isSystem: false, userCount: 0, createdAt: '2026-01-01', updatedAt: '2026-01-01' });

  beforeEach(() => {
    vi.clearAllMocks();
    jwtClaimsMock.mockReturnValue({ scope: 'partner', partnerId: 'p-1', orgId: null });
    useOrgStore.setState({ currentOrgId: 'org-aaaa', allOrgs: false, organizations: [orgA, orgB], organizationsLoaded: true, error: null });
  });

  // Opens the create modal and names the role; resolves once the permission
  // catalog has loaded (the submit button gates on it).
  async function openCreate(roles: unknown[] = []) {
    fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
      if (input === '/roles' && init?.method === 'POST') {
        return json({ id: 'new', name: 'Ops', scope: 'partner', isSystem: false, parentRoleId: null, createdAt: '2026-01-01', updatedAt: '2026-01-01' }, true, 201);
      }
      if (input === '/roles') return json({ data: roles });
      if (input === '/permissions/catalog') return json({ permissions: [], resourceLabels: {}, actionLabels: {} });
      return json({}, false, 404);
    });

    render(<RolesPage />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create Role' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Create Role' }));
    const nameInput = await screen.findByPlaceholderText('e.g., Technician');
    fireEvent.change(nameInput, { target: { value: 'Ops' } });
    await waitFor(() => expect(screen.queryByText('Loading permissions...')).not.toBeInTheDocument());
  }

  const submitButton = () =>
    screen.getAllByRole('button', { name: 'Create Role' }).find((b) => (b as HTMLButtonElement).type === 'submit')!;

  async function submitAndCaptureBody(): Promise<Record<string, unknown>> {
    await waitFor(() => expect(submitButton()).toBeEnabled());
    fireEvent.click(submitButton());
    const post = await waitFor(() => {
      const call = fetchMock.mock.calls.find(([u, i]) => u === '/roles' && (i as RequestInit | undefined)?.method === 'POST');
      expect(call).toBeTruthy();
      return call!;
    });
    return JSON.parse((post[1] as RequestInit).body as string);
  }

  it('defaults to a partner role even with an org selected in the header', async () => {
    orgScopeMock.mockReturnValue(focused);
    await openCreate();

    expect(screen.getByTestId('role-owner-partner')).toBeChecked();
    const body = await submitAndCaptureBody();
    expect(body.ownerScope).toBe('partner');
    expect(body).not.toHaveProperty('orgId');
  });

  it('creates an org role for the header org when Organization is chosen, naming the org', async () => {
    orgScopeMock.mockReturnValue(focused);
    await openCreate();

    fireEvent.click(screen.getByTestId('role-owner-org'));
    expect(screen.queryByTestId('role-owner-org-picker')).toBeNull();
    expect(screen.getByTestId('role-owner-org-name')).toHaveTextContent('Acme Corp');
    const body = await submitAndCaptureBody();
    expect(body).toMatchObject({ ownerScope: 'organization', orgId: 'org-aaaa' });
  });

  it('in the All-organizations view, requires picking the org before an org role can be created', async () => {
    orgScopeMock.mockReturnValue(fleet);
    useOrgStore.setState({ currentOrgId: null, allOrgs: true });
    await openCreate();

    expect(screen.queryByTestId('role-owner-org-picker')).toBeNull();
    fireEvent.click(screen.getByTestId('role-owner-org'));
    const picker = screen.getByTestId('role-owner-org-picker') as HTMLSelectElement;
    expect(submitButton()).toBeDisabled();

    fireEvent.change(picker, { target: { value: 'org-bbbb' } });
    const body = await submitAndCaptureBody();
    expect(body).toMatchObject({ ownerScope: 'organization', orgId: 'org-bbbb' });
  });

  it('offers only parent roles on the chosen axis', async () => {
    orgScopeMock.mockReturnValue(focused);
    await openCreate([role('pr-1', 'Partner Tech', 'partner'), role('or-1', 'Org Tech', 'organization')]);

    const parentOptions = () =>
      Array.from((screen.getByLabelText('Inherit From (Parent Role)') as HTMLSelectElement).options).map((o) => o.textContent);
    expect(parentOptions()).toContain('Partner Tech');
    expect(parentOptions()).not.toContain('Org Tech');

    fireEvent.click(screen.getByTestId('role-owner-org'));
    expect(parentOptions()).toContain('Org Tech');
    expect(parentOptions()).not.toContain('Partner Tech');
  });

  it('shows no scope selector to an organization-scope user and sends no owner fields', async () => {
    jwtClaimsMock.mockReturnValue({ scope: 'organization', partnerId: null, orgId: 'org-aaaa' });
    orgScopeMock.mockReturnValue(focused);
    await openCreate();

    expect(screen.queryByTestId('role-owner')).toBeNull();
    const body = await submitAndCaptureBody();
    expect(body).not.toHaveProperty('ownerScope');
    expect(body).not.toHaveProperty('orgId');
  });
});
