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

describe('ComplianceDashboard — Recent Violations spacing (#9638)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/software-policies/compliance/overview'))
        return Promise.resolve(json({ total: 1, compliant: 0, violations: 1, unknown: 0 }));
      if (url.startsWith('/software-policies/violations'))
        return Promise.resolve(
          json({
            data: [
              {
                device: { id: 'd1', hostname: 'host-1' },
                compliance: { policyId: 'p1', violations: [{ type: 'prohibited' }], lastChecked: '2026-10-22T10:00:00Z' },
              },
            ],
          }),
        );
      return Promise.resolve(json({ data: [] }));
    });
  });

  it('separates the labels from their values', async () => {
    render(<ComplianceDashboard />);
    await waitFor(() => expect(screen.getByText('host-1')).toBeInTheDocument());
    expect(screen.getByText('Remediation: none')).toBeInTheDocument();
    expect(screen.getByText(/^Checked: \S/)).toBeInTheDocument();
  });

  it.each([
    [1, '1 violation'],
    [2, '2 violations'],
  ])('renders a counted plural for %i violation(s)', async (count, label) => {
    fetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/software-policies/compliance/overview'))
        return Promise.resolve(json({ total: 1, compliant: 0, violations: 1, unknown: 0 }));
      if (url.startsWith('/software-policies/violations'))
        return Promise.resolve(
          json({
            data: [
              {
                device: { id: 'd1', hostname: 'host-1' },
                compliance: {
                  policyId: 'p1',
                  violations: Array.from({ length: count }, () => ({ type: 'prohibited' })),
                  lastChecked: '2026-10-22T10:00:00Z',
                },
              },
            ],
          }),
        );
      return Promise.resolve(json({ data: [] }));
    });
    render(<ComplianceDashboard />);
    await waitFor(() => expect(screen.getByText('host-1')).toBeInTheDocument());
    expect(screen.getByText(label)).toBeInTheDocument();
  });
});
