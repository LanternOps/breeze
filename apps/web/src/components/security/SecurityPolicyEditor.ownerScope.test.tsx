import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));

// Partner scope is detected from the JWT claims (same pattern as
// ConfigPolicyCreatePage — #1724 / #2127). The owner picker also reads
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

import SecurityPolicyEditor from './SecurityPolicyEditor';
import { fetchWithAuth } from '../../stores/auth';

const fetchMock = vi.mocked(fetchWithAuth);
const json = (payload: unknown, ok = true): Response =>
  ({ ok, status: ok ? 200 : 400, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const EXISTING_POLICY = {
  id: 'existing-id',
  name: 'Baseline AV',
  description: 'Standard baseline',
  realTimeProtection: true,
  autoQuarantine: true,
  exclusions: [] as string[],
  scanSchedule: 'daily' as const,
};

function postOrPutBody(method: 'POST' | 'PUT', url: string): Record<string, unknown> {
  const call = fetchMock.mock.calls.find(
    (c) => c[0] === url && (c[1] as RequestInit)?.method === method
  );
  expect(call).toBeTruthy();
  return JSON.parse((call![1] as RequestInit).body as string);
}

describe('SecurityPolicyEditor — owner scope (#2127)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getJwtClaimsMock.mockReturnValue({ scope: 'partner', partnerId: 'p-1', orgId: null });
    orgState.current = {
      currentOrgId: null,
      allOrgs: true,
      organizations: [{ id: 'org-1', name: 'Acme' }, { id: 'org-2', name: 'Beta' }],
    };
    fetchMock.mockResolvedValue(json({ data: EXISTING_POLICY }, true));
  });

  it('shows the owner picker on create for a partner-scope user, defaulting to partner-wide in All-orgs scope', () => {
    render(<SecurityPolicyEditor />);
    expect(screen.getByTestId('security-policy-owner')).toBeInTheDocument();
    expect(screen.getByTestId('security-policy-owner-partner')).toBeChecked();
  });

  it('does not show the owner picker when editing an existing policy, even for partner scope', async () => {
    render(<SecurityPolicyEditor policyId="existing-id" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/security/policies'));
    expect(screen.queryByTestId('security-policy-owner')).not.toBeInTheDocument();
  });

  it('does not show the owner picker on create for an org-scope user', () => {
    getJwtClaimsMock.mockReturnValue({ scope: 'organization', partnerId: null, orgId: 'org-9' });
    orgState.current = { currentOrgId: 'org-9', allOrgs: false, organizations: [] };
    render(<SecurityPolicyEditor />);
    expect(screen.queryByTestId('security-policy-owner')).not.toBeInTheDocument();
  });

  it('POSTs ownerScope:partner when saving with the default partner-wide selection', async () => {
    render(<SecurityPolicyEditor />);
    fireEvent.click(screen.getByText('Save policy'));

    await waitFor(() => {
      const body = postOrPutBody('POST', '/security/policies');
      expect(body.ownerScope).toBe('partner');
    });
  });

  it('omits ownerScope entirely for an org-scope create', async () => {
    getJwtClaimsMock.mockReturnValue({ scope: 'organization', partnerId: null, orgId: 'org-9' });
    orgState.current = { currentOrgId: 'org-9', allOrgs: false, organizations: [] };
    render(<SecurityPolicyEditor />);
    fireEvent.click(screen.getByText('Save policy'));

    await waitFor(() => {
      const body = postOrPutBody('POST', '/security/policies');
      expect('ownerScope' in body).toBe(false);
    });
  });
});
