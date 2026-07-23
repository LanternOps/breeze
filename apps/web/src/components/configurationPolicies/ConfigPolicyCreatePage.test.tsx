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

  it('defaults to org-scoped when a concrete org is focused, and POSTs that orgId untouched', async () => {
    orgState.current = { currentOrgId: 'org-1', allOrgs: false, organizations: orgState.current.organizations };
    startNewPolicy();
    expect(screen.getByTestId('policy-owner-org')).toBeChecked();

    // Submit without touching the select — the focused org must be sent verbatim.
    fireEvent.change(screen.getByPlaceholderText('e.g. Standard Workstation Policy'), {
      target: { value: 'Acme default' },
    });
    fireEvent.click(screen.getByText('Create Policy'));

    await waitFor(() => {
      const body = postBody();
      expect(body.orgId).toBe('org-1');
      expect('ownerScope' in body).toBe(false);
    });
  });

  it('disables submit (and never POSTs) when "specific organization" is chosen but none selected', () => {
    // Partner creator in All-orgs scope: no currentOrgId to silently fall back to.
    startNewPolicy();
    fireEvent.click(screen.getByTestId('policy-owner-org'));
    fireEvent.change(screen.getByPlaceholderText('e.g. Standard Workstation Policy'), {
      target: { value: 'Nameless owner' },
    });

    expect(screen.getByText('Create Policy').closest('button')).toBeDisabled();
    expect(
      fetchMock.mock.calls.some((c) => c[0] === '/configuration-policies' && (c[1] as RequestInit)?.method === 'POST')
    ).toBe(false);
  });

  it('does not silently fall back to the focused org when the dropdown is cleared to the placeholder', () => {
    // Focused on org-1 (so ownerOrgId initializes to org-1), then user blanks the select.
    orgState.current = { currentOrgId: 'org-1', allOrgs: false, organizations: orgState.current.organizations };
    startNewPolicy();
    fireEvent.change(screen.getByTestId('policy-owner-org-select'), { target: { value: '' } });
    fireEvent.change(screen.getByPlaceholderText('e.g. Standard Workstation Policy'), {
      target: { value: 'Cleared selection' },
    });

    // The select visibly shows nothing chosen, so submit must be blocked rather
    // than silently POST org-1.
    expect(screen.getByText('Create Policy').closest('button')).toBeDisabled();
  });

  it('blocks Enter-key submit (not just the button) when no org is selected, showing an error', async () => {
    const { container } = render(<ConfigPolicyCreatePage />);
    fireEvent.click(screen.getByText('Configure New'));
    fireEvent.click(screen.getByTestId('policy-owner-org'));
    fireEvent.change(screen.getByPlaceholderText('e.g. Standard Workstation Policy'), {
      target: { value: 'Enter bypass' },
    });
    // Enter inside a field submits the form regardless of the disabled button.
    fireEvent.submit(container.querySelector('form')!);

    await waitFor(() => expect(screen.getByText(/select an organization/i)).toBeInTheDocument());
    expect(
      fetchMock.mock.calls.some((c) => c[0] === '/configuration-policies' && (c[1] as RequestInit)?.method === 'POST')
    ).toBe(false);
  });

  it('labels the partner option as a reusable library, not "all organizations"', () => {
    startNewPolicy();
    expect(screen.getByText(/Partner library/i)).toBeInTheDocument();
    expect(
      screen.getByText(/applies to no organizations until you assign it/i)
    ).toBeInTheDocument();
  });

  it('notes that backup settings are unavailable on partner-owned policies', () => {
    startNewPolicy();
    expect(screen.getByTestId('policy-owner-partner')).toBeChecked();
    expect(
      screen.getByText(/Backup settings aren.t available on partner-owned policies/i)
    ).toBeInTheDocument();
  });

  // #2609: the Policy Details fields rendered <label> with no htmlFor/id link,
  // so screen readers announced unnamed inputs and getByLabel(...) failed.
  it('associates the policy-detail labels with their inputs (a11y, #2609)', () => {
    startNewPolicy();
    expect(screen.getByLabelText('Name')).toBeInTheDocument();
    expect(screen.getByLabelText('Description')).toBeInTheDocument();
    expect(screen.getByLabelText('Status')).toBeInTheDocument();
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
