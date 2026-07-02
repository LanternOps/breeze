import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));

// Partner scope is detected from the JWT claims (same pattern as
// ConfigPolicyCreatePage — #1724 / #2126). The owner picker also reads
// currentOrgId/allOrgs from the org store, so the mock applies the selector
// to a mutable state object each test can override.
const { getJwtClaimsMock, orgState } = vi.hoisted(() => ({
  getJwtClaimsMock: vi.fn<() => { scope: 'system' | 'partner' | 'organization' | null; partnerId: string | null; orgId: string | null }>(
    () => ({ scope: 'partner', partnerId: 'p-1', orgId: null })
  ),
  orgState: {
    current: {
      currentOrgId: null as string | null,
      allOrgs: true,
      organizations: [{ id: 'org-1', name: 'Acme' }, { id: 'org-2', name: 'Beta' }],
    },
  },
}));
vi.mock('@/lib/authScope', async () => {
  const actual = await vi.importActual<typeof import('@/lib/authScope')>('@/lib/authScope');
  return { ...actual, getJwtClaims: getJwtClaimsMock };
});
vi.mock('../../stores/orgStore', () => ({
  useOrgStore: (sel?: (s: typeof orgState.current) => unknown) => (sel ? sel(orgState.current) : orgState.current),
}));

import ComplianceDashboard from './ComplianceDashboard';
import { fetchWithAuth } from '../../stores/auth';

const fetchMock = vi.mocked(fetchWithAuth);
const json = (payload: unknown, ok = true): Response =>
  ({ ok, status: ok ? 200 : 400, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const OVERVIEW = { total: 0, compliant: 0, violations: 0, unknown: 0 };

type SeedPolicy = {
  id: string;
  name: string;
  mode: 'allowlist' | 'blocklist' | 'audit';
  isActive: boolean;
  enforceMode: boolean;
  orgId?: string | null;
};

function mockRefreshEndpoints(policies: SeedPolicy[] = []) {
  fetchMock.mockImplementation((url: string) => {
    if (url.startsWith('/software-policies/compliance/overview')) return Promise.resolve(json(OVERVIEW));
    if (url.startsWith('/software-policies/violations')) return Promise.resolve(json({ data: [] }));
    if (url.startsWith('/software-policies?')) return Promise.resolve(json({ data: policies }));
    return Promise.resolve(json({ data: [] }));
  });
}

function postBody(): Record<string, unknown> {
  const post = fetchMock.mock.calls.find(
    (c) => c[0] === '/software-policies' && (c[1] as RequestInit)?.method === 'POST'
  );
  expect(post).toBeTruthy();
  return JSON.parse((post![1] as RequestInit).body as string);
}

function fillRequiredFields() {
  fireEvent.change(screen.getByPlaceholderText('e.g. Block Unauthorized Software'), {
    target: { value: 'Fleet-wide Policy' },
  });
  fireEvent.change(screen.getByPlaceholderText('Name *'), { target: { value: 'Chrome' } });
}

describe('ComplianceDashboard — owner scope (#2126)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getJwtClaimsMock.mockReturnValue({ scope: 'partner', partnerId: 'p-1', orgId: null });
    orgState.current = {
      currentOrgId: null,
      allOrgs: true,
      organizations: [{ id: 'org-1', name: 'Acme' }, { id: 'org-2', name: 'Beta' }],
    };
    mockRefreshEndpoints();
  });

  it('shows the owner picker for a partner-scope creator on create, defaulting to partner-wide in All-orgs scope', async () => {
    render(<ComplianceDashboard />);
    await waitFor(() => expect(screen.queryByText('Loading software policy compliance...')).not.toBeInTheDocument());

    fireEvent.click(screen.getByText('Create Policy'));

    expect(screen.getByTestId('software-policy-owner')).toBeInTheDocument();
    expect(screen.getByTestId('software-policy-owner-partner')).toBeChecked();
  });

  it('does not show the owner picker when editing an existing policy, even for partner scope', async () => {
    const existing: SeedPolicy = {
      id: 'pol-1',
      name: 'Existing Policy',
      mode: 'blocklist',
      isActive: true,
      enforceMode: false,
      orgId: 'org-1',
    };
    mockRefreshEndpoints([existing]);
    render(<ComplianceDashboard />);
    await waitFor(() => expect(screen.getByText('Existing Policy')).toBeInTheDocument());

    // handleEdit GETs /software-policies/:id — resolve with the same row.
    fetchMock.mockImplementation((url: string) => {
      if (url === '/software-policies/pol-1') return Promise.resolve(json({ data: existing }));
      if (url.startsWith('/software-policies/compliance/overview')) return Promise.resolve(json(OVERVIEW));
      if (url.startsWith('/software-policies/violations')) return Promise.resolve(json({ data: [] }));
      if (url.startsWith('/software-policies?')) return Promise.resolve(json({ data: [existing] }));
      return Promise.resolve(json({ data: [] }));
    });

    fireEvent.click(screen.getByTitle('Edit'));

    await waitFor(() => expect(screen.getByText('Edit Software Policy')).toBeInTheDocument());
    expect(screen.queryByTestId('software-policy-owner')).not.toBeInTheDocument();
  });

  it('does not show the owner picker on create for an org-scope user', async () => {
    getJwtClaimsMock.mockReturnValue({ scope: 'organization', partnerId: null, orgId: 'org-9' });
    orgState.current = { currentOrgId: 'org-9', allOrgs: false, organizations: [] };
    render(<ComplianceDashboard />);
    await waitFor(() => expect(screen.queryByText('Loading software policy compliance...')).not.toBeInTheDocument());

    fireEvent.click(screen.getByText('Create Policy'));

    expect(screen.queryByTestId('software-policy-owner')).not.toBeInTheDocument();
  });

  it('POSTs ownerScope:partner when submitting with the default partner-wide selection', async () => {
    const { container } = render(<ComplianceDashboard />);
    await waitFor(() => expect(screen.queryByText('Loading software policy compliance...')).not.toBeInTheDocument());

    fireEvent.click(screen.getByText('Create Policy'));
    fillRequiredFields();
    fireEvent.submit(container.querySelector('form')!);

    await waitFor(() => {
      const body = postBody();
      expect(body.ownerScope).toBe('partner');
      expect(body.name).toBe('Fleet-wide Policy');
    });
  });

  it('POSTs ownerScope:organization when "This organization only" is selected', async () => {
    const { container } = render(<ComplianceDashboard />);
    await waitFor(() => expect(screen.queryByText('Loading software policy compliance...')).not.toBeInTheDocument());

    fireEvent.click(screen.getByText('Create Policy'));
    fireEvent.click(screen.getByTestId('software-policy-owner-org'));
    fillRequiredFields();
    fireEvent.submit(container.querySelector('form')!);

    await waitFor(() => {
      const body = postBody();
      expect(body.ownerScope).toBe('organization');
    });
  });
});
