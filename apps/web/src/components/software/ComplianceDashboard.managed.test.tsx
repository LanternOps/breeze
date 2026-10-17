import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/lib/authScope', async () => {
  const actual = await vi.importActual<typeof import('@/lib/authScope')>('@/lib/authScope');
  return { ...actual, getJwtClaims: () => ({ scope: 'organization', partnerId: null, orgId: 'org-1' }) };
});
vi.mock('../../stores/orgStore', () => {
  const state = { currentOrgId: 'org-1', allOrgs: false, organizations: [] };
  return { useOrgStore: (sel?: (s: typeof state) => unknown) => (sel ? sel(state) : state) };
});

import ComplianceDashboard from './ComplianceDashboard';
import { fetchWithAuth } from '../../stores/auth';

const fetchMock = vi.mocked(fetchWithAuth);
const json = (payload: unknown): Response =>
  ({ ok: true, status: 200, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const base = { mode: 'blocklist', isActive: true, enforceMode: true, orgId: 'org-1' };
const policies = [
  { id: 'pol-manual', name: 'Manual Policy', ...base, managedByLinkId: null },
  { id: 'pol-managed', name: 'Generated Policy', ...base, managedByLinkId: 'link-1' },
];

describe('ComplianceDashboard — configuration-policy managed rows', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/software-policies/compliance/overview')) return Promise.resolve(json({ total: 0, compliant: 0, violations: 0, unknown: 0 }));
      if (url.startsWith('/software-policies/violations')) return Promise.resolve(json({ data: [] }));
      if (url.startsWith('/software-policies?')) return Promise.resolve(json({ data: policies }));
      return Promise.resolve(json({ data: [] }));
    });
  });

  it('badges generated policies and removes edit, delete and remediate for them only', async () => {
    render(<ComplianceDashboard />);
    await waitFor(() => expect(screen.getByText('Generated Policy')).toBeInTheDocument());

    const badges = screen.getAllByTestId('software-policy-managed-badge');
    expect(badges).toHaveLength(1);
    expect(badges[0]).toHaveTextContent('Managed by configuration policy');
    expect(badges[0].closest('a')).toHaveAttribute('href', '/configuration-policies');

    expect(screen.getAllByTitle('Edit')).toHaveLength(1);
    expect(screen.queryByTestId('policy-remediate-pol-managed')).not.toBeInTheDocument();
    expect(screen.getByTestId('policy-remediate-pol-manual')).toBeInTheDocument();
    expect(screen.getByTestId('policy-check-compliance-pol-managed')).toBeInTheDocument();
  });
});
