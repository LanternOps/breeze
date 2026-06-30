import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

// Partner scope is detected from the JWT claims (same pattern as AlertTemplateEditor —
// useOrgStore().partners is system-scope-only and empty for real partner users). The
// owner picker also reads currentOrgId/allOrgs/organizations from the org store, so the
// mock applies the selector to a mutable state object each test can override.
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

import ConfigPolicyCreatePage from './ConfigPolicyCreatePage';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';

const fetchMock = vi.mocked(fetchWithAuth);
const navMock = vi.mocked(navigateTo);
const json = (payload: unknown, ok = true): Response =>
  ({ ok, status: ok ? 200 : 400, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

function startNewPolicy() {
  render(<ConfigPolicyCreatePage />);
  // Step 1 → choose "Configure New" to reach the details form.
  fireEvent.click(screen.getByText('Configure New'));
}

function postBody(): Record<string, unknown> {
  const post = fetchMock.mock.calls.find(
    (c) => c[0] === '/configuration-policies' && (c[1] as RequestInit)?.method === 'POST'
  );
  expect(post).toBeTruthy();
  return JSON.parse((post![1] as RequestInit).body as string);
}

describe('ConfigPolicyCreatePage — owner scope (#1724)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getJwtClaimsMock.mockReturnValue({ scope: 'partner', partnerId: 'p-1', orgId: null });
    orgState.current = {
      currentOrgId: null,
      allOrgs: true,
      organizations: [{ id: 'org-1', name: 'Acme' }, { id: 'org-2', name: 'Beta' }],
    };
    fetchMock.mockResolvedValue(json({ id: 'pol-1' }, true));
  });

  it('shows the owner picker for a partner-scope creator, defaulting to partner-wide in All-orgs scope', () => {
    startNewPolicy();
    expect(screen.getByTestId('policy-owner')).toBeInTheDocument();
    expect(screen.getByTestId('policy-owner-partner')).toBeChecked();
  });

  it('POSTs a partner-wide policy (ownerScope:partner, no orgId) when partner-wide is chosen', async () => {
    startNewPolicy();
    fireEvent.change(screen.getByPlaceholderText('e.g. Standard Workstation Policy'), {
      target: { value: 'Fleet-wide PAM' },
    });
    fireEvent.click(screen.getByText('Create Policy'));

    await waitFor(() => {
      const body = postBody();
      expect(body.ownerScope).toBe('partner');
      expect('orgId' in body).toBe(false);
      expect(body.name).toBe('Fleet-wide PAM');
    });
    expect(navMock).toHaveBeenCalledWith('/configuration-policies/pol-1');
  });

  it('switches to a specific organization and sends orgId without ownerScope', async () => {
    startNewPolicy();
    fireEvent.click(screen.getByTestId('policy-owner-org'));
    fireEvent.change(screen.getByTestId('policy-owner-org-select'), { target: { value: 'org-2' } });
    fireEvent.change(screen.getByPlaceholderText('e.g. Standard Workstation Policy'), {
      target: { value: 'Acme-only policy' },
    });
    fireEvent.click(screen.getByText('Create Policy'));

    await waitFor(() => {
      const body = postBody();
      expect(body.orgId).toBe('org-2');
      expect('ownerScope' in body).toBe(false);
    });
  });

  it('defaults to org-scoped when a concrete org is selected in the scope switcher', () => {
    orgState.current = { currentOrgId: 'org-1', allOrgs: false, organizations: orgState.current.organizations };
    startNewPolicy();
    expect(screen.getByTestId('policy-owner-org')).toBeChecked();
  });

  it('hides the owner picker for an org-scope creator and POSTs orgId only', async () => {
    getJwtClaimsMock.mockReturnValue({ scope: 'organization', partnerId: null, orgId: 'org-9' });
    orgState.current = { currentOrgId: 'org-9', allOrgs: false, organizations: [] };
    startNewPolicy();
    expect(screen.queryByTestId('policy-owner')).not.toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('e.g. Standard Workstation Policy'), {
      target: { value: 'Org policy' },
    });
    fireEvent.click(screen.getByText('Create Policy'));

    await waitFor(() => {
      const body = postBody();
      expect(body.orgId).toBe('org-9');
      expect('ownerScope' in body).toBe(false);
    });
  });
});
